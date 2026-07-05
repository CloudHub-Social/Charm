use matrix_sdk::room::Receipts;
use matrix_sdk::ruma::events::receipt::{ReceiptEventContent, ReceiptThread};
use matrix_sdk::ruma::events::typing::TypingEventContent;
use matrix_sdk::ruma::{OwnedEventId, RoomId, UserId};
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use super::MatrixState;

/// One user's receipt on one event, flattened out of the nested
/// `ReceiptEventContent` map for the frontend. Only `Read`/`ReadPrivate`
/// receipts are surfaced here — `FullyRead` is a private per-user marker, not
/// something rendered as another user's avatar.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct EventReceipt {
    pub event_id: String,
    pub user_id: String,
    pub receipt_type: ReceiptTypeDto,
    // Milliseconds since epoch stays well within JS's safe-integer range; emit `number`
    // rather than ts-rs's default `bigint` so the frontend can use it directly.
    #[ts(type = "number")]
    pub ts_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum ReceiptTypeDto {
    Read,
    ReadPrivate,
}

/// Pushed to the frontend whenever a sync response carries `m.receipt`
/// ephemeral events for a room.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct ReceiptUpdate {
    pub room_id: String,
    pub receipts: Vec<EventReceipt>,
}

/// Pushed to the frontend whenever a sync response carries an `m.typing`
/// ephemeral event for a room. `m.typing` is always a full replace (the set
/// of currently-typing users), never a delta, so this event is too.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct TypingUpdate {
    pub room_id: String,
    pub user_ids: Vec<String>,
}

/// Flattens a sync `m.receipt` event's content into per-event, per-user
/// entries, keeping only `Read`/`ReadPrivate` (a `FullyRead` marker is a
/// private per-user pointer, not another user's read state to display).
///
/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/ephemeral.rs`, same rationale as [`super::resolve_alias`].
pub fn receipt_content_to_updates(content: &ReceiptEventContent) -> Vec<EventReceipt> {
    let mut receipts = Vec::new();

    for (event_id, by_type) in content.iter() {
        for (receipt_type, by_user) in by_type {
            let dto = match receipt_type.to_string().as_str() {
                "m.read" => ReceiptTypeDto::Read,
                "m.read.private" => ReceiptTypeDto::ReadPrivate,
                _ => continue,
            };

            for (user_id, receipt) in by_user {
                if receipt.thread != ReceiptThread::Main
                    && receipt.thread != ReceiptThread::Unthreaded
                {
                    // Threaded receipts are out of scope for Spec 05 (main timeline only).
                    continue;
                }
                // `js_int::UInt` only has a `From` impl into `i64`/`i128`, not `u64` directly —
                // safe here since a millisecond timestamp is always non-negative and well
                // within both ranges.
                let ts_ms = receipt
                    .ts
                    .map(|ts| i64::from(ts.0) as u64)
                    .unwrap_or_default();
                receipts.push(EventReceipt {
                    event_id: event_id.to_string(),
                    user_id: user_id.to_string(),
                    receipt_type: dto,
                    ts_ms,
                });
            }
        }
    }

    receipts
}

/// Filters `m.typing` user ids down to everyone but `own_user_id`, so a
/// client never renders its own typing state back at itself.
///
/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/ephemeral.rs`, same rationale as [`super::resolve_alias`].
pub fn typing_content_to_user_ids(
    content: &TypingEventContent,
    own_user_id: Option<&UserId>,
) -> Vec<String> {
    content
        .user_ids
        .iter()
        .filter(|user_id| Some(user_id.as_ref()) != own_user_id)
        .map(|user_id| user_id.to_string())
        .collect()
}

fn parse_room(client: &matrix_sdk::Client, room_id: &str) -> Result<matrix_sdk::Room, String> {
    let parsed_room_id = RoomId::parse(room_id).map_err(|e| e.to_string())?;
    client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))
}

/// Sends a read receipt (public or private) plus the `m.fully_read` marker to
/// `event_id` in one batched request — always both, never just the receipt,
/// so a caller can't accidentally advance the read receipt without also
/// clearing the "jump to unread" fully-read marker Spec 06 depends on.
#[tauri::command]
pub async fn send_read_receipt(
    state: State<'_, MatrixState>,
    room_id: String,
    event_id: String,
    private: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let room = parse_room(&client, &room_id)?;
    let parsed_event_id = OwnedEventId::try_from(event_id).map_err(|e| e.to_string())?;

    let mut receipts = Receipts::new().fully_read_marker(parsed_event_id.clone());
    receipts = if private {
        receipts.private_read_receipt(parsed_event_id)
    } else {
        receipts.public_read_receipt(parsed_event_id)
    };

    room.send_multiple_receipts(receipts)
        .await
        .map_err(|e| e.to_string())
}

/// Sends (or stops) our own `m.typing` notice for a room. The SDK
/// deduplicates/refreshes the EDU timeout internally, so this is safe to call
/// on every keystroke.
#[tauri::command]
pub async fn send_typing(
    state: State<'_, MatrixState>,
    room_id: String,
    typing: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let room = parse_room(&client, &room_id)?;
    room.typing_notice(typing).await.map_err(|e| e.to_string())
}

/// Convenience command used both when a room becomes active and by the
/// room-list "mark read" action: resolves the latest event in the room and
/// sends a public read receipt + fully-read marker to it.
#[tauri::command]
pub async fn mark_room_read(state: State<'_, MatrixState>, room_id: String) -> Result<(), String> {
    let client = state.require_client().await?;
    let room = parse_room(&client, &room_id)?;

    let Some(latest_event_id) = room.latest_event().event_id() else {
        // Nothing synced yet for this room — nothing to mark read.
        return Ok(());
    };

    let receipts = Receipts::new()
        .fully_read_marker(latest_event_id.clone())
        .public_read_receipt(latest_event_id);

    room.send_multiple_receipts(receipts)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::ruma::events::receipt::{Receipt, Receipts as RumaReceipts};
    use matrix_sdk::ruma::{event_id, user_id, MilliSecondsSinceUnixEpoch};
    use std::collections::BTreeMap;

    /// `Receipt` is `#[non_exhaustive]`, so tests build one via `Receipt::new`
    /// (which always sets `thread: Unthreaded`) and then override `thread`
    /// afterward when a test needs a different one.
    fn receipt_at(ts_ms: i64, thread: ReceiptThread) -> Receipt {
        let mut receipt = Receipt::new(MilliSecondsSinceUnixEpoch(
            matrix_sdk::ruma::UInt::try_from(ts_ms).unwrap(),
        ));
        receipt.thread = thread;
        receipt
    }

    #[test]
    fn flattens_read_and_read_private_receipts() {
        let event_id = event_id!("$event1:example.com").to_owned();
        let user_a = user_id!("@alice:example.com").to_owned();
        let user_b = user_id!("@bob:example.com").to_owned();

        let mut by_user_read = BTreeMap::new();
        by_user_read.insert(user_a, receipt_at(1000, ReceiptThread::Main));
        let mut by_user_private = BTreeMap::new();
        by_user_private.insert(user_b, receipt_at(2000, ReceiptThread::Unthreaded));

        let mut by_type: RumaReceipts = BTreeMap::new();
        by_type.insert(
            matrix_sdk::ruma::events::receipt::ReceiptType::Read,
            by_user_read,
        );
        by_type.insert(
            matrix_sdk::ruma::events::receipt::ReceiptType::ReadPrivate,
            by_user_private,
        );

        let mut content_map = BTreeMap::new();
        content_map.insert(event_id, by_type);
        let content = ReceiptEventContent(content_map);

        let mut updates = receipt_content_to_updates(&content);
        updates.sort_by_key(|r| r.ts_ms);

        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].user_id, "@alice:example.com");
        assert!(matches!(updates[0].receipt_type, ReceiptTypeDto::Read));
        assert_eq!(updates[1].user_id, "@bob:example.com");
        assert!(matches!(
            updates[1].receipt_type,
            ReceiptTypeDto::ReadPrivate
        ));
    }

    #[test]
    fn skips_threaded_receipts() {
        let event_id = event_id!("$event1:example.com").to_owned();
        let user_a = user_id!("@alice:example.com").to_owned();

        let thread_id = event_id!("$thread1:example.com").to_owned();
        let mut by_user = BTreeMap::new();
        by_user.insert(user_a, receipt_at(1000, ReceiptThread::Thread(thread_id)));
        let mut by_type: RumaReceipts = BTreeMap::new();
        by_type.insert(
            matrix_sdk::ruma::events::receipt::ReceiptType::Read,
            by_user,
        );
        let mut content_map = BTreeMap::new();
        content_map.insert(event_id, by_type);
        let content = ReceiptEventContent(content_map);

        assert!(receipt_content_to_updates(&content).is_empty());
    }

    #[test]
    fn filters_own_user_out_of_typing() {
        let alice = user_id!("@alice:example.com");
        let bob = user_id!("@bob:example.com");
        let content = TypingEventContent::new(vec![alice.to_owned(), bob.to_owned()]);

        let user_ids = typing_content_to_user_ids(&content, Some(alice));
        assert_eq!(user_ids, vec!["@bob:example.com".to_string()]);
    }

    #[test]
    fn keeps_all_users_when_own_id_unknown() {
        let alice = user_id!("@alice:example.com");
        let content = TypingEventContent::new(vec![alice.to_owned()]);

        let user_ids = typing_content_to_user_ids(&content, None);
        assert_eq!(user_ids, vec!["@alice:example.com".to_string()]);
    }
}
