use std::sync::Arc;

use imbl::Vector;
use matrix_sdk::ruma::events::room::message::{MessageFormat, MessageType};
use matrix_sdk::ruma::{RoomId, UserId};
use matrix_sdk_ui::timeline::{
    EventSendState, EventTimelineItem, MsgLikeKind, Timeline, TimelineDetails, TimelineItem,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use ts_rs::TS;

use super::MatrixState;

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
pub fn items_to_summaries(
    items: &Vector<Arc<TimelineItem>>,
    own_user_id: Option<&UserId>,
) -> Vec<RoomMessageSummary> {
    items
        .iter()
        .filter_map(|item: &Arc<TimelineItem>| item.as_event())
        .filter_map(|item| timeline_item_to_summary(item, own_user_id))
        .collect()
}

/// Maps one `EventTimelineItem` to a `RoomMessageSummary`, keeping the DTO
/// shape Spec 02/03 established stable. See the module-level doc for the
/// per-field mapping rationale.
fn timeline_item_to_summary(
    item: &EventTimelineItem,
    own_user_id: Option<&UserId>,
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
        let (sender, preview) = match &reply.event {
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
                (embedded.sender.to_string(), preview)
            }
            // Not yet resolved (or resolution failed) — the target may not be
            // loaded in this timeline's window; render an empty preview
            // rather than blocking the whole summary on a fetch.
            _ => (String::new(), String::new()),
        };
        ReplyRef {
            event_id: reply.event_id.to_string(),
            sender,
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

    match &msglike.kind {
        MsgLikeKind::Message(message) => Some(RoomMessageSummary {
            event_id,
            sender,
            body: message.body().to_string(),
            formatted_body: formatted_html_body(message.msgtype()),
            timestamp_ms,
            edited: message.is_edited(),
            redacted: false,
            reactions,
            in_reply_to,
            transaction_id,
            send_state,
            media: message_type_to_media(message.msgtype()),
        }),
        MsgLikeKind::Redacted => Some(RoomMessageSummary {
            event_id,
            sender,
            body: String::new(),
            formatted_body: None,
            timestamp_ms,
            edited: false,
            redacted: true,
            reactions: Vec::new(),
            in_reply_to: None,
            transaction_id,
            send_state,
            media: None,
        }),
        // Decryption retries land as a fresh diff once the key arrives — see
        // `Timeline::retry_decryption`, invoked by matrix-sdk-ui's own crypto
        // plumbing when new room keys come in — which re-emits this item with
        // real `MsgLikeKind::Message` content, replacing this placeholder in
        // place via the normal diff -> re-snapshot -> `timeline:update` path.
        MsgLikeKind::UnableToDecrypt(_) => Some(RoomMessageSummary {
            event_id,
            sender,
            body: "Unable to decrypt message".to_string(),
            formatted_body: None,
            timestamp_ms,
            edited: false,
            redacted: false,
            reactions,
            in_reply_to,
            transaction_id,
            send_state,
            media: None,
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
    own_user_id: Option<matrix_sdk::ruma::OwnedUserId>,
) {
    use futures_util::StreamExt;

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

        let _ = app.emit(
            "timeline:update",
            RoomTimelineUpdate {
                room_id: room_id.to_string(),
                messages: items_to_summaries(&items, own_user_id.as_deref()),
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
            let _ = app.emit(
                "timeline:update",
                RoomTimelineUpdate {
                    room_id: room_id.to_string(),
                    messages: items_to_summaries(&items, own_user_id.as_deref()),
                },
            );
        }
    });
}

/// Cursor-based pagination over a room's message history, oldest-not-included:
/// each call walks backward from wherever this room's live `Timeline` (see
/// `MatrixState::get_or_create_timeline`) currently is. Unlike the pre-Spec-14
/// `MessagesOptions::backward()` cursor, this has no opaque server-side token
/// any more — see [`TimelinePage::next_cursor`]'s doc comment for the sentinel
/// this now is. `cursor` is accepted (and ignored) purely to keep the
/// frontend's `getTimelinePage(roomId, cursor, limit)` call shape stable.
#[tauri::command]
pub async fn get_timeline_page(
    app: AppHandle,
    state: State<'_, MatrixState>,
    room_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<TimelinePage, String> {
    let _ = cursor;
    let client = state.require_client().await?;
    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;

    let timeline = state
        .get_or_create_timeline(&app, &client, &parsed_room_id)
        .await?;

    let requested = limit.unwrap_or(30);
    let num_events = u16::try_from(requested).unwrap_or(u16::MAX);
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
        messages: items_to_summaries(&items, own_user_id.as_deref()),
        next_cursor: if hit_start {
            None
        } else {
            Some("more".to_string())
        },
    })
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
        items_to_summaries(&items, own_user_id.as_deref())
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

    #[test]
    fn empty_snapshot_maps_to_no_summaries() {
        let items: Vector<Arc<TimelineItem>> = Vector::new();
        assert!(items_to_summaries(&items, None).is_empty());
    }
}
