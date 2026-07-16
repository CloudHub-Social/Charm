//! Room organization: favourite/low-priority tags, mute, mark-unread, manual
//! ordering, and the single `has_unread` invariant every unread indicator in
//! the UI reads from (computed once here, in [`snapshot_rooms`] via
//! [`has_unread`], never re-derived per-component — see Spec 06).

use matrix_sdk::latest_events::LatestEventValue;
use matrix_sdk::notification_settings::RoomNotificationMode;
use matrix_sdk::room::Room;
use matrix_sdk::ruma::events::room::message::MessageType;
use matrix_sdk::ruma::events::tag::{TagInfo, TagName, UserTagName};
use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncTimelineEvent};
use matrix_sdk::{Client, RoomState};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use tauri::{AppHandle, Manager, State};
use ts_rs::TS;

use super::notifications::set_room_notification_mode;
use super::timeline::message_type_preview_text;
use super::{media, profiles, MatrixState};

/// Truncation cap for [`LastMessagePreview::text`], applied in `char`s (not
/// bytes) so multi-byte UTF-8 sequences never get split mid-codepoint. Chosen
/// to comfortably fit a couple of lines of preview text in the room-list row
/// without letting a very long message dominate it; matches the ballpark of
/// `shell::build_notification`'s own `MAX_BODY_CHARS` notification-body cap.
const LAST_MESSAGE_PREVIEW_MAX_CHARS: usize = 100;

/// A compact last-message preview for a room-list row (Spec 54): the
/// sender's user id (always present) and resolved display name (best
/// effort), plus a truncated text snippet. `None` on [`RoomSummary`] when the
/// room has no known latest event yet, the latest event isn't a plain
/// (decrypted, non-redacted) `m.room.message`, or it's a pending invite —
/// callers fall back to showing just the room name, same as before this
/// field existed.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct LastMessagePreview {
    pub sender_id: String,
    pub sender_display_name: Option<String>,
    /// Already truncated to [`LAST_MESSAGE_PREVIEW_MAX_CHARS`] chars (with a
    /// trailing `…` when truncated) — the frontend still applies CSS
    /// `truncate` for narrow layouts, but doesn't need to bound the length
    /// itself.
    pub text: String,
}

/// Truncates `text` to at most `max_chars` `char`s, appending `…` when it had
/// to cut something — mirrors `shell::build_notification`'s truncation
/// behavior so previews and notifications read consistently.
fn truncate_preview(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max_chars).collect();
    truncated.push('…');
    truncated
}

/// Extracts a `(sender, preview text)` pair from a raw sync timeline event,
/// if it's a non-redacted `m.room.message` — mirrors
/// `push::message_preview`'s shape, but summarizes non-text msgtypes via
/// [`message_type_preview_text`] instead of using the raw (often
/// filename-only) `body()`, since this preview is read standalone rather
/// than alongside a media attachment already rendered in a notification.
fn room_message_preview_from_raw(
    raw: &matrix_sdk::ruma::serde::Raw<AnySyncTimelineEvent>,
) -> Option<(String, String)> {
    let event = raw.deserialize().ok()?;
    let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
        matrix_sdk::ruma::events::SyncMessageLikeEvent::Original(original),
    )) = event
    else {
        return None;
    };
    if matches!(
        original.content.msgtype,
        MessageType::VerificationRequest(_)
    ) {
        return None;
    }
    Some((
        original.sender.to_string(),
        message_type_preview_text(&original.content.msgtype),
    ))
}

/// Computes [`RoomSummary::last_message_preview`] for `room` via
/// `matrix-sdk`'s [`LatestEvents`](matrix_sdk::latest_events::LatestEvents)
/// tracker — the SDK's own mechanism for exactly this "last message in a
/// room-list row" use case (see its module doc comment). Registering a room
/// with `listen_and_subscribe_to_room` is idempotent and lazy: once
/// registered, the tracker keeps the value current off the same event-cache
/// updates the ongoing sync loop already produces, so repeated calls (every
/// `snapshot_rooms` run, including the periodic background one) are cheap
/// reads rather than new per-room fetches — see Spec 54's trade-off on
/// keeping this in the summary instead of a separate per-room request.
///
/// Only [`LatestEventValue::Remote`] (a synced, plain-text-extractable
/// message) yields a preview today; a pending invite, a still-sending local
/// echo, or "nothing computed yet" all yield `None` and the row falls back to
/// showing just the room name.
async fn last_message_preview(client: &Client, room: &Room) -> Option<LastMessagePreview> {
    // Cheap/idempotent: only actually subscribes to sync updates once per
    // client, regardless of how many times `snapshot_rooms` calls this.
    let _ = client.event_cache().subscribe();

    let room_id = room.room_id();
    let latest_events = client.latest_events().await;
    let subscriber = latest_events
        .listen_and_subscribe_to_room(room_id)
        .await
        .ok()??;
    let value = subscriber.get().await;
    let LatestEventValue::Remote(timeline_event) = value else {
        return None;
    };
    let (sender_id, text) = room_message_preview_from_raw(timeline_event.raw())?;
    let sender_display_name = match matrix_sdk::ruma::UserId::parse(sender_id.as_str()) {
        Ok(user_id) => room
            .get_member_no_sync(&user_id)
            .await
            .ok()
            .flatten()
            .and_then(|member| member.display_name().map(ToOwned::to_owned)),
        Err(_) => None,
    };

    Some(LastMessagePreview {
        sender_id,
        sender_display_name,
        text: truncate_preview(&text, LAST_MESSAGE_PREVIEW_MAX_CHARS),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../src/bindings/")]
pub enum RoomMembershipKind {
    Join,
    Invite,
}

/// Flat room summary for the room list. No message preview yet — that needs
/// the timeline/event-cache API, which is Phase 1 timeline-rendering scope,
/// not this first sync-wiring cut.
///
/// `has_unread` is the single authoritative "needs attention" signal (see
/// [`has_unread`]) — computed once here, in [`snapshot_rooms`]; every UI
/// unread indicator reads this field rather than re-deriving it from
/// `unread_count`/`unread_messages`/`is_marked_unread` itself.
///
/// `list_rooms`/`room_list:update` pre-sort pending invites first, followed by
/// joined rooms ordered by (section, `manual_order`, name) in
/// [`snapshot_rooms`] — the frontend performs no sorting.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomSummary {
    pub room_id: String,
    pub name: Option<String>,
    // u64 serializes to a JS-safe integer here (notification counts are small); emit
    // `number` rather than ts-rs's default `bigint` so the frontend can use it directly.
    #[ts(type = "number")]
    pub unread_count: u64,
    /// `room.num_unread_messages()` — ambient unread, distinct from
    /// `unread_count` (notifications/mentions).
    #[ts(type = "number")]
    pub unread_messages: u64,
    /// The MSC2867 `m.marked_unread` flag (`room.is_marked_unread()`).
    pub is_marked_unread: bool,
    /// True when the user-defined-or-default notification mode for this
    /// room is `Mute`. Kept alongside `notification_mode` below for the
    /// existing `has_unread`/room-list consumers that only ever needed the
    /// muted/not-muted distinction.
    pub is_muted: bool,
    /// The room's effective notification mode (user-defined override, or the
    /// account default if none is set) — distinguishes `AllMessages` from
    /// `MentionsAndKeywordsOnly`, which `is_muted` alone can't (both read as
    /// "not muted" there). `None` only if the client couldn't resolve a mode
    /// at all (e.g. room not yet fully synced). The settings Notifications
    /// panel's per-room picker reads this rather than reconstructing a mode
    /// from `is_muted`.
    pub notification_mode: Option<super::notifications::RoomNotificationModeKind>,
    /// `m.favourite` tag present.
    pub is_favourite: bool,
    /// `m.lowpriority` tag present.
    pub is_low_priority: bool,
    /// `TagInfo.order` for whichever tag currently governs this room's
    /// section — see [`order_tag_name`]. `None` sorts last within its
    /// section.
    pub manual_order: Option<f64>,
    /// `room.room_type() == Some(RoomType::Space)`.
    pub is_space: bool,
    /// Space room ids whose `m.space.child` state references this room.
    pub parent_space_ids: Vec<String>,
    /// `room.is_direct()` (DM grouping).
    pub is_direct: bool,
    /// The single "does this room need attention" signal — see
    /// [`has_unread`]. Every unread indicator in the UI reads this, not the
    /// raw counts above.
    pub has_unread: bool,
    /// The room's own avatar mxc, when `m.room.avatar` is set — otherwise,
    /// for an unnamed direct room, the single peer's avatar (from
    /// `Room::heroes()`). `None` means render the initials fallback; see
    /// [`resolve_room_identity`].
    pub avatar_url: Option<String>,
    /// `avatar_url` resolved to a local thumbnail path via Spec 02's media
    /// cache, or `None` if unresolved (no cache yet, no avatar, or the fetch
    /// failed) — the frontend falls back to initials in that case.
    pub avatar_path: Option<String>,
    /// For a direct room with exactly one other member, that member's user
    /// id — lets the frontend key a presence lookup (`usePresence`) off the
    /// DM peer rather than the room. `None` for group rooms and for direct
    /// rooms matrix-rust-sdk can't resolve a single hero for (e.g. the peer
    /// hasn't been synced yet).
    pub dm_peer_user_id: Option<String>,
    /// Whether this is a normal joined room or a pending invitation. Left,
    /// knocked, and banned rooms are deliberately excluded from snapshots.
    pub membership: RoomMembershipKind,
    /// The user who sent a pending invitation. `None` for joined rooms or
    /// when a malformed/incomplete invite omitted its membership event.
    pub inviter_user_id: Option<String>,
    pub inviter_display_name: Option<String>,
    /// Spec 54 room-list row enrichment: a compact sender + text snippet for
    /// the room's most recent message, or `None` when none is available yet
    /// — see [`last_message_preview`].
    pub last_message_preview: Option<LastMessagePreview>,
}

/// The tag a room's manual order lives on: whichever section tag is
/// currently set (Favourite/LowPriority), or a dedicated user tag for rooms
/// with no section tag at all (the plain "Rooms" section) — so drag-reorder
/// persists everywhere, not just in the two special sections.
pub(crate) fn order_tag_name(is_favourite: bool, is_low_priority: bool) -> TagName {
    if is_favourite {
        TagName::Favorite
    } else if is_low_priority {
        TagName::LowPriority
    } else {
        TagName::User(UserTagName::from_str("u.order").expect("valid user tag name"))
    }
}

fn parse_room(client: &Client, room_id: &str) -> Result<Room, String> {
    let parsed_room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| e.to_string())?;
    client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))
}

/// Builds a room-id -> parent-space-ids map by reading every space room's
/// `m.space.child` state — the reciprocal `m.space.parent` on the child is
/// unreliable (rooms aren't required to set it, and it can claim a parent
/// that never actually listed them), so parenthood here is defined by the
/// space's own child list, matching the client-side "which space's children
/// include this room" semantics `RoomList.tsx` groups by.
async fn parent_space_ids(client: &Client) -> std::collections::HashMap<String, Vec<String>> {
    use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;

    let mut parents: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for room in client.joined_space_rooms() {
        if !room.is_space() {
            continue;
        }
        let space_id = room.room_id().to_string();
        let Ok(child_events) = room
            .get_state_events_static::<SpaceChildEventContent>()
            .await
        else {
            continue;
        };
        for raw_event in child_events {
            let Ok(event) = raw_event.deserialize() else {
                continue;
            };
            parents
                .entry(event.state_key().to_string())
                .or_default()
                .push(space_id.clone());
        }
    }
    parents
}

/// Sort key for the room list: section (Favourite -> Rooms -> Low priority),
/// then `manual_order` ascending (`None` last), then alphabetical by
/// display name — see Spec 06 "Ordering strategy". Computed once here so
/// `RoomList.tsx` performs no sorting of its own.
fn section_rank(is_favourite: bool, is_low_priority: bool) -> u8 {
    if is_favourite {
        0
    } else if is_low_priority {
        2
    } else {
        1
    }
}

/// Pending invites form their own room-list section ahead of joined rooms.
/// Keep that grouping in the backend sort contract even though today's
/// `RoomList` filters memberships before rendering each section.
fn membership_rank(membership: RoomMembershipKind) -> u8 {
    match membership {
        RoomMembershipKind::Invite => 0,
        RoomMembershipKind::Join => 1,
    }
}

/// A room's resolved display identity: its name (via the SDK's spec-mandated
/// naming algorithm, not just raw `m.room.name` state), and — for a direct
/// room with no avatar of its own — the single other member's avatar and
/// user id, so the room list/header can show that peer's identity instead of
/// initials. See [`resolve_room_identity`].
struct RoomIdentity {
    name: Option<String>,
    avatar_url: Option<String>,
    avatar_path: Option<String>,
    dm_peer_user_id: Option<String>,
}

/// Resolves a room's display name and avatar. The name uses matrix-rust-sdk's
/// own spec-mandated [naming algorithm][spec] (`Room::cached_display_name()`,
/// falling back to the async `Room::display_name()` on a cache miss) rather
/// than the raw `m.room.name` state alone — that raw value is `None` for a
/// room named by canonical alias, an unnamed 1:1 room not marked direct, or a
/// group room whose name is computed from its heroes, and this identity path
/// feeds every `list_rooms`/`room_list:update`, so falling straight back to
/// the room id in those common cases would leave the room list showing raw
/// `!roomid`s instead of the name a user would actually recognize.
///
/// `Room::heroes()` is separately used below for the room's avatar/DM-peer
/// fallback — it's the same synced, cached data the naming algorithm itself
/// reads, so this needs no separate member-profile fetch (see `profiles.rs`'s
/// module doc comment for why a bespoke member cache would be redundant
/// here). Only treats the room as having a resolvable DM peer when
/// `heroes()` returns exactly one entry: a direct room that gained a
/// second/third participant, or one with inconsistent `m.direct` account
/// data, can have more than one hero, and picking an arbitrary one of them
/// would show that member's presence/identity as if they were *the* peer —
/// see Spec 01 review discussion on `dm_peer_user_id`'s contract (exactly
/// one other member, not "at least one").
///
/// [spec]: <https://spec.matrix.org/latest/client-server-api/#calculating-the-display-name-for-a-room>
async fn resolve_room_identity(
    client: &Client,
    media_cache: Option<&media::MediaCache>,
    room: &Room,
    is_direct: bool,
) -> RoomIdentity {
    let display_name = match room.cached_display_name() {
        Some(name) => name,
        None => room
            .display_name()
            .await
            .unwrap_or(matrix_sdk::RoomDisplayName::Empty),
    };
    // `Empty` means the algorithm found nothing useful at all (no name, no
    // alias, no other members ever) — `None` here so the frontend's
    // room-id/initials fallback kicks in, same as before this room had any
    // resolvable identity. Every other variant (including `EmptyWas`, whose
    // `Display` impl already renders a friendly "Empty Room (was X)" string)
    // is a real name worth showing.
    let name = match display_name {
        matrix_sdk::RoomDisplayName::Empty => None,
        other => Some(other.to_string()),
    };

    let raw_avatar_url = room.avatar_url();

    let dm_peer = is_direct
        .then(|| room.heroes())
        .and_then(|heroes| match heroes.as_slice() {
            [hero] => Some(hero.clone()),
            _ => None,
        });

    let avatar_url = raw_avatar_url.map(|url| url.to_string()).or_else(|| {
        dm_peer
            .as_ref()
            .and_then(|hero| hero.avatar_url.clone())
            .map(|url| url.to_string())
    });

    let avatar_path = match &avatar_url {
        Some(mxc) => profiles::resolve_avatar_path(client, media_cache, mxc).await,
        None => None,
    };

    RoomIdentity {
        name,
        avatar_url,
        avatar_path,
        dm_peer_user_id: dm_peer.map(|hero| hero.user_id.to_string()),
    }
}

/// Snapshots the client's in-memory room list into sorted [`RoomSummary`]s —
/// shared by [`list_rooms`] and every iteration of the background sync loop
/// (`sync::spawn_sync_loop`), which emits the result as `room_list:update`.
/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/`, same rationale as [`resolve_alias`]/[`discover`].
pub async fn snapshot_rooms(
    client: &Client,
    media_cache: Option<&media::MediaCache>,
    include_message_preview: bool,
) -> Vec<RoomSummary> {
    let parents = parent_space_ids(client).await;

    let mut summaries = Vec::new();
    let rooms = client
        .joined_rooms()
        .into_iter()
        .chain(client.invited_rooms());
    for room in rooms {
        let membership = match room.state() {
            RoomState::Joined => RoomMembershipKind::Join,
            RoomState::Invited => RoomMembershipKind::Invite,
            _ => continue,
        };
        let room_id = room.room_id().to_string();
        let unread_count = room.unread_notification_counts().notification_count;
        let unread_messages = room.num_unread_messages();
        let is_marked_unread = room.is_marked_unread();
        let is_favourite = room.is_favourite();
        let is_low_priority = room.is_low_priority();
        let room_notification_mode = room.notification_mode().await;
        let is_muted = matches!(
            room_notification_mode,
            Some(matrix_sdk::notification_settings::RoomNotificationMode::Mute)
        );
        let manual_order = room.tags().await.ok().flatten().and_then(|tags| {
            let tag = order_tag_name(is_favourite, is_low_priority);
            tags.get(&tag).and_then(|info| info.order)
        });
        let is_space = room.is_space();
        let is_direct = room.is_direct().await.unwrap_or(false);
        let has_unread_flag = has_unread(is_marked_unread, is_muted, unread_messages, unread_count);
        let identity = resolve_room_identity(client, media_cache, &room, is_direct).await;
        let (inviter_user_id, inviter_display_name) = if membership == RoomMembershipKind::Invite {
            match room.invite_details().await {
                Ok(details) => (
                    Some(details.inviter_id.to_string()),
                    details
                        .inviter
                        .and_then(|member| member.display_name().map(ToOwned::to_owned)),
                ),
                Err(_) => (None, None),
            }
        } else {
            (None, None)
        };
        // Pending invites have no readable message history to preview yet.
        // Skip the `LatestEvents` subscription + member lookup entirely when
        // the feature is off, rather than computing a value the frontend
        // will just discard.
        let last_message_preview =
            if include_message_preview && membership == RoomMembershipKind::Join {
                last_message_preview(client, &room).await
            } else {
                None
            };

        summaries.push((
            membership_rank(membership),
            section_rank(is_favourite, is_low_priority),
            manual_order,
            identity.name.clone().unwrap_or_default(),
            RoomSummary {
                room_id: room_id.clone(),
                name: identity.name,
                unread_count,
                unread_messages,
                is_marked_unread,
                is_muted,
                notification_mode: room_notification_mode.map(Into::into),
                is_favourite,
                is_low_priority,
                manual_order,
                is_space,
                parent_space_ids: parents.get(&room_id).cloned().unwrap_or_default(),
                is_direct,
                has_unread: has_unread_flag,
                avatar_url: identity.avatar_url,
                avatar_path: identity.avatar_path,
                dm_peer_user_id: identity.dm_peer_user_id,
                membership,
                inviter_user_id,
                inviter_display_name,
                last_message_preview,
            },
        ));
    }

    summaries.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| match (a.2, b.2) {
                (Some(a_order), Some(b_order)) => a_order.total_cmp(&b_order),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.3.cmp(&b.3))
    });

    summaries
        .into_iter()
        .map(|(_, _, _, _, summary)| summary)
        .collect()
}

pub async fn accept_invite_impl(client: &Client, room_id: &str) -> Result<(), String> {
    let room = parse_room(client, room_id)?;
    if room.state() != RoomState::Invited {
        return Err(format!("room {room_id} is not a pending invite"));
    }
    room.join().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn accept_invite(state: State<'_, MatrixState>, room_id: String) -> Result<(), String> {
    let client = state.require_client().await?;
    accept_invite_impl(&client, &room_id).await
}

pub async fn decline_invite_impl(client: &Client, room_id: &str) -> Result<(), String> {
    let room = parse_room(client, room_id)?;
    if room.state() != RoomState::Invited {
        return Err(format!("room {room_id} is not a pending invite"));
    }
    room.leave().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn decline_invite(state: State<'_, MatrixState>, room_id: String) -> Result<(), String> {
    let client = state.require_client().await?;
    decline_invite_impl(&client, &room_id).await
}

/// Reads the current room list out of the client's in-memory store —
/// no network round-trip, just whatever the last sync populated.
#[tauri::command]
pub async fn list_rooms(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<Vec<RoomSummary>, String> {
    let client = state.require_client().await?;
    let media_cache = state.require_media_cache(&app).await.ok();
    let include_message_preview = app.path().app_data_dir().is_ok_and(|dir| {
        crate::feature_flags::flag(
            &dir,
            crate::feature_flags::FeatureFlagKey::RoomListMessagePreview,
        )
    });
    Ok(snapshot_rooms(&client, media_cache, include_message_preview).await)
}

/// Resolves a room alias (e.g. `#general:localhost`) to its room id, so
/// `matrix.to` alias links can be matched against `RoomSummary.room_id`. This
/// does hit the network — aliases aren't part of the local sync state.
#[tauri::command]
pub async fn resolve_room_alias(
    state: State<'_, MatrixState>,
    alias: String,
) -> Result<String, String> {
    let client = state.require_client().await?;
    resolve_alias(&client, &alias).await
}

/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/alias_resolution.rs` rather than the `--lib` unit-test target CI runs
/// without a local Synapse available.
pub async fn resolve_alias(client: &Client, alias: &str) -> Result<String, String> {
    let room_alias = matrix_sdk::ruma::RoomAliasId::parse(alias).map_err(|e| e.to_string())?;
    let response = client
        .resolve_room_alias(&room_alias)
        .await
        .map_err(|e| e.to_string())?;
    Ok(response.room_id.to_string())
}

/// Reads the `TagInfo.order` currently governing `room`'s section (see
/// [`order_tag_name`]), so a favourite/low-priority toggle can carry it over
/// to the room's new section tag instead of losing the user's manual
/// ordering — see [`set_room_favourite`]/[`set_room_low_priority`].
async fn current_manual_order(room: &Room) -> Option<f64> {
    let tag = order_tag_name(room.is_favourite(), room.is_low_priority());
    room.tags()
        .await
        .ok()
        .flatten()
        .and_then(|tags| tags.get(&tag).and_then(|info| info.order))
}

/// Writes `order` onto `target_tag` if it's `Some` — used to carry a room's
/// manual order onto its new section tag when [`Room::set_is_favourite`]/
/// [`Room::set_is_low_priority`] don't do it for us (they only accept an
/// order for the tag being *added*, not the one left behind when a room is
/// un-favourited/un-low-priorited back into the plain "Rooms" section).
async fn migrate_manual_order(
    room: &Room,
    target_tag: TagName,
    order: Option<f64>,
) -> Result<(), String> {
    let Some(order) = order else {
        return Ok(());
    };
    let mut tag_info = TagInfo::new();
    tag_info.order = Some(order);
    room.set_tag(target_tag, tag_info)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The single authoritative "does this room need attention" signal.
///
/// Muted rooms with only ambient unread messages don't count — an explicit
/// mark-unread flag or a real notification (e.g. a mention, which still
/// generates a notification-count even in a muted room) always does.
pub fn has_unread(
    is_marked_unread: bool,
    is_muted: bool,
    unread_messages: u64,
    unread_count: u64,
) -> bool {
    is_marked_unread || (!is_muted && unread_messages > 0) || unread_count > 0
}

/// Moving a room into/out of Favourites carries its manual order over to
/// whichever tag now governs its section, rather than losing it: dropping
/// straight to `None` would strand a carefully-dragged position the moment a
/// room is favourited or un-favourited (see [`current_manual_order`]).
#[tauri::command]
pub async fn set_room_favourite(
    state: State<'_, MatrixState>,
    room_id: String,
    favourite: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_favourite_impl(&client, &room_id, favourite).await
}

/// Core logic behind [`set_room_favourite`].
pub async fn set_room_favourite_impl(
    client: &Client,
    room_id: &str,
    favourite: bool,
) -> Result<(), String> {
    let room = parse_room(client, room_id)?;
    let migrated_order = current_manual_order(&room).await;

    if favourite {
        room.set_is_favourite(true, migrated_order)
            .await
            .map_err(|e| e.to_string())
    } else {
        room.set_is_favourite(false, None)
            .await
            .map_err(|e| e.to_string())?;
        let target = order_tag_name(false, room.is_low_priority());
        migrate_manual_order(&room, target, migrated_order).await
    }
}

/// Same manual-order carry-over as [`set_room_favourite`], for the
/// Low-priority section.
#[tauri::command]
pub async fn set_room_low_priority(
    state: State<'_, MatrixState>,
    room_id: String,
    low_priority: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_low_priority_impl(&client, &room_id, low_priority).await
}

/// Core logic behind [`set_room_low_priority`].
pub async fn set_room_low_priority_impl(
    client: &Client,
    room_id: &str,
    low_priority: bool,
) -> Result<(), String> {
    let room = parse_room(client, room_id)?;
    let migrated_order = current_manual_order(&room).await;

    if low_priority {
        room.set_is_low_priority(true, migrated_order)
            .await
            .map_err(|e| e.to_string())
    } else {
        room.set_is_low_priority(false, None)
            .await
            .map_err(|e| e.to_string())?;
        let target = order_tag_name(room.is_favourite(), false);
        migrate_manual_order(&room, target, migrated_order).await
    }
}

/// Spec 06's room-list "Mute"/"Unmute" context-menu action — a different UI
/// surface from the settings Notifications panel's per-room picker
/// (`notifications::set_room_notification_mode`), but writing the same
/// underlying push rule, so it delegates there rather than calling
/// `NotificationSettings::set_room_notification_mode` directly: without
/// that, this action had no idea about `muted_from_mode`/
/// `muted_room_overrides`, so muting/unmuting a room from here while global
/// mute was active would desync the room from the restore snapshot — e.g.
/// "Unmute" here writes an explicit override that undoes the room's part of
/// "Mute all rooms" without ever recording it, so turning global mute back
/// off later wouldn't know to leave (or restore) this room correctly.
#[tauri::command]
pub async fn set_room_muted(
    app: AppHandle,
    state: State<'_, MatrixState>,
    room_id: String,
    muted: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let mode = resolve_room_muted_mode_impl(&client, &room_id, muted).await?;
    set_room_notification_mode(app, state, room_id, mode).await
}

/// Core logic behind [`set_room_muted`]'s mode resolution — the write itself
/// still routes through `notifications::set_room_notification_mode` (needs
/// `AppHandle`/`State` for the on-disk prefs it manages), so only the
/// `Client`-only "what mode should this room end up in" computation is
/// extracted here.
pub async fn resolve_room_muted_mode_impl(
    client: &Client,
    room_id: &str,
    muted: bool,
) -> Result<super::notifications::RoomNotificationModeKind, String> {
    let parsed_room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    if muted {
        Ok(RoomNotificationMode::Mute.into())
    } else {
        // Unmuting restores this room's default (encrypted / DM-vs-not)
        // notification mode rather than hardcoding `AllMessages` — we can't
        // just re-read `room.notification_mode()` here since the room is
        // *currently* muted, so that would just echo `Mute` back.
        let is_encrypted = room
            .latest_encryption_state()
            .await
            .map(|state| state.is_encrypted())
            .unwrap_or(false);
        let is_one_to_one = room.active_members_count() == 2;
        Ok(client
            .notification_settings()
            .await
            .get_default_room_notification_mode(is_encrypted.into(), is_one_to_one.into())
            .await
            .into())
    }
}

#[tauri::command]
pub async fn set_room_marked_unread(
    state: State<'_, MatrixState>,
    room_id: String,
    unread: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_marked_unread_impl(&client, &room_id, unread).await
}

/// Core logic behind [`set_room_marked_unread`].
pub async fn set_room_marked_unread_impl(
    client: &Client,
    room_id: &str,
    unread: bool,
) -> Result<(), String> {
    let room = parse_room(client, room_id)?;
    room.set_unread_flag(unread)
        .await
        .map_err(|e| e.to_string())
}

/// Persists a drag-reorder as a fractional-index midpoint on whichever tag
/// currently governs this room's section (see [`order_tag_name`]) — the
/// caller (`RoomList.tsx`) computes `order` as the midpoint between the two
/// neighbouring rooms' `manual_order` in the same section.
#[tauri::command]
pub async fn set_room_manual_order(
    state: State<'_, MatrixState>,
    room_id: String,
    order: f64,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_manual_order_impl(&client, &room_id, order).await
}

/// Core logic behind [`set_room_manual_order`].
pub async fn set_room_manual_order_impl(
    client: &Client,
    room_id: &str,
    order: f64,
) -> Result<(), String> {
    let room = parse_room(client, room_id)?;

    let tag = order_tag_name(room.is_favourite(), room.is_low_priority());
    let mut tag_info = TagInfo::new();
    tag_info.order = Some(order);
    room.set_tag(tag, tag_info)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exhaustive truth table over the four inputs to [`has_unread`] — see
    /// Spec 06's "Unread invariant is the highest-risk item": getting this
    /// wrong (muted rooms flagged, or genuine unread hidden) undermines the
    /// whole room list, so every combination is checked explicitly rather
    /// than spot-checked.
    #[test]
    fn has_unread_truth_table() {
        struct Case {
            is_marked_unread: bool,
            is_muted: bool,
            unread_messages: u64,
            unread_count: u64,
            expected: bool,
        }

        let cases = [
            // Nothing going on at all: not unread.
            Case {
                is_marked_unread: false,
                is_muted: false,
                unread_messages: 0,
                unread_count: 0,
                expected: false,
            },
            // Explicit mark-unread always wins, regardless of mute/counts.
            Case {
                is_marked_unread: true,
                is_muted: false,
                unread_messages: 0,
                unread_count: 0,
                expected: true,
            },
            Case {
                is_marked_unread: true,
                is_muted: true,
                unread_messages: 0,
                unread_count: 0,
                expected: true,
            },
            Case {
                is_marked_unread: true,
                is_muted: true,
                unread_messages: 5,
                unread_count: 5,
                expected: true,
            },
            // Ambient unread messages in an unmuted room: unread.
            Case {
                is_marked_unread: false,
                is_muted: false,
                unread_messages: 1,
                unread_count: 0,
                expected: true,
            },
            // Ambient unread messages in a MUTED room, no real notification: NOT unread.
            Case {
                is_marked_unread: false,
                is_muted: true,
                unread_messages: 3,
                unread_count: 0,
                expected: false,
            },
            // A mention/notification in a muted room still counts.
            Case {
                is_marked_unread: false,
                is_muted: true,
                unread_messages: 3,
                unread_count: 1,
                expected: true,
            },
            // A mention/notification in an unmuted room counts (even with zero unread_messages).
            Case {
                is_marked_unread: false,
                is_muted: false,
                unread_messages: 0,
                unread_count: 1,
                expected: true,
            },
            // Unmuted, unread_count set alongside unread_messages: still unread.
            Case {
                is_marked_unread: false,
                is_muted: false,
                unread_messages: 2,
                unread_count: 1,
                expected: true,
            },
        ];

        for (i, case) in cases.iter().enumerate() {
            assert_eq!(
                has_unread(
                    case.is_marked_unread,
                    case.is_muted,
                    case.unread_messages,
                    case.unread_count,
                ),
                case.expected,
                "case {i} failed: {:?} {:?} {:?} {:?}",
                case.is_marked_unread,
                case.is_muted,
                case.unread_messages,
                case.unread_count,
            );
        }
    }

    #[test]
    fn order_tag_prefers_favourite_over_low_priority() {
        assert_eq!(order_tag_name(true, true), TagName::Favorite);
        assert_eq!(order_tag_name(true, false), TagName::Favorite);
        assert_eq!(order_tag_name(false, true), TagName::LowPriority);
        assert_eq!(
            order_tag_name(false, false),
            TagName::User(UserTagName::from_str("u.order").unwrap())
        );
    }

    #[test]
    fn pending_invites_sort_before_joined_rooms() {
        assert!(
            membership_rank(RoomMembershipKind::Invite) < membership_rank(RoomMembershipKind::Join)
        );
    }

    #[test]
    fn truncate_preview_leaves_short_text_untouched() {
        assert_eq!(truncate_preview("see you at 6", 100), "see you at 6");
    }

    #[test]
    fn truncate_preview_cuts_long_text_and_appends_ellipsis() {
        let long_text = "a".repeat(150);
        let truncated = truncate_preview(&long_text, 100);
        assert_eq!(truncated.chars().count(), 101); // 100 chars + the ellipsis
        assert!(truncated.ends_with('…'));
        assert!(truncated.starts_with(&"a".repeat(100)));
    }

    #[test]
    fn truncate_preview_counts_chars_not_bytes() {
        // Multi-byte characters must not be split mid-codepoint.
        let long_text = "é".repeat(150);
        let truncated = truncate_preview(&long_text, 100);
        assert_eq!(truncated.chars().count(), 101);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn room_message_preview_extracts_sender_and_text_for_a_text_message() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::ALICE;

        let raw = EventFactory::new()
            .room(matrix_sdk::ruma::room_id!("!test:example.org"))
            .text_msg("see you at 6")
            .sender(&ALICE)
            .event_id(matrix_sdk::ruma::event_id!("$text"))
            .into_raw_sync();

        let (sender, text) =
            room_message_preview_from_raw(&raw).expect("a text message has a preview");
        assert_eq!(sender, ALICE.to_string());
        assert_eq!(text, "see you at 6");
    }

    #[test]
    fn room_message_preview_summarizes_an_image_message() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::ALICE;

        let raw = EventFactory::new()
            .room(matrix_sdk::ruma::room_id!("!test:example.org"))
            .image(
                "vacation.jpg".to_string(),
                matrix_sdk::ruma::mxc_uri!("mxc://example.org/abc123").to_owned(),
            )
            .sender(&ALICE)
            .event_id(matrix_sdk::ruma::event_id!("$image"))
            .into_raw_sync();

        let (sender, text) =
            room_message_preview_from_raw(&raw).expect("an image message has a preview");
        assert_eq!(sender, ALICE.to_string());
        // Not the raw filename-only body — a human-readable summary instead.
        assert_eq!(text, "Sent an image");
    }

    #[test]
    fn room_message_preview_is_none_for_a_non_message_event() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::ALICE;

        let raw = EventFactory::new()
            .room(matrix_sdk::ruma::room_id!("!test:example.org"))
            .member(&ALICE)
            .event_id(matrix_sdk::ruma::event_id!("$member"))
            .into_raw_sync();

        assert!(room_message_preview_from_raw(&raw).is_none());
    }
}
