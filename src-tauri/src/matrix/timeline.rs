use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::events::room::message::MessageType;
use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncTimelineEvent};
use matrix_sdk::ruma::RoomId;
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use super::media::{self, MediaHandle};
use super::MatrixState;

/// Tagged union carrying msgtype + media metadata for a message event —
/// generalizes the old flat `body: String` (kept below on
/// [`RoomMessageSummary`] for text-preview/room-list use, additively) so the
/// timeline can render non-text msgtypes.
///
/// Media variants carry a [`MediaHandle`] (opaque, serialized
/// `MediaSource`), never the raw `EncryptedFile` — that would leak the AES
/// key across IPC. `resolve_media` turns a handle into a local file path.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "type")]
pub enum MessageContent {
    Text {
        body: String,
    },
    Image {
        body: String,
        source: MediaHandle,
        mime: Option<String>,
        #[ts(type = "number | null")]
        size: Option<u64>,
        #[ts(type = "number | null")]
        width: Option<u32>,
        #[ts(type = "number | null")]
        height: Option<u32>,
        thumbnail: Option<MediaHandle>,
        blurhash: Option<String>,
    },
    Video {
        body: String,
        source: MediaHandle,
        mime: Option<String>,
        #[ts(type = "number | null")]
        size: Option<u64>,
        #[ts(type = "number | null")]
        width: Option<u32>,
        #[ts(type = "number | null")]
        height: Option<u32>,
        #[ts(type = "number | null")]
        duration_ms: Option<u64>,
        thumbnail: Option<MediaHandle>,
    },
    Audio {
        body: String,
        source: MediaHandle,
        mime: Option<String>,
        #[ts(type = "number | null")]
        size: Option<u64>,
        #[ts(type = "number | null")]
        duration_ms: Option<u64>,
    },
    File {
        body: String,
        source: MediaHandle,
        mime: Option<String>,
        #[ts(type = "number | null")]
        size: Option<u64>,
    },
}

impl MessageContent {
    /// A plain-text preview usable for room-list previews or notifications,
    /// regardless of variant.
    fn preview_body(&self) -> &str {
        match self {
            MessageContent::Text { body }
            | MessageContent::Image { body, .. }
            | MessageContent::Video { body, .. }
            | MessageContent::Audio { body, .. }
            | MessageContent::File { body, .. } => body,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomMessageSummary {
    pub event_id: String,
    pub sender: String,
    /// Text-preview/room-list use — kept for backwards compatibility
    /// alongside `content`, which carries the full tagged-union payload.
    pub body: String,
    pub content: MessageContent,
    // Milliseconds since epoch stays well within JS's safe-integer range; emit `number`
    // rather than ts-rs's default `bigint` so the frontend can use it directly.
    #[ts(type = "number")]
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct TimelinePage {
    pub messages: Vec<RoomMessageSummary>,
    /// Pass back as `cursor` to fetch the page further back in history.
    pub next_cursor: Option<String>,
}

/// Pushed to the frontend whenever a sync response brings new timeline events
/// for a room the client is joined to — so a room's message list can update
/// live without the frontend re-fetching a `TimelinePage` after every sync.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomTimelineUpdate {
    pub room_id: String,
    pub messages: Vec<RoomMessageSummary>,
}

/// All `m.room.message` events, oldest/newest order preserved from the input
/// slice — every `msgtype` (`m.text`, `m.image`, `m.video`, `m.audio`,
/// `m.file`, `m.notice`, `m.emote`, ...) is carried through as a
/// [`MessageContent`] variant; unrecognized/exotic msgtypes fall back to a
/// `Text` variant using Ruma's own `.body()` so nothing is silently dropped.
pub(crate) fn events_to_summaries(events: &[TimelineEvent]) -> Vec<RoomMessageSummary> {
    events
        .iter()
        .filter_map(|event| {
            let raw = event.kind.raw();
            let deserialized: AnySyncTimelineEvent = raw.deserialize().ok()?;
            let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(msg)) =
                deserialized
            else {
                return None;
            };
            let original = msg.as_original()?;
            let content = message_type_to_content(&original.content.msgtype);
            Some(RoomMessageSummary {
                event_id: original.event_id.to_string(),
                sender: original.sender.to_string(),
                body: content.preview_body().to_string(),
                content,
                timestamp_ms: original.origin_server_ts.0.into(),
            })
        })
        .collect()
}

/// Converts Ruma's `MessageType` into our own [`MessageContent`], the shape
/// exposed to the frontend over IPC. Media variants serialize their
/// `MediaSource` into an opaque [`MediaHandle`] — never the raw
/// `EncryptedFile`, which carries the AES key.
fn message_type_to_content(msgtype: &MessageType) -> MessageContent {
    match msgtype {
        MessageType::Image(image) => MessageContent::Image {
            body: image.body.clone(),
            source: media::media_source_to_handle(&image.source).unwrap_or_default(),
            mime: image.info.as_ref().and_then(|i| i.mimetype.clone()),
            size: image.info.as_ref().and_then(|i| i.size).map(u64::from),
            width: image
                .info
                .as_ref()
                .and_then(|i| i.width)
                .map(|w| u64::from(w) as u32),
            height: image
                .info
                .as_ref()
                .and_then(|i| i.height)
                .map(|h| u64::from(h) as u32),
            thumbnail: image
                .info
                .as_ref()
                .and_then(|i| i.thumbnail_source.as_ref())
                .and_then(|s| media::media_source_to_handle(s).ok()),
            blurhash: None,
        },
        MessageType::Video(video) => MessageContent::Video {
            body: video.body.clone(),
            source: media::media_source_to_handle(&video.source).unwrap_or_default(),
            mime: video.info.as_ref().and_then(|i| i.mimetype.clone()),
            size: video.info.as_ref().and_then(|i| i.size).map(u64::from),
            width: video
                .info
                .as_ref()
                .and_then(|i| i.width)
                .map(|w| u64::from(w) as u32),
            height: video
                .info
                .as_ref()
                .and_then(|i| i.height)
                .map(|h| u64::from(h) as u32),
            duration_ms: video
                .info
                .as_ref()
                .and_then(|i| i.duration)
                .map(|d| d.as_millis() as u64),
            thumbnail: video
                .info
                .as_ref()
                .and_then(|i| i.thumbnail_source.as_ref())
                .and_then(|s| media::media_source_to_handle(s).ok()),
        },
        MessageType::Audio(audio) => MessageContent::Audio {
            body: audio.body.clone(),
            source: media::media_source_to_handle(&audio.source).unwrap_or_default(),
            mime: audio.info.as_ref().and_then(|i| i.mimetype.clone()),
            size: audio.info.as_ref().and_then(|i| i.size).map(u64::from),
            duration_ms: audio
                .info
                .as_ref()
                .and_then(|i| i.duration)
                .map(|d| d.as_millis() as u64),
        },
        MessageType::File(file) => MessageContent::File {
            body: file.body.clone(),
            source: media::media_source_to_handle(&file.source).unwrap_or_default(),
            mime: file.info.as_ref().and_then(|i| i.mimetype.clone()),
            size: file.info.as_ref().and_then(|i| i.size).map(u64::from),
        },
        // Text, Notice, Emote, and anything else fall back to a plain text
        // preview via Ruma's own body accessor — this is what stops
        // non-text-but-not-yet-modeled msgtypes from being dropped entirely.
        other => MessageContent::Text {
            body: other.body().to_string(),
        },
    }
}

/// Cursor-based pagination over a room's message history, oldest-not-included:
/// each call walks backward from `cursor` (or the live end of the timeline if
/// `cursor` is `None`).
#[tauri::command]
pub async fn get_timeline_page(
    state: State<'_, MatrixState>,
    room_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<TimelinePage, String> {
    let client = state.require_client().await?;

    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    let mut options = MessagesOptions::backward().from(cursor.as_deref());
    options.limit = limit.unwrap_or(30).into();

    let response = room.messages(options).await.map_err(|e| e.to_string())?;

    Ok(TimelinePage {
        messages: events_to_summaries(&response.chunk),
        next_cursor: response.end,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::deserialized_responses::TimelineEvent;
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{event_id, room_id, user_id};
    use serde_json::json;

    /// Builds a synthetic `m.room.message` `TimelineEvent` from a raw JSON
    /// body, the same shape a real sync response would carry.
    fn make_event(content: serde_json::Value) -> TimelineEvent {
        let raw_event = json!({
            "type": "m.room.message",
            "event_id": event_id!("$test_event").to_string(),
            "sender": user_id!("@alice:localhost").to_string(),
            "origin_server_ts": 1_700_000_000_000u64,
            "room_id": room_id!("!room:localhost").to_string(),
            "content": content,
        });
        let raw_json = serde_json::value::to_raw_value(&raw_event).unwrap();
        let raw: Raw<AnySyncTimelineEvent> = Raw::from_json(raw_json);
        TimelineEvent::from_plaintext(raw)
    }

    #[test]
    fn emits_text_variant_for_a_text_message() {
        let event = make_event(json!({
            "msgtype": "m.text",
            "body": "hello there",
        }));

        let summaries = events_to_summaries(std::slice::from_ref(&event));
        assert_eq!(summaries.len(), 1);
        let summary = &summaries[0];
        assert_eq!(summary.body, "hello there");
        match &summary.content {
            MessageContent::Text { body } => assert_eq!(body, "hello there"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn emits_image_variant_for_an_image_message() {
        let event = make_event(json!({
            "msgtype": "m.image",
            "body": "cat.png",
            "url": "mxc://example.org/abc123",
            "info": {
                "mimetype": "image/png",
                "size": 1024,
                "w": 800,
                "h": 600,
            },
        }));

        let summaries = events_to_summaries(std::slice::from_ref(&event));
        assert_eq!(summaries.len(), 1);
        match &summaries[0].content {
            MessageContent::Image {
                body,
                mime,
                size,
                width,
                height,
                ..
            } => {
                assert_eq!(body, "cat.png");
                assert_eq!(mime.as_deref(), Some("image/png"));
                assert_eq!(*size, Some(1024));
                assert_eq!(*width, Some(800));
                assert_eq!(*height, Some(600));
            }
            other => panic!("expected Image, got {other:?}"),
        }
    }

    #[test]
    fn emits_file_variant_for_a_file_message() {
        let event = make_event(json!({
            "msgtype": "m.file",
            "body": "report.pdf",
            "url": "mxc://example.org/def456",
            "info": {
                "mimetype": "application/pdf",
                "size": 4096,
            },
        }));

        let summaries = events_to_summaries(std::slice::from_ref(&event));
        assert_eq!(summaries.len(), 1);
        match &summaries[0].content {
            MessageContent::File {
                body, mime, size, ..
            } => {
                assert_eq!(body, "report.pdf");
                assert_eq!(mime.as_deref(), Some("application/pdf"));
                assert_eq!(*size, Some(4096));
            }
            other => panic!("expected File, got {other:?}"),
        }
    }

    #[test]
    fn emits_audio_variant_with_duration_for_an_audio_message() {
        let event = make_event(json!({
            "msgtype": "m.audio",
            "body": "voice.ogg",
            "url": "mxc://example.org/ghi789",
            "info": {
                "mimetype": "audio/ogg",
                "size": 2048,
                "duration": 5000,
            },
        }));

        let summaries = events_to_summaries(std::slice::from_ref(&event));
        match &summaries[0].content {
            MessageContent::Audio { duration_ms, .. } => assert_eq!(*duration_ms, Some(5000)),
            other => panic!("expected Audio, got {other:?}"),
        }
    }

    #[test]
    fn emits_video_variant_for_a_video_message() {
        let event = make_event(json!({
            "msgtype": "m.video",
            "body": "clip.mp4",
            "url": "mxc://example.org/jkl012",
            "info": {
                "mimetype": "video/mp4",
                "size": 8192,
                "w": 1920,
                "h": 1080,
                "duration": 12000,
            },
        }));

        let summaries = events_to_summaries(std::slice::from_ref(&event));
        match &summaries[0].content {
            MessageContent::Video {
                width,
                height,
                duration_ms,
                ..
            } => {
                assert_eq!(*width, Some(1920));
                assert_eq!(*height, Some(1080));
                assert_eq!(*duration_ms, Some(12000));
            }
            other => panic!("expected Video, got {other:?}"),
        }
    }

    #[test]
    fn ignores_events_that_are_not_room_messages() {
        let raw_event = json!({
            "type": "m.room.member",
            "event_id": event_id!("$member_event").to_string(),
            "sender": user_id!("@alice:localhost").to_string(),
            "origin_server_ts": 1_700_000_000_000u64,
            "room_id": room_id!("!room:localhost").to_string(),
            "state_key": "@alice:localhost",
            "content": { "membership": "join" },
        });
        let raw_json = serde_json::value::to_raw_value(&raw_event).unwrap();
        let raw: Raw<AnySyncTimelineEvent> = Raw::from_json(raw_json);
        let event = TimelineEvent::from_plaintext(raw);

        let summaries = events_to_summaries(std::slice::from_ref(&event));
        assert!(summaries.is_empty());
    }
}
