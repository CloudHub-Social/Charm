use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::RoomId;
use tauri::State;

use super::MatrixState;

/// Queues a plain-text message for sending via matrix-rust-sdk's send queue.
/// This returns as soon as the event is queued, not once the homeserver has
/// accepted it — the send queue handles the network round-trip, retries, and
/// offline queueing on its own. No local-echo event is pushed back to the
/// frontend yet; callers currently re-fetch the timeline page after sending.
#[tauri::command]
pub async fn send_message(
    state: State<'_, MatrixState>,
    room_id: String,
    body: String,
) -> Result<(), String> {
    let client = state.require_client().await?;

    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    let content =
        AnyMessageLikeEventContent::RoomMessage(RoomMessageEventContent::text_plain(body));
    room.send_queue()
        .send(content)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
