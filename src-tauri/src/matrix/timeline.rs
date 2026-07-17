use std::sync::Arc;

use imbl::Vector;
use matrix_sdk::ruma::events::room::message::{MessageFormat, MessageType};
use matrix_sdk::ruma::{RoomId, UserId};
use matrix_sdk::Client;
use matrix_sdk_ui::timeline::{
    EventSendState, EventTimelineItem, MsgLikeKind, Profile, Timeline, TimelineDetails,
    TimelineItem,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use ts_rs::TS;

use super::{media, profiles, shell, MatrixState};

/// The fixed placeholder body used for an as-yet-undecrypted message (see
/// `MsgLikeKind::UnableToDecrypt` below). `RoomMessageSummary::is_undecrypted`
/// is the authoritative signal for this state — this constant only sets the
/// display text; never match against it to detect undecrypted messages (a
/// real decrypted message can legitimately contain this exact string).
const UNABLE_TO_DECRYPT_BODY: &str = "Unable to decrypt message";

/// Display metadata for a non-text `m.room.message` msgtype, additive
/// alongside Spec 03's flat `RoomMessageSummary` fields — `None` for text
/// messages. Carries no bytes, no `MediaSource`, no encryption key material:
/// just enough to render a thumbnail/player/chip. The frontend resolves
/// actual media bytes lazily via `resolve_media(room_id, event_id,
/// thumbnail)`, which re-derives the real `MediaSource` server-side by
/// looking the event back up — nothing decodable ever crosses IPC.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "type")]
pub enum MediaContent {
    Image {
        mime: Option<String>,
        #[ts(type = "number | null")]
        size: Option<u64>,
        #[ts(type = "number | null")]
        width: Option<u32>,
        #[ts(type = "number | null")]
        height: Option<u32>,
        has_thumbnail: bool,
        blurhash: Option<String>,
    },
    Video {
        mime: Option<String>,
        #[ts(type = "number | null")]
        size: Option<u64>,
        #[ts(type = "number | null")]
        width: Option<u32>,
        #[ts(type = "number | null")]
        height: Option<u32>,
        #[ts(type = "number | null")]
        duration_ms: Option<u64>,
        has_thumbnail: bool,
    },
    Audio {
        mime: Option<String>,
        #[ts(type = "number | null")]
        size: Option<u64>,
        #[ts(type = "number | null")]
        duration_ms: Option<u64>,
    },
    File {
        filename: String,
        mime: Option<String>,
        #[ts(type = "number | null")]
        size: Option<u64>,
    },
}

/// Builds the `media` field for a `RoomMessageSummary` from a `MessageType` —
/// pure and synchronous, no cache/network access, since it only reads fields
/// already present on the deserialized event.
fn message_type_to_media(msgtype: &MessageType) -> Option<MediaContent> {
    match msgtype {
        MessageType::Image(image) => Some(MediaContent::Image {
            mime: image.info.as_ref().and_then(|i| i.mimetype.clone()),
            size: image.info.as_ref().and_then(|i| i.size).map(u64::from),
            width: image
                .info
                .as_ref()
                .and_then(|i| i.width)
                .map(|w| u32::try_from(u64::from(w)).unwrap_or(u32::MAX)),
            height: image
                .info
                .as_ref()
                .and_then(|i| i.height)
                .map(|h| u32::try_from(u64::from(h)).unwrap_or(u32::MAX)),
            has_thumbnail: image
                .info
                .as_ref()
                .is_some_and(|i| i.thumbnail_source.is_some()),
            blurhash: None,
        }),
        MessageType::Video(video) => Some(MediaContent::Video {
            mime: video.info.as_ref().and_then(|i| i.mimetype.clone()),
            size: video.info.as_ref().and_then(|i| i.size).map(u64::from),
            width: video
                .info
                .as_ref()
                .and_then(|i| i.width)
                .map(|w| u32::try_from(u64::from(w)).unwrap_or(u32::MAX)),
            height: video
                .info
                .as_ref()
                .and_then(|i| i.height)
                .map(|h| u32::try_from(u64::from(h)).unwrap_or(u32::MAX)),
            duration_ms: video
                .info
                .as_ref()
                .and_then(|i| i.duration)
                .map(|d| d.as_millis() as u64),
            has_thumbnail: video
                .info
                .as_ref()
                .is_some_and(|i| i.thumbnail_source.is_some()),
        }),
        MessageType::Audio(audio) => Some(MediaContent::Audio {
            mime: audio.info.as_ref().and_then(|i| i.mimetype.clone()),
            size: audio.info.as_ref().and_then(|i| i.size).map(u64::from),
            duration_ms: audio
                .info
                .as_ref()
                .and_then(|i| i.duration)
                .map(|d| d.as_millis() as u64),
        }),
        MessageType::File(file) => Some(MediaContent::File {
            filename: file.filename.clone().unwrap_or_else(|| file.body.clone()),
            mime: file.info.as_ref().and_then(|i| i.mimetype.clone()),
            size: file.info.as_ref().and_then(|i| i.size).map(u64::from),
        }),
        _ => None,
    }
}

/// A short, human-readable summary of a `m.room.message` for contexts that
/// show only a single line of text (the room-list last-message preview, Spec
/// 54) — text/emote/notice bodies are shown verbatim, but a raw `body()` for
/// a media msgtype is often just the file's name (or, for some clients,
/// empty), which reads as a stray filename rather than a description of what
/// was sent. Kept alongside [`message_type_to_media`] since both switch on
/// the same `MessageType` variants; this one is pure text, no info/thumbnail
/// metadata, so callers that already have a [`MediaContent`] don't need this
/// too.
pub(crate) fn message_type_preview_text(msgtype: &MessageType) -> String {
    match msgtype {
        MessageType::Text(content) => content.body.clone(),
        MessageType::Emote(content) => content.body.clone(),
        MessageType::Notice(content) => content.body.clone(),
        MessageType::Image(_) => "Sent an image".to_string(),
        MessageType::Video(_) => "Sent a video".to_string(),
        MessageType::Audio(_) => "Sent an audio message".to_string(),
        MessageType::File(_) => "Sent a file".to_string(),
        MessageType::Location(_) => "Sent a location".to_string(),
        other => other.body().to_string(),
    }
}

#[cfg(test)]
mod message_type_preview_text_tests {
    use matrix_sdk::ruma::events::room::message::{
        ImageMessageEventContent, TextMessageEventContent,
    };
    use matrix_sdk::ruma::events::room::ImageInfo;

    use super::*;

    #[test]
    fn text_message_shows_body_verbatim() {
        let msgtype = MessageType::Text(TextMessageEventContent::plain("see you at 6"));
        assert_eq!(message_type_preview_text(&msgtype), "see you at 6");
    }

    #[test]
    fn image_message_shows_a_human_summary_not_the_filename() {
        let mut content = ImageMessageEventContent::plain(
            "vacation.jpg".to_string(),
            matrix_sdk::ruma::mxc_uri!("mxc://example.org/abc123").to_owned(),
        );
        content.info = Some(Box::new(ImageInfo::new()));
        let msgtype = MessageType::Image(content);
        assert_eq!(message_type_preview_text(&msgtype), "Sent an image");
    }
}

/// Extracts a message's `org.matrix.custom.html` formatted body, if it has
/// one — `None` for plain-text messages/emotes/notices or ones formatted
/// with anything other than HTML (the only format Matrix currently defines).
/// Trusted only as raw content here: rendering it is the frontend's job, and
/// the frontend re-sanitizes against the Matrix-permitted allowlist before
/// ever putting it in the DOM (see `composerSanitize.ts`) rather than
/// trusting that this event's sender did. `matrix-sdk-ui`'s `Timeline`
/// already collapses edits onto `message.msgtype()` before this is called,
/// so this covers both an original send and its latest edit uniformly.
fn formatted_html_body(msgtype: &MessageType) -> Option<String> {
    let formatted = match msgtype {
        MessageType::Text(content) => content.formatted.as_ref(),
        MessageType::Emote(content) => content.formatted.as_ref(),
        MessageType::Notice(content) => content.formatted.as_ref(),
        _ => None,
    }?;
    (formatted.format == MessageFormat::Html).then(|| formatted.body.clone())
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct ReactionGroup {
    pub key: String,
    // Small counts (aggregated per room, per emoji) stay well within JS's safe-integer
    // range; emit `number` rather than ts-rs's default `bigint`.
    #[ts(type = "number")]
    pub count: u32,
    pub reacted_by_me: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct ReplyRef {
    pub event_id: String,
    pub sender: String,
    /// Resolved from the replied-to event's own `sender_profile()` — `None`
    /// if that event isn't loaded/resolved yet, same caveat as `preview`.
    pub sender_display_name: Option<String>,
    pub preview: String,
}

/// Local send-queue state of a message, folded onto its `RoomMessageSummary`
/// so the frontend can flip a bubble pending -> sent -> error without a full
/// timeline diff. Sourced from `matrix-sdk-ui`'s `Timeline`
/// (`EventTimelineItem::send_state`), which listens to the same room-level
/// send queue as every send/edit/react/reply command regardless of which one
/// queued a given event.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SendState {
    Pending,
    Sent,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomMessageSummary {
    pub event_id: String,
    pub sender: String,
    /// Resolved from `EventTimelineItem::sender_profile()` — already
    /// fetched and kept live by `matrix-sdk-ui`'s `Timeline` itself (it
    /// re-resolves and re-diffs on membership changes), so this never costs
    /// its own `get_member` round-trip. `None` (fall back to `sender`, the
    /// MXID) when the profile hasn't resolved yet or the member has no
    /// display name set.
    pub sender_display_name: Option<String>,
    /// The sender's avatar mxc, if set — carried alongside the resolved
    /// `sender_avatar_path` so the frontend can cache-key on the mxc
    /// independently of local path resolution.
    pub sender_avatar_url: Option<String>,
    /// `sender_avatar_url` resolved to a local thumbnail path via Spec 02's
    /// media cache, or `None` if unresolved — the frontend falls back to an
    /// initials avatar in that case.
    pub sender_avatar_path: Option<String>,
    /// Text-preview/room-list use — kept for backwards compatibility
    /// alongside `content`, which carries the full tagged-union payload.
    pub body: String,
    /// `org.matrix.custom.html` formatted body, when the message (or its
    /// latest edit) has one — see `formatted_html_body` in this module.
    /// `None` for plain-text messages. Rendered only after re-sanitizing
    /// against the Matrix-permitted allowlist (`composerSanitize.ts`); never
    /// trust this as pre-sanitized just because it came from the SDK.
    pub formatted_body: Option<String>,
    // Milliseconds since epoch stays well within JS's safe-integer range; emit `number`
    // rather than ts-rs's default `bigint` so the frontend can use it directly.
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    pub edited: bool,
    pub redacted: bool,
    pub reactions: Vec<ReactionGroup>,
    pub in_reply_to: Option<ReplyRef>,
    pub transaction_id: Option<String>,
    pub send_state: SendState,
    /// `None` for text/notice/emote messages; `Some` for image/video/audio/file
    /// msgtypes. See [`MediaContent`] and `resolve_media` (in `mod.rs`) for
    /// how the frontend turns this into an actual displayable/downloadable
    /// local path.
    pub media: Option<MediaContent>,
    /// `true` only for `MsgLikeKind::UnableToDecrypt` — the authoritative
    /// signal for "this is the undecrypted placeholder", set server-side.
    /// Never derive this by comparing `body` against the placeholder text: a
    /// real decrypted message can legitimately contain that exact string,
    /// which would otherwise false-positive as undecrypted.
    pub is_undecrypted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct TimelinePage {
    pub messages: Vec<RoomMessageSummary>,
    /// Spec 14 tweak (the one allowed IPC-contract change): with a
    /// `matrix-sdk-ui` `Timeline` backing pagination, there's no opaque
    /// server-side cursor to resume from any more — `Timeline::paginate_backwards`
    /// is stateful per-room (it just walks further back from wherever that
    /// room's `Timeline` currently is). So this is now a **sentinel**, not a
    /// token: `Some("more")` means the timeline start hasn't been reached yet
    /// (call `get_timeline_page` again to page further back), `None` means
    /// the start of the room's history has been reached. The frontend already
    /// only passes this back opaquely (never reads its value), so this is a
    /// same-shape, source-compatible change.
    pub next_cursor: Option<String>,
}

/// Pushed to the frontend whenever a room's live `Timeline` changes — new
/// events, edits, reactions, redactions, or a local echo's `send_state`
/// flipping — so a room's message list can update live without the frontend
/// re-fetching a `TimelinePage`. Sourced from a per-room `Timeline`'s diff
/// stream (see `spawn_timeline_listener`), not from raw sync batches, so a
/// relation targeting an already-loaded-but-out-of-batch message updates that
/// message in place instead of being silently dropped (the bug `events_to_summaries`
/// had prior to Spec 14).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomTimelineUpdate {
    pub room_id: String,
    pub messages: Vec<RoomMessageSummary>,
}

/// Re-snapshots a `Timeline`'s current items into `RoomMessageSummary`s,
/// filtering out virtual items (date dividers, the read marker, the
/// timeline-start marker) and any event-shaped item this DTO doesn't
/// represent yet (state events, stickers, polls, live locations, custom
/// message-likes) — the same silent-ignore behavior the hand-rolled fold had
/// for non-`m.room.message`/`m.reaction`/`m.room.redaction` events.
/// `pub` (not `pub(crate)`) so the network-dependent integration test for
/// this lives in `tests/message_actions.rs` rather than the `--lib`
/// unit-test target CI runs without a local Synapse available — same
/// rationale as `resolve_alias`/`discover` elsewhere in this crate.
pub async fn items_to_summaries(
    items: &Vector<Arc<TimelineItem>>,
    own_user_id: Option<&UserId>,
    client: &Client,
    media_cache: Option<&media::MediaCache>,
) -> Vec<RoomMessageSummary> {
    // Dedupes avatar-thumbnail resolution across one batch — several
    // messages from the same sender shouldn't each re-touch the media
    // cache's lock/mtime bookkeeping when they all resolve to the same mxc.
    let mut avatar_paths: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();

    let mut summaries = Vec::new();
    for item in items
        .iter()
        .filter_map(|item: &Arc<TimelineItem>| item.as_event())
    {
        if let Some(summary) =
            timeline_item_to_summary(item, own_user_id, client, media_cache, &mut avatar_paths)
                .await
        {
            summaries.push(summary);
        }
    }
    summaries
}

/// Pulls a resolved `sender_profile()`'s display name + avatar mxc, or
/// `(None, None)` if it isn't `Ready` yet (still being fetched, never
/// requested, or errored) — matrix-sdk-ui resolves and live-updates this for
/// us (see the module doc comment), so there's nothing to fetch here.
/// The Matrix spec requires disambiguating a sender's display name when
/// another member of the room shares it (`Profile::display_name_ambiguous`)
/// — otherwise one user could pick a display name matching another member's
/// to impersonate them in the timeline. Appends the sender's own MXID in
/// that case, same convention other Matrix clients use.
fn sender_profile_fields(
    sender: &UserId,
    profile: &TimelineDetails<Profile>,
) -> (Option<String>, Option<String>) {
    match profile {
        TimelineDetails::Ready(profile) => {
            let display_name = profile.display_name.as_ref().map(|name| {
                if profile.display_name_ambiguous {
                    format!("{name} ({sender})")
                } else {
                    name.clone()
                }
            });
            (
                display_name,
                profile.avatar_url.as_ref().map(ToString::to_string),
            )
        }
        _ => (None, None),
    }
}

/// Resolves `mxc` to a local thumbnail path, checking `seen` (this batch's
/// dedup map) before falling through to the shared media cache.
async fn resolve_avatar_path_cached(
    client: &Client,
    media_cache: Option<&media::MediaCache>,
    mxc: &str,
    seen: &mut std::collections::HashMap<String, Option<String>>,
) -> Option<String> {
    if let Some(cached) = seen.get(mxc) {
        return cached.clone();
    }
    let resolved = profiles::resolve_avatar_path(client, media_cache, mxc).await;
    seen.insert(mxc.to_string(), resolved.clone());
    resolved
}

/// Maps one `EventTimelineItem` to a `RoomMessageSummary`, keeping the DTO
/// shape Spec 02/03 established stable. See the module-level doc for the
/// per-field mapping rationale.
async fn timeline_item_to_summary(
    item: &EventTimelineItem,
    own_user_id: Option<&UserId>,
    client: &Client,
    media_cache: Option<&media::MediaCache>,
    avatar_paths: &mut std::collections::HashMap<String, Option<String>>,
) -> Option<RoomMessageSummary> {
    let msglike = item.content().as_msglike()?;

    // A local echo's `event_id()` is `None` until the server acks the send —
    // falling back to the transaction id (present for every local echo) is
    // what fixes the duplicate/stuck-"pending" echo bug: the frontend keys
    // its rendered row on this same id (`itemKey` in ChatShell.tsx). Note
    // `item.transaction_id()` only ever returns `Some` while this is still a
    // *local* item — matrix-sdk-ui has no public accessor for a remote
    // item's originating transaction id, so this becomes `None` again once
    // the homeserver's echo replaces the local one. That's fine: unlike the
    // pre-Spec-14 hand-rolled fold, `Timeline` never renders two separate
    // items for one message in the first place (the remote echo replaces the
    // local one in place, at the same position), so nothing downstream needs
    // to match a synced event back to its transaction id any more.
    let transaction_id = item.transaction_id().map(ToString::to_string);
    let event_id = item
        .event_id()
        .map(ToString::to_string)
        .or_else(|| transaction_id.clone())
        .unwrap_or_default();

    let send_state = match item.send_state() {
        None => SendState::Sent,
        Some(EventSendState::NotSentYet { .. }) => SendState::Pending,
        Some(EventSendState::Sent { .. }) => SendState::Sent,
        Some(EventSendState::SendingFailed { error, .. }) => SendState::Error {
            message: error.to_string(),
        },
    };

    let in_reply_to = msglike.in_reply_to.as_ref().map(|reply| {
        let (sender, sender_display_name, preview) = match &reply.event {
            TimelineDetails::Ready(embedded) => {
                let preview = if embedded.content.is_redacted() {
                    String::new()
                } else {
                    embedded
                        .content
                        .as_message()
                        .map(|m| m.body().to_string())
                        .unwrap_or_default()
                };
                let (sender_display_name, _) =
                    sender_profile_fields(&embedded.sender, &embedded.sender_profile);
                (embedded.sender.to_string(), sender_display_name, preview)
            }
            // Not yet resolved (or resolution failed) — the target may not be
            // loaded in this timeline's window; render an empty preview
            // rather than blocking the whole summary on a fetch.
            _ => (String::new(), None, String::new()),
        };
        ReplyRef {
            event_id: reply.event_id.to_string(),
            sender,
            sender_display_name,
            preview,
        }
    });

    let reactions: Vec<ReactionGroup> = msglike
        .reactions
        .iter()
        .filter_map(|(key, by_sender)| {
            let count = u32::try_from(by_sender.len()).unwrap_or(u32::MAX);
            if count == 0 {
                return None;
            }
            Some(ReactionGroup {
                key: key.clone(),
                count,
                reacted_by_me: own_user_id.is_some_and(|me| by_sender.contains_key(me)),
            })
        })
        .collect();

    let timestamp_ms: u64 = item.timestamp().0.into();
    let sender = item.sender().to_string();
    let (sender_display_name, sender_avatar_url) =
        sender_profile_fields(item.sender(), item.sender_profile());
    let sender_avatar_path = match &sender_avatar_url {
        Some(mxc) => resolve_avatar_path_cached(client, media_cache, mxc, avatar_paths).await,
        None => None,
    };

    // Common to every branch below — assembled once via struct-update (`..base`)
    // so a future field addition only has to be threaded through here instead
    // of at each match arm (see the `timeline_item_to_summary` doc comment).
    // The per-branch-varying fields are given neutral default placeholders
    // here and overridden only where a given arm actually needs to.
    let base = RoomMessageSummary {
        event_id,
        sender,
        sender_display_name,
        sender_avatar_url,
        sender_avatar_path,
        transaction_id,
        send_state,
        timestamp_ms,
        body: String::new(),
        formatted_body: None,
        edited: false,
        redacted: false,
        reactions: Vec::new(),
        in_reply_to: None,
        media: None,
        is_undecrypted: false,
    };

    match &msglike.kind {
        MsgLikeKind::Message(message) => Some(RoomMessageSummary {
            body: message.body().to_string(),
            formatted_body: formatted_html_body(message.msgtype()),
            edited: message.is_edited(),
            reactions,
            in_reply_to,
            media: message_type_to_media(message.msgtype()),
            ..base
        }),
        MsgLikeKind::Redacted => Some(RoomMessageSummary {
            redacted: true,
            ..base
        }),
        // Decryption retries land as a fresh diff once the key arrives — see
        // `Timeline::retry_decryption`, invoked by matrix-sdk-ui's own crypto
        // plumbing when new room keys come in — which re-emits this item with
        // real `MsgLikeKind::Message` content, replacing this placeholder in
        // place via the normal diff -> re-snapshot -> `timeline:update` path.
        MsgLikeKind::UnableToDecrypt(_) => Some(RoomMessageSummary {
            body: UNABLE_TO_DECRYPT_BODY.to_string(),
            reactions,
            in_reply_to,
            is_undecrypted: true,
            ..base
        }),
        // Stickers/polls/live-locations/custom message-likes aren't part of
        // this DTO shape yet — out of scope for a like-for-like engine swap
        // (see Spec 14's non-goals) — dropped the same way the hand-rolled
        // fold silently ignored any event type it didn't recognize.
        MsgLikeKind::Sticker(_)
        | MsgLikeKind::Poll(_)
        | MsgLikeKind::Other(_)
        | MsgLikeKind::LiveLocation(_) => None,
    }
}

/// The "is this genuinely a new message worth a notification" decision for
/// `spawn_timeline_listener`, isolated so the subtle correctness of that
/// decision can be unit-tested directly instead of resting entirely on the
/// comments around it.
///
/// Two checks, both required:
/// - `event_id` membership: guards against re-notifying a message this
///   listener has already accounted for (e.g. it comes back around in a
///   later diff batch unchanged).
/// - `timestamp_ms >= max seen so far`: guards against backward pagination
///   (scrolling up to load older history), which inserts messages at the
///   *front* of the timeline's items that were never in `seen_event_ids`
///   either, since they'd never been loaded before. An id-membership check
///   alone can't tell "message arrived at the tail just now" apart from
///   "history revealed by scrolling up" — it would wrongly fire a
///   notification for old content the first time a room's history is paged
///   into. Older-history messages always have a timestamp at or before
///   everything already loaded, so gating on the timestamp too (in addition
///   to the id check) excludes them while still catching genuine new
///   arrivals (always time-ordered after the newest thing loaded so far).
///
/// The timestamp comparison is deliberately `>=`, not `>`: two genuinely new
/// messages can share the same millisecond timestamp (e.g. back-to-back
/// sends), and a strict `>` would wrongly suppress the second one just for
/// tying the running max. `seen_event_ids` is what actually guards against
/// re-notifying a message already accounted for, so admitting ties here is
/// safe — this was a real, previously-fixed bug (a `>` here dropped a
/// same-millisecond second message's notification).
///
/// `seen_event_ids` only ever grows (`record` extends it, `seeded_from`/`record`
/// never clear or replace it) — same rationale as `max_seen_timestamp_ms`
/// only ever moving forward via `.max(..)`.
#[derive(Debug, Default)]
struct NotificationDedup {
    seen_event_ids: std::collections::HashSet<String>,
    max_seen_timestamp_ms: u64,
}

impl NotificationDedup {
    /// Seeds from every message already present before the caller started
    /// watching for new arrivals (e.g. a room's already-loaded history) —
    /// none of these should ever be treated as "new".
    fn seeded_from(summaries: &[RoomMessageSummary]) -> Self {
        let mut dedup = Self::default();
        dedup.record(summaries);
        dedup
    }

    /// Whether `message` is a genuinely new arrival that hasn't been
    /// accounted for yet (see the type-level doc comment for the full
    /// rationale). Does not itself mark `message` as seen — call `record`
    /// once the whole batch containing it has been decided on.
    fn is_new(&self, message: &RoomMessageSummary) -> bool {
        !self.seen_event_ids.contains(&message.event_id)
            && message.timestamp_ms >= self.max_seen_timestamp_ms
    }

    /// Marks every message in `summaries` as seen and advances the
    /// high-water mark. Idempotent to call with messages already recorded.
    fn record(&mut self, summaries: &[RoomMessageSummary]) {
        self.seen_event_ids
            .extend(summaries.iter().map(|m| m.event_id.clone()));
        self.max_seen_timestamp_ms = self
            .max_seen_timestamp_ms
            .max(summaries.iter().map(|m| m.timestamp_ms).max().unwrap_or(0));
    }
}

#[cfg(test)]
mod notification_dedup_tests {
    use super::*;

    fn summary(event_id: &str, timestamp_ms: u64) -> RoomMessageSummary {
        RoomMessageSummary {
            event_id: event_id.to_string(),
            sender: "@alice:example.org".to_string(),
            sender_display_name: None,
            sender_avatar_url: None,
            sender_avatar_path: None,
            body: "hello".to_string(),
            formatted_body: None,
            timestamp_ms,
            edited: false,
            redacted: false,
            reactions: Vec::new(),
            in_reply_to: None,
            transaction_id: None,
            send_state: SendState::Sent,
            media: None,
            is_undecrypted: false,
        }
    }

    #[test]
    fn seeded_history_is_never_new() {
        let history = vec![summary("$a", 100), summary("$b", 200)];
        let dedup = NotificationDedup::seeded_from(&history);
        assert!(!dedup.is_new(&summary("$a", 100)));
        assert!(!dedup.is_new(&summary("$b", 200)));
    }

    #[test]
    fn a_later_message_after_seeding_is_new() {
        let dedup = NotificationDedup::seeded_from(&[summary("$a", 100)]);
        assert!(dedup.is_new(&summary("$c", 150)));
    }

    #[test]
    fn same_millisecond_tie_is_still_new_not_suppressed() {
        // Regression test for the `>` vs `>=` bug called out in #67: two
        // genuinely new messages landing in the same diff batch can share a
        // timestamp, and both must still count as new.
        let mut dedup = NotificationDedup::seeded_from(&[summary("$a", 100)]);
        let batch = vec![summary("$b", 150), summary("$c", 150)];
        assert!(dedup.is_new(&batch[0]));
        assert!(dedup.is_new(&batch[1]));
        dedup.record(&batch);
        // Once recorded, neither is "new" again on a later re-check.
        assert!(!dedup.is_new(&batch[0]));
        assert!(!dedup.is_new(&batch[1]));
    }

    #[test]
    fn message_at_exact_high_water_mark_is_still_new() {
        // The actual `>` vs `>=` boundary: unlike the test above (150 > 100
        // passes under either operator), this checks a message whose
        // timestamp exactly equals `max_seen_timestamp_ms` already recorded
        // from a prior message — the case `>` would wrongly reject.
        let dedup = NotificationDedup::seeded_from(&[summary("$a", 150)]);
        assert!(dedup.is_new(&summary("$b", 150)));
    }

    #[test]
    fn backward_pagination_of_older_history_is_not_new() {
        // Simulates scrolling up: older messages inserted at the front of
        // `items`, never previously in `seen_event_ids`, with a timestamp
        // strictly before the high-water mark.
        let mut dedup = NotificationDedup::seeded_from(&[summary("$recent", 500)]);
        let older_page = vec![summary("$older_1", 100), summary("$older_2", 200)];
        assert!(!dedup.is_new(&older_page[0]));
        assert!(!dedup.is_new(&older_page[1]));
        dedup.record(&older_page);
        // Recording older history must not roll the high-water mark
        // backwards — a message arriving later, after paging, still counts
        // as new relative to the most recent thing ever seen.
        assert!(dedup.is_new(&summary("$new", 501)));
    }

    #[test]
    fn already_seen_event_id_is_not_new_even_with_a_higher_timestamp() {
        // Defends the `seen_event_ids` half of the check independently of
        // the timestamp half (e.g. an edit re-emitting the same event id).
        let mut dedup = NotificationDedup::seeded_from(&[summary("$a", 100)]);
        dedup.record(&[summary("$a", 100)]);
        assert!(!dedup.is_new(&summary("$a", 999)));
    }
}

/// Spawned once per room the first time its `Timeline` is built (see
/// `MatrixState::get_or_create_timeline`), for the lifetime of that Timeline
/// (until it's evicted from the bounded LRU map). Emits an initial snapshot
/// immediately, then re-snapshots and emits again on every batch of diffs —
/// `Timeline::subscribe` batches as many updates as are already available
/// rather than emitting one `timeline:update` per individual diff.
///
/// Takes a `Weak<Timeline>`, not an `Arc<Timeline>` — holding a strong
/// reference here would keep the `Timeline` (and this task) alive forever:
/// `MatrixState::get_or_create_timeline` is the only other owner (via the
/// LRU map), and `stream.next()` can block indefinitely on an idle room, so a
/// task holding its own `Arc` would never observe eviction and would leak
/// for the rest of the process's life. Instead, this periodically tries to
/// upgrade the `Weak` and exits its loop the first time that fails — i.e.
/// once the LRU has evicted this room's only other reference.
pub(crate) fn spawn_timeline_listener(
    app: AppHandle,
    room_id: matrix_sdk::ruma::OwnedRoomId,
    timeline: std::sync::Weak<Timeline>,
    client: Client,
    own_user_id: Option<matrix_sdk::ruma::OwnedUserId>,
) -> tokio::task::JoinHandle<()> {
    use futures_util::StreamExt;
    use tauri::Manager;

    /// How often to check whether this room's `Timeline` has been evicted
    /// from the LRU map while the diff stream is otherwise idle (no activity
    /// to wake `stream.next()` on its own).
    const LIVENESS_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

    tokio::spawn(async move {
        let Some(strong) = timeline.upgrade() else {
            return;
        };
        let (initial_items, mut stream) = strong.subscribe().await;
        // Don't hold this across the loop below — only the `Weak` should
        // outlive this point, or eviction could never be observed.
        drop(strong);
        let mut items = initial_items;

        // Re-fetched (cheaply — it's an already-initialized `OnceCell` after
        // the first call) each time rather than held across the loop below,
        // since it borrows from a fresh `State` guard each time and this
        // task otherwise only holds the `'static` `AppHandle`/`Client`.
        let state = app.state::<MatrixState>();
        let media_cache = state.require_media_cache(&app).await.ok();
        let initial_summaries =
            items_to_summaries(&items, own_user_id.as_deref(), &client, media_cache).await;
        // Seed with every event id (and the latest timestamp) already present
        // before this listener subscribed — the initial `timeline:update` for
        // a room the user just opened is existing history, never a "new
        // message" worth a notification. See `NotificationDedup`'s doc
        // comment for the full rationale, including why this is additive-only.
        let mut dedup = NotificationDedup::seeded_from(&initial_summaries);
        let _ = app.emit(
            "timeline:update",
            RoomTimelineUpdate {
                room_id: room_id.to_string(),
                messages: initial_summaries,
            },
        );

        let mut liveness_check = tokio::time::interval(LIVENESS_CHECK_INTERVAL);
        loop {
            let diffs = tokio::select! {
                diffs = stream.next() => diffs,
                _ = liveness_check.tick() => {
                    if timeline.upgrade().is_some() {
                        continue;
                    }
                    break;
                }
            };
            let Some(diffs) = diffs else { break };
            for diff in diffs {
                diff.apply(&mut items);
            }
            let state = app.state::<MatrixState>();
            let media_cache = state.require_media_cache(&app).await.ok();
            let summaries =
                items_to_summaries(&items, own_user_id.as_deref(), &client, media_cache).await;

            let new_messages: Vec<&RoomMessageSummary> =
                summaries.iter().filter(|m| dedup.is_new(m)).collect();
            for message in &new_messages {
                maybe_notify_new_message(&app, &client, &room_id, own_user_id.as_deref(), message)
                    .await;
            }
            dedup.record(&summaries);

            let _ = app.emit(
                "timeline:update",
                RoomTimelineUpdate {
                    room_id: room_id.to_string(),
                    messages: summaries,
                },
            );
        }
    })
}

/// Fires a local OS notification for `message` if it warrants one: not our
/// own message, not redacted, not still a pending local echo, and not still
/// an as-yet-undecrypted placeholder (its key can arrive any time after —
/// see `Timeline::retry_decryption` — at which point this same event id
/// reappears with a real body and gets its own, correctly-timed
/// notification; notifying on the placeholder now would just be a spurious
/// "Unable to decrypt message" toast ahead of the real one). The actual
/// mute/mentions-only/focus decision and the notification fire itself are
/// `shell::maybe_send_notification` — shared with the sync loop's
/// unopened-room path (`sync::notify_unopened_room_messages`) so both agree.
async fn maybe_notify_new_message(
    app: &AppHandle,
    client: &Client,
    room_id: &matrix_sdk::ruma::RoomId,
    own_user_id: Option<&UserId>,
    message: &RoomMessageSummary,
) {
    if message.redacted || !matches!(message.send_state, SendState::Sent) || message.is_undecrypted
    {
        return;
    }

    let Some(room) = client.get_room(room_id) else {
        return;
    };

    shell::maybe_send_notification(
        app,
        &room,
        own_user_id,
        shell::NewMessageNotification {
            event_id: &message.event_id,
            sender: &message.sender,
            sender_display_name: message.sender_display_name.as_deref(),
            body: &message.body,
        },
        || fetch_message_mentions(&room, &message.event_id),
    )
    .await;
}

/// Refetches the original event's raw content to read its `m.mentions`
/// field — `RoomMessageSummary` doesn't carry it, so this is only called for
/// mentions-and-keywords-only rooms (see `maybe_notify_new_message`), not on
/// every message.
async fn fetch_message_mentions(
    room: &matrix_sdk::Room,
    event_id: &str,
) -> Option<matrix_sdk::ruma::events::Mentions> {
    let parsed_event_id = matrix_sdk::ruma::EventId::parse(event_id).ok()?;
    let original = room
        .load_or_fetch_event(&parsed_event_id, None)
        .await
        .ok()?;
    let deserialized: matrix_sdk::ruma::events::AnySyncTimelineEvent =
        original.kind.raw().deserialize().ok()?;
    let matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
        matrix_sdk::ruma::events::AnySyncMessageLikeEvent::RoomMessage(msg),
    ) = deserialized
    else {
        return None;
    };
    msg.as_original()?.content.mentions.clone()
}

/// Cursor-based pagination over a room's message history, oldest-not-included:
/// each call walks backward from wherever this room's live `Timeline` (see
/// `MatrixState::get_or_create_timeline`) currently is. Unlike the pre-Spec-14
/// `MessagesOptions::backward()` cursor, this has no opaque server-side token
/// any more — see [`TimelinePage::next_cursor`]'s doc comment for the sentinel
/// this now is. `cursor` is accepted (and ignored) purely to keep the
/// frontend's `getTimelinePage(roomId, cursor, limit, forceLive)` call shape
/// stable.
///
/// `force_live`: review fix — a room can have a cached, focused
/// (`TimelineFocus::Event`) `Timeline` left over from a Saved Messages jump
/// (`MatrixState::replace_timeline`). Passing `true` resets that back to the
/// room's ordinary live tail if present; the frontend passes `true` only
/// from its room-*open* call (`useChatTimeline`'s effect keyed on
/// `room?.room_id`), never from its separate pagination-loop call, so
/// scrolling further back while still viewing a bookmark's focused context
/// doesn't get treated as a fresh open and snapped back to live — but
/// genuinely reopening that room (from the room list, after navigating
/// away) does reset it, instead of leaving the user stuck on a stale
/// focused view until LRU eviction or app restart.
#[tauri::command]
pub async fn get_timeline_page(
    app: AppHandle,
    state: State<'_, MatrixState>,
    room_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    force_live: bool,
) -> Result<TimelinePage, String> {
    let _ = cursor;
    let client = state.require_client().await?;
    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;

    // Distinguishes a cold open (`timeline.get_page.cold_open` — this room
    // has no cached `Timeline` yet, so `get_or_create_timeline` below does
    // the real work: `Room::timeline()` plus spawning the listener) from a
    // request against an already-open room (`timeline.get_page.pagination`
    // — normally a `paginate_backwards` call against the cached Timeline,
    // e.g. scrolling up through history). Codex review on #289: reporting
    // both under one transaction name mixed steady-state pagination latency
    // into the percentile meant to represent cold-open/decryption latency.
    let cold_open = !state.has_cached_timeline(&parsed_room_id).await;
    let transaction_name = if cold_open {
        "timeline.get_page.cold_open"
    } else {
        "timeline.get_page.pagination"
    };

    // Self-contained Sentry transaction (see `observability_trace::traced`'s
    // doc comment). No dedicated decrypt hook exists to time directly — the
    // SDK's own crypto plumbing decrypts as part of building/paginating the
    // `Timeline` internally — so this is the closest proxy for "how long did
    // it take to see this room's (decrypted) messages." Wraps
    // `get_or_create_timeline` too, not just `get_timeline_page_impl`: on a
    // room's first open (or after LRU eviction), that call itself does the
    // cold-open work — `Room::timeline()` plus spawning the listener — which
    // is exactly the slow-path latency this is meant to measure. Starting
    // the transaction after it, as an earlier version of this change did,
    // would systematically exclude that cost and underreport cold opens.
    crate::observability_trace::traced(transaction_name, "matrix.timeline", async {
        let timeline = state
            .get_or_create_timeline(&app, &client, &parsed_room_id, force_live)
            .await?;
        let media_cache = state.require_media_cache(&app).await.ok();

        get_timeline_page_impl(&client, &timeline, media_cache, limit).await
    })
    .await
}

/// Core logic behind [`get_timeline_page`], taking an already-resolved
/// `&Timeline`/`&MediaCache` rather than `&MatrixState` — building/caching
/// the live `Timeline` (see `MatrixState::get_or_create_timeline`) is
/// inherently tied to how the caller multiplexes sessions (one process-wide
/// LRU on desktop; per-session on the companion server), so that part stays
/// in the Tauri wrapper rather than being duplicated here.
pub async fn get_timeline_page_impl(
    client: &Client,
    timeline: &matrix_sdk_ui::Timeline,
    media_cache: Option<&media::MediaCache>,
    limit: Option<u32>,
) -> Result<TimelinePage, String> {
    // 200 is well over any real UI need (the documented default is 30) —
    // reject rather than silently clamp, so a caller passing a bogus/huge
    // value gets an error instead of quietly triggering a 65535-event
    // backward-pagination request.
    const MAX_PAGE_LIMIT: u32 = 200;
    let requested = limit.unwrap_or(30);
    if requested == 0 || requested > MAX_PAGE_LIMIT {
        return Err(format!(
            "limit must be between 1 and {MAX_PAGE_LIMIT}, got {requested}"
        ));
    }
    let num_events = u16::try_from(requested).map_err(|e| e.to_string())?;
    let hit_start = timeline
        .paginate_backwards(num_events)
        .await
        .map_err(|e| e.to_string())?;

    let own_user_id = client.user_id().map(ToOwned::to_owned);
    // A fresh subscription just to read the current snapshot — the
    // long-lived stream this room's `Timeline` drives `timeline:update` from
    // is already owned by the listener task `get_or_create_timeline` spawned;
    // this second subscription's stream half is dropped immediately below.
    let (items, _stream) = timeline.subscribe().await;

    Ok(TimelinePage {
        messages: items_to_summaries(&items, own_user_id.as_deref(), client, media_cache).await,
        next_cursor: if hit_start {
            None
        } else {
            Some("more".to_string())
        },
    })
}

/// How many `paginate_backwards` batches [`load_timeline_around_event`] will
/// request against the room's *live* timeline before falling back to
/// [`load_focused_event_timeline`] — bounds worst-case work for the common
/// case (a bookmark within recent-ish history) before paying for a second
/// request/timeline swap. At `EVENTS_PER_BATCH` per iteration this covers
/// several thousand events; deliberately not raised further; see the
/// fallback below for events older than that.
const MAX_LOAD_AROUND_ITERATIONS: usize = 20;
const EVENTS_PER_BATCH: u16 = 50;

/// Result of [`load_timeline_around_event`] — richer than a plain `found`
/// bool so the frontend can tell *how* the event was found. Review fix: the
/// common case (the event is within the room's already-cached live
/// timeline, or reachable by the bounded `paginate_backwards` scan below)
/// never touches [`load_focused_event_timeline`]'s server-side `/context`
/// fallback at all — no focused-view swap happens, so the room's cached
/// `Timeline` is still the live one. A plain `bool` return gave the
/// frontend no way to distinguish that from the rarer case where the
/// fallback *did* run and did swap the cache to a focused view, which is
/// the only case where a later "Jump to Present" needs to force the room
/// back to live — `ChatShell` was otherwise treating every successful jump
/// as if it might have focused the view, forcing an unnecessary re-fetch
/// (and the scroll-animation disruption that comes with replacing
/// `messages`) for the much more common non-focusing case.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct JumpToEventResult {
    pub found: bool,
    pub installed_focused_view: bool,
}

/// Spec 12's minimal "load timeline around an arbitrary event id" capability
/// — needed so jumping to a bookmarked message from the Saved Messages view
/// works even when that message isn't in the room's currently-loaded
/// timeline window (e.g. the room hasn't been opened yet, or the bookmark is
/// older than what's paginated in). Tries the cheap path first: keep calling
/// the existing `paginate_backwards` (the same primitive `get_timeline_page`
/// already uses) until `event_id` shows up in the live snapshot, relying on
/// the timeline listener's existing `timeline:update` emission (spawned by
/// `get_or_create_timeline`) to push each newly-paginated batch to the
/// frontend exactly the way backward-scrolling already does.
///
/// If that bounded walk doesn't find the event within
/// `MAX_LOAD_AROUND_ITERATIONS` batches (review fix — previously this simply
/// gave up and returned `false` here, even though the event exists and is
/// reachable, just further back than ~1000 events), falls back to
/// [`load_focused_event_timeline`], which resolves the event via the
/// server's `/context` endpoint directly — no client-side scanning bound.
///
/// Returns whether `event_id` was found. `found: false` now only means the
/// event is genuinely not reachable from the current sync state (e.g. a
/// stale bookmark for an event since removed from the room's DAG the local
/// store can see), not merely "further back than we were willing to page
/// through".
#[tauri::command]
pub async fn load_timeline_around_event(
    app: AppHandle,
    state: State<'_, MatrixState>,
    room_id: String,
    event_id: String,
) -> Result<JumpToEventResult, String> {
    let client = state.require_client().await?;
    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let parsed_event_id = matrix_sdk::ruma::EventId::parse(&event_id).map_err(|e| e.to_string())?;
    // Review fix: registers this call as the room's *current* jump target
    // before doing any work — see `MatrixState::latest_jump_target`'s own
    // doc comment. Starting a second jump for this room immediately
    // supersedes an earlier one still in flight, so that earlier call's own
    // later check (in `load_focused_event_timeline`) can tell it's stale.
    state
        .latest_jump_target
        .lock()
        .await
        .insert(parsed_room_id.to_owned(), parsed_event_id.to_owned());
    // `force_live: false` — this is the jump machinery itself; it should
    // start from whatever's already cached, including a focused view left
    // over from a previous jump in this same room this session, not force a
    // reset back to live.
    let timeline = state
        .get_or_create_timeline(&app, &client, &parsed_room_id, false)
        .await?;

    if timeline_contains_event(&timeline, &event_id).await {
        return Ok(JumpToEventResult {
            found: true,
            installed_focused_view: false,
        });
    }

    for _ in 0..MAX_LOAD_AROUND_ITERATIONS {
        let hit_start = timeline
            .paginate_backwards(EVENTS_PER_BATCH)
            .await
            .map_err(|e| e.to_string())?;
        if timeline_contains_event(&timeline, &event_id).await {
            return Ok(JumpToEventResult {
                found: true,
                installed_focused_view: false,
            });
        }
        if hit_start {
            // Review fix: this used to report not-found immediately here,
            // reasoning that reaching the start of visible history means no
            // further scanning could locate the event. That's only true if
            // `timeline` is the room's live tail — but `get_or_create_timeline`
            // above can just as well return a *cached, already-focused*
            // `Timeline` left over from a previous `load_focused_event_timeline`
            // call for a *different* event in this same room (`replace_timeline`
            // swaps the cache entry to the focused view on every jump). Hitting
            // the start of *that* narrow, event-focused window says nothing
            // about whether the newly-requested event is reachable at all —
            // only the server-side `/context` fallback below can answer that
            // for an arbitrary target, so always fall through to it instead of
            // reporting failure from a bounded scan whose starting point may
            // not even be the room's actual live tail.
            break;
        }
    }

    // Exhausted the bounded live-timeline walk without hitting the start of
    // history — the event may simply be deeper than we're willing to page
    // through client-side. Fall back to a direct server-side lookup instead
    // of reporting failure.
    let found =
        load_focused_event_timeline(&app, &state, &client, &parsed_room_id, &parsed_event_id)
            .await?;
    Ok(JumpToEventResult {
        found,
        // Only `true` when the fallback both found the event *and* actually
        // won the race to install its focused timeline — see
        // `load_focused_event_timeline`'s own re-checks (stale
        // account/session, superseded jump target) for the cases where it
        // returns `found: true` from a stale early-exit without installing
        // anything.
        installed_focused_view: found,
    })
}

/// Fallback for [`load_timeline_around_event`] once the live timeline's
/// bounded backward-pagination gives up without finding `event_id`. Builds a
/// dedicated `TimelineFocus::Event`-focused `Timeline` (`matrix-sdk-ui`'s
/// purpose-built mechanism for jumping to an arbitrary historical event,
/// e.g. from a permalink) via `Room::timeline_builder`, which resolves the
/// target through the server's `/context` endpoint
/// (`Room::event_with_context` under the hood) in a single request no
/// matter how far back it is — no client-side page-by-page scanning bound.
///
/// On success, swaps this room's cached timeline over to the focused one
/// (see `MatrixState::replace_timeline`) so the frontend's next
/// `get_timeline_page`/`timeline:update` sees events around the target
/// instead of the room's unrelated live tail from before the jump.
async fn load_focused_event_timeline(
    app: &AppHandle,
    state: &State<'_, MatrixState>,
    client: &Client,
    room_id: &RoomId,
    event_id: &matrix_sdk::ruma::EventId,
) -> Result<bool, String> {
    use matrix_sdk_ui::timeline::{RoomExt as _, TimelineEventFocusThreadMode, TimelineFocus};

    let room = client
        .get_room(room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    let focused = room
        .timeline_builder()
        .with_focus(TimelineFocus::Event {
            target: event_id.to_owned(),
            num_context_events: EVENTS_PER_BATCH,
            thread_mode: TimelineEventFocusThreadMode::Automatic {
                hide_threaded_events: false,
            },
        })
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let focused = Arc::new(focused);

    if !timeline_contains_event(&focused, event_id.as_str()).await {
        return Ok(false);
    }

    // Review fix: `client` was captured (and potentially awaited on, both in
    // `room.timeline_builder()...build()` above and in the caller's own
    // bounded-pagination loop) well before this point. If the user logs out
    // — or logs out and into a *different* account — while this is in
    // flight, `clear_timelines()` runs against the new/absent session, but
    // this task is still holding its own `Client` clone (an `Arc` handle
    // that keeps working even after the session it belongs to has been
    // logged out of) and would otherwise go ahead and install that stale
    // account's focused `Timeline` into the process-wide, room-id-keyed
    // cache — a later open of that same room id under the new session would
    // then render or emit updates sourced from the old account. This is a
    // cheap early-exit check only; `replace_timeline` itself performs the
    // authoritative re-check immediately before installing anything, since
    // it has its own internal await (stopping the previous listener) that
    // this check alone can't cover.
    //
    // Review fix: compares `device_id()`, not `user_id()` — a `user_id()`
    // comparison alone would pass for a logout-then-re-login into the
    // *same* account, even though that mints a fresh session (new device,
    // revoked old tokens). `device_id()` is unique per login session, so it
    // also catches that case, not just a switch to a different account.
    let still_active = match state.require_client().await {
        Ok(current) => current.device_id() == client.device_id(),
        Err(_) => false,
    };
    if !still_active {
        return Ok(false);
    }

    // Review fix: this call may have been superseded by a *newer* jump for
    // this same room (targeting a different event) started while the
    // `/context` lookup above was still in flight — see
    // `MatrixState::latest_jump_target`'s own doc comment. Only the request
    // whose target still matches gets to install its focused timeline;
    // treat a superseded one the same as "not found" rather than letting it
    // clobber whatever the newer jump already installed.
    let still_latest = state
        .latest_jump_target
        .lock()
        .await
        .get(room_id)
        .is_some_and(|target| target.as_str() == event_id.as_str());
    if !still_latest {
        return Ok(false);
    }

    // `replace_timeline` returns `None` if its own re-check finds the
    // active client no longer matches by the time it's ready to install —
    // treat that identically to "not found", not as a successful jump.
    Ok(state
        .replace_timeline(app, client, room_id, focused)
        .await
        .is_some())
}

async fn timeline_contains_event(timeline: &Timeline, event_id: &str) -> bool {
    let (items, _stream) = timeline.subscribe().await;
    items
        .iter()
        .filter_map(|item| item.as_event())
        .any(|item| item.event_id().is_some_and(|id| id.as_str() == event_id))
}

#[cfg(test)]
mod mapping_tests {
    use futures_util::StreamExt;
    use imbl::Vector;
    use matrix_sdk::ruma::{event_id, room_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::event_factory::EventFactory;
    use matrix_sdk_test::{JoinedRoomBuilder, ALICE, BOB};
    use matrix_sdk_ui::timeline::RoomExt as _;

    use super::*;

    /// Builds a real `matrix-sdk-ui` `Timeline` against a mocked homeserver
    /// (no live Synapse) pre-loaded with `events`, then returns its current
    /// item snapshot mapped to `RoomMessageSummary`s — exercising the exact
    /// mapping this module ships, over a real `Timeline`/`EventTimelineItem`
    /// rather than a hand-fabricated one (the crate's `EventTimelineItem`
    /// constructor is private, so this is the supported way to get one).
    async fn summaries_for(
        events: Vec<matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnySyncTimelineEvent>>,
    ) -> Vec<RoomMessageSummary> {
        let room_id = room_id!("!test:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let room = server.sync_joined_room(&client, room_id).await;
        let timeline = room.timeline().await.expect("failed to build timeline");
        let (_, mut stream) = timeline.subscribe().await;

        let mut room_builder = JoinedRoomBuilder::new(room_id);
        for event in events {
            room_builder = room_builder.add_timeline_event(event);
        }
        server.sync_room(&client, room_builder).await;

        // Drain whatever batch(es) of diffs that sync produced before
        // snapshotting — `Timeline::subscribe`'s stream batches, so one
        // `.next()` normally covers a single sync response, but this loops
        // with a short idle timeout to be robust to it arriving as more than
        // one batch.
        while let Ok(Some(_)) =
            tokio::time::timeout(std::time::Duration::from_millis(200), stream.next()).await
        {
        }

        let own_user_id = client.user_id().map(ToOwned::to_owned);
        let (items, _stream) = timeline.subscribe().await;
        items_to_summaries(&items, own_user_id.as_deref(), &client, None).await
    }

    /// Same as [`summaries_for`], but syncs each `Vec` in `batches` as its
    /// own separate sync response rather than one combined one — needed
    /// when a later event's mapping depends on an earlier one already being
    /// committed to room state (e.g. a member's profile needing to be known
    /// before the message that follows it resolves `sender_profile()`),
    /// which isn't guaranteed for two events processed within the same
    /// batch.
    async fn summaries_for_batches(
        batches: Vec<
            Vec<matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnySyncTimelineEvent>>,
        >,
    ) -> Vec<RoomMessageSummary> {
        let room_id = room_id!("!test:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let room = server.sync_joined_room(&client, room_id).await;
        let timeline = room.timeline().await.expect("failed to build timeline");
        let (_, mut stream) = timeline.subscribe().await;

        for events in batches {
            let mut room_builder = JoinedRoomBuilder::new(room_id);
            for event in events {
                room_builder = room_builder.add_timeline_event(event);
            }
            server.sync_room(&client, room_builder).await;
            while let Ok(Some(_)) =
                tokio::time::timeout(std::time::Duration::from_millis(200), stream.next()).await
            {
            }
        }

        let own_user_id = client.user_id().map(ToOwned::to_owned);
        let (items, _stream) = timeline.subscribe().await;
        items_to_summaries(&items, own_user_id.as_deref(), &client, None).await
    }

    fn factory() -> EventFactory {
        EventFactory::new().room(room_id!("!test:example.org"))
    }

    #[tokio::test]
    async fn emits_no_media_for_a_text_message() {
        let summaries = summaries_for(vec![factory()
            .text_msg("hello there")
            .sender(&ALICE)
            .event_id(event_id!("$text"))
            .into_raw_sync()])
        .await;

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].body, "hello there");
        assert!(summaries[0].media.is_none());
    }

    #[tokio::test]
    async fn emits_image_media_metadata_for_an_image_message() {
        let summaries = summaries_for(vec![factory()
            .image("cat.png".to_string(), "mxc://example.org/abc123".into())
            .sender(&ALICE)
            .event_id(event_id!("$image"))
            .into_raw_sync()])
        .await;

        assert_eq!(summaries.len(), 1);
        match &summaries[0].media {
            Some(MediaContent::Image { .. }) => {}
            other => panic!("expected Image media, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn carries_html_formatted_body_for_a_formatted_message() {
        let summaries = summaries_for(vec![factory()
            .text_html("hello", "<strong>hello</strong>")
            .sender(&ALICE)
            .event_id(event_id!("$formatted"))
            .into_raw_sync()])
        .await;

        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].formatted_body.as_deref(),
            Some("<strong>hello</strong>")
        );
    }

    #[tokio::test]
    async fn has_no_formatted_body_for_a_plain_text_message() {
        let summaries = summaries_for(vec![factory()
            .text_msg("hello")
            .sender(&ALICE)
            .event_id(event_id!("$plain"))
            .into_raw_sync()])
        .await;

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].formatted_body, None);
    }

    #[tokio::test]
    async fn edit_collapses_onto_target_with_edited_flag() {
        let original_id = event_id!("$original");
        let original = factory()
            .text_msg("hello")
            .sender(&ALICE)
            .event_id(original_id)
            .into_raw_sync();
        let edit = factory()
            .text_msg("* hello world")
            .sender(&ALICE)
            .event_id(event_id!("$edit"))
            .edit(original_id, matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation::text_plain("hello world"))
            .into_raw_sync();

        let summaries = summaries_for(vec![original, edit]).await;

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].body, "hello world");
        assert!(summaries[0].edited);
    }

    #[tokio::test]
    async fn redaction_clears_body_and_sets_redacted() {
        let original_id = event_id!("$original");
        let original = factory()
            .text_msg("hello")
            .sender(&ALICE)
            .event_id(original_id)
            .into_raw_sync();
        let redaction = factory()
            .redaction(original_id)
            .sender(&ALICE)
            .into_raw_sync();

        let summaries = summaries_for(vec![original, redaction]).await;

        assert_eq!(summaries.len(), 1);
        assert!(summaries[0].redacted);
        assert_eq!(summaries[0].body, "");
    }

    #[tokio::test]
    async fn two_reactions_aggregate_into_one_group_with_count_two() {
        let original_id = event_id!("$original");
        let original = factory()
            .text_msg("hello")
            .sender(&ALICE)
            .event_id(original_id)
            .into_raw_sync();
        let reaction_a = factory()
            .reaction(original_id, "👍".to_string())
            .sender(&ALICE)
            .into_raw_sync();
        let reaction_b = factory()
            .reaction(original_id, "👍".to_string())
            .sender(&BOB)
            .into_raw_sync();

        let summaries = summaries_for(vec![original, reaction_a, reaction_b]).await;

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].reactions.len(), 1);
        assert_eq!(summaries[0].reactions[0].key, "👍");
        assert_eq!(summaries[0].reactions[0].count, 2);
    }

    #[tokio::test]
    async fn reply_carries_a_reply_ref_to_the_target() {
        let original_id = event_id!("$original");
        let original = factory()
            .text_msg("hello")
            .sender(&ALICE)
            .event_id(original_id)
            .into_raw_sync();
        let reply = factory()
            .text_msg("hi back")
            .sender(&BOB)
            .event_id(event_id!("$reply"))
            .reply_to(original_id)
            .into_raw_sync();

        let summaries = summaries_for(vec![original, reply]).await;

        assert_eq!(summaries.len(), 2);
        let reply_summary = summaries.iter().find(|m| m.body == "hi back").unwrap();
        let reply_ref = reply_summary.in_reply_to.as_ref().expect("has a reply ref");
        assert_eq!(reply_ref.sender, ALICE.to_string());
        assert_eq!(reply_ref.preview, "hello");
    }

    #[tokio::test]
    async fn ignores_events_that_are_not_room_messages() {
        let member_event = factory().member(&ALICE).sender(&ALICE).into_raw_sync();

        let summaries = summaries_for(vec![member_event]).await;
        assert!(summaries.is_empty());
    }

    #[tokio::test]
    async fn empty_snapshot_maps_to_no_summaries() {
        let items: Vector<Arc<TimelineItem>> = Vector::new();
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        assert!(items_to_summaries(&items, None, &client, None)
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn resolves_sender_display_name_once_the_members_profile_is_known() {
        let member_event = factory()
            .member(&ALICE)
            .display_name("Alice A.")
            .sender(&ALICE)
            .into_raw_sync();
        let message = factory()
            .text_msg("hello")
            .sender(&ALICE)
            .event_id(event_id!("$with-profile"))
            .into_raw_sync();

        let summaries = summaries_for_batches(vec![vec![member_event], vec![message]]).await;

        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].sender_display_name.as_deref(),
            Some("Alice A.")
        );
    }

    #[tokio::test]
    async fn sender_display_name_is_none_when_the_profile_never_resolves() {
        let summaries = summaries_for(vec![factory()
            .text_msg("hello")
            .sender(&ALICE)
            .event_id(event_id!("$no-profile"))
            .into_raw_sync()])
        .await;

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].sender_display_name, None);
        assert_eq!(summaries[0].sender_avatar_url, None);
        assert_eq!(summaries[0].sender_avatar_path, None);
    }

    /// Two members sharing a display name must be disambiguated (per the
    /// Matrix spec) before it's shown as a sender label, or one could pick a
    /// name matching another member's to impersonate them.
    #[tokio::test]
    async fn disambiguates_sender_display_name_shared_with_another_member() {
        let alice_member = factory()
            .member(&ALICE)
            .display_name("Alex")
            .sender(&ALICE)
            .into_raw_sync();
        let bob_member = factory()
            .member(&BOB)
            .display_name("Alex")
            .sender(&BOB)
            .into_raw_sync();
        let message = factory()
            .text_msg("hello")
            .sender(&ALICE)
            .event_id(event_id!("$ambiguous-name"))
            .into_raw_sync();

        let summaries =
            summaries_for_batches(vec![vec![alice_member, bob_member], vec![message]]).await;

        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].sender_display_name.as_deref(),
            Some(format!("Alex ({})", *ALICE).as_str())
        );
    }
}
