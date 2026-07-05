use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::RoomId;
use matrix_sdk::send_queue::RoomSendQueueUpdate;
use matrix_sdk::{Client, Room};
use tauri::State;

use super::MatrixState;

/// Queues `content` on `room`'s send queue and returns the SDK-generated
/// transaction id for the resulting local echo.
///
/// matrix-rust-sdk 0.18's `SendHandle` (the `Ok` value of
/// `RoomSendQueue::send`) doesn't expose a public transaction-id getter —
/// unlike `SendReactionHandle`/`SendRedactionHandle`, which do — so the only
/// way to observe the id a given `send()` call was assigned is to subscribe
/// to the client-wide send-queue update stream *before* calling `send()` and
/// read off the `NewLocalEvent` broadcast that `send()` itself triggers
/// (synchronously, before it returns) for this room. This id is what lets a
/// synced event (`unsigned.transaction_id`, see `timeline::events_to_summaries`)
/// and the send-queue's own `pending`/`sent`/`error` updates
/// (`send_queue:update`) both key back to the same local echo the frontend
/// created — without it, none of the three ever agree, so the echo never
/// reconciles with the real event and never leaves "pending".
///
/// Subscribing right before `send()` and taking the first matching
/// `NewLocalEvent` is safe for the common case (one composer, one send at a
/// time) but isn't airtight against a genuinely concurrent send to the same
/// room racing in between — a known, low-probability limitation of working
/// around the missing getter rather than a fundamental design issue.
pub async fn send_and_capture_transaction_id(
    client: &Client,
    room: &Room,
    content: AnyMessageLikeEventContent,
) -> Result<String, String> {
    let mut updates = client.send_queue().subscribe();
    let target_room_id = room.room_id().to_owned();

    room.send_queue()
        .send(content)
        .await
        .map_err(|e| e.to_string())?;

    loop {
        match updates.recv().await {
            Ok(update) if update.room_id == target_room_id => {
                if let RoomSendQueueUpdate::NewLocalEvent(echo) = update.update {
                    return Ok(echo.transaction_id.to_string());
                }
            }
            Ok(_) => continue,
            Err(_) => {
                return Err("send queue closed before the local echo could be observed".to_string())
            }
        }
    }
}

/// Queues a plain-text message for sending via matrix-rust-sdk's send queue.
/// This returns as soon as the event is queued, not once the homeserver has
/// accepted it — the send queue handles the network round-trip, retries, and
/// offline queueing on its own. Returns the SDK's transaction id (see
/// [`send_and_capture_transaction_id`]) so the frontend can key its optimistic
/// echo the same way the synced event and `send_queue:update` will.
#[tauri::command]
pub async fn send_message(
    state: State<'_, MatrixState>,
    room_id: String,
    body: String,
) -> Result<String, String> {
    let client = state.require_client().await?;

    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    let content =
        AnyMessageLikeEventContent::RoomMessage(RoomMessageEventContent::text_plain(body));
    send_and_capture_transaction_id(&client, &room, content).await
}
