use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncTimelineEvent};
use matrix_sdk::ruma::RoomId;
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use super::MatrixState;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomMessageSummary {
    pub event_id: String,
    pub sender: String,
    pub body: String,
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

/// Text `m.room.message` events only, oldest/newest order preserved from the
/// input slice — other msgtypes (images, etc.) are a later timeline-rendering
/// pass, same scope note as `get_timeline_page`.
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
            Some(RoomMessageSummary {
                event_id: original.event_id.to_string(),
                sender: original.sender.to_string(),
                body: original.content.body().to_string(),
                timestamp_ms: original.origin_server_ts.0.into(),
            })
        })
        .collect()
}

/// Cursor-based pagination over a room's message history, oldest-not-included:
/// each call walks backward from `cursor` (or the live end of the timeline if
/// `cursor` is `None`). Text messages only for this first cut — images/other
/// msgtypes are a later timeline-rendering pass.
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
