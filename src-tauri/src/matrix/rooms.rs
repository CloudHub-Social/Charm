//! Room organization: favourite/low-priority tags, mute, mark-unread, manual
//! ordering, and the single `has_unread` invariant every unread indicator in
//! the UI reads from (computed once here, in [`snapshot_rooms`] via
//! [`has_unread`], never re-derived per-component — see Spec 06).

use matrix_sdk::notification_settings::RoomNotificationMode;
use matrix_sdk::room::Room;
use matrix_sdk::ruma::events::tag::{TagInfo, TagName, UserTagName};
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use tauri::State;
use ts_rs::TS;

use super::MatrixState;

/// Flat room summary for the room list. No message preview yet — that needs
/// the timeline/event-cache API, which is Phase 1 timeline-rendering scope,
/// not this first sync-wiring cut.
///
/// `has_unread` is the single authoritative "needs attention" signal (see
/// [`has_unread`]) — computed once here, in [`snapshot_rooms`]; every UI
/// unread indicator reads this field rather than re-deriving it from
/// `unread_count`/`unread_messages`/`is_marked_unread` itself.
///
/// `list_rooms`/`room_list:update` pre-sort by (section, `manual_order`,
/// name) in [`snapshot_rooms`] — the frontend performs no sorting.
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
    for room in client.rooms() {
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

/// Snapshots the client's in-memory room list into sorted [`RoomSummary`]s —
/// shared by [`list_rooms`] and every iteration of the background sync loop
/// (`sync::spawn_sync_loop`), which emits the result as `room_list:update`.
pub(crate) async fn snapshot_rooms(client: &Client) -> Vec<RoomSummary> {
    let parents = parent_space_ids(client).await;

    let mut summaries = Vec::new();
    for room in client.rooms() {
        let room_id = room.room_id().to_string();
        let name = room.name();
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

        summaries.push((
            section_rank(is_favourite, is_low_priority),
            manual_order,
            name.clone().unwrap_or_default(),
            RoomSummary {
                room_id: room_id.clone(),
                name,
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
            },
        ));
    }

    summaries.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| match (a.1, b.1) {
                (Some(a_order), Some(b_order)) => a_order.total_cmp(&b_order),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.2.cmp(&b.2))
    });

    summaries
        .into_iter()
        .map(|(_, _, _, summary)| summary)
        .collect()
}

/// Reads the current room list out of the client's in-memory store —
/// no network round-trip, just whatever the last sync populated.
#[tauri::command]
pub async fn list_rooms(state: State<'_, MatrixState>) -> Result<Vec<RoomSummary>, String> {
    let client = state.require_client().await?;
    Ok(snapshot_rooms(&client).await)
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
    let room = parse_room(&client, &room_id)?;
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
    let room = parse_room(&client, &room_id)?;
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

#[tauri::command]
pub async fn set_room_muted(
    state: State<'_, MatrixState>,
    room_id: String,
    muted: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let parsed_room_id = matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    let mode = if muted {
        RoomNotificationMode::Mute
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
        client
            .notification_settings()
            .await
            .get_default_room_notification_mode(is_encrypted.into(), is_one_to_one.into())
            .await
    };

    client
        .notification_settings()
        .await
        .set_room_notification_mode(&parsed_room_id, mode)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_room_marked_unread(
    state: State<'_, MatrixState>,
    room_id: String,
    unread: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let room = parse_room(&client, &room_id)?;
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
    let room = parse_room(&client, &room_id)?;

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
}
