use matrix_sdk::room::Receipts;
use matrix_sdk::ruma::events::receipt::{ReceiptEventContent, ReceiptThread};
use matrix_sdk::ruma::events::typing::TypingEventContent;
use matrix_sdk::ruma::{OwnedEventId, RoomId, UserId};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use ts_rs::TS;

use super::privacy_settings;
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
    app: AppHandle,
    state: State<'_, MatrixState>,
    room_id: String,
    event_id: String,
    private: bool,
) -> Result<(), String> {
    // Review fix (P1): resolve the client once and derive the privacy
    // settings from that same client, rather than checking settings via
    // `state` (which re-resolves its own client internally) and then
    // separately re-resolving a possibly-different client to send — see
    // `privacy_settings::current_settings_for_client`'s doc comment.
    let client = state.require_client().await?;
    let hide_read_receipts = privacy_settings::current_settings_for_client(&app, &client)
        .await
        .hide_read_receipts;
    send_read_receipt_impl(&client, &room_id, event_id, private, hide_read_receipts).await
}

/// Core logic behind [`send_read_receipt`]. Always sends the
/// `m.fully_read` marker (a private, per-user pointer — never visible to
/// other users, so Spec 40's "hide read receipts" doesn't apply to it and
/// local "jump to unread" tracking keeps working). When `hide_read_receipts`
/// is set, a requested public `m.read` receipt is downgraded to a private
/// `m.read.private` one rather than skipped outright — see this function's
/// own review-fix comment for why dropping it entirely was a bug.
pub async fn send_read_receipt_impl(
    client: &matrix_sdk::Client,
    room_id: &str,
    event_id: String,
    private: bool,
    hide_read_receipts: bool,
) -> Result<(), String> {
    let room = parse_room(client, room_id)?;
    let parsed_event_id = OwnedEventId::try_from(event_id).map_err(|e| e.to_string())?;

    let mut receipts = Receipts::new().fully_read_marker(parsed_event_id.clone());
    // Review fix: this used to skip the receipt entirely whenever
    // `hide_read_receipts` was on, even for a caller that explicitly asked
    // for a *private* receipt (`private: true`) — but `m.read.private` is
    // never visible to other users by definition, so hiding *public*
    // receipts has no reason to also suppress it. `hide_read_receipts` only
    // ever downgrades a requested public receipt to private (matching
    // `mark_room_read_impl`'s identical fallback), never drops the receipt
    // outright — otherwise the user's own homeserver-tracked read position
    // stops advancing at all while hidden, leaving unread/notification
    // counts stuck across sync and other devices.
    receipts = if private || hide_read_receipts {
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
/// If `typing` is `true` and the user has hidden typing indicators (Spec
/// 40), this is a silent no-op — the SDK is never told to send an
/// `m.typing` notice. A `typing=false` call always goes through (harmless
/// even when nothing was started, and ensures a leftover indicator from
/// before the setting was toggled on gets cleared).
#[tauri::command]
pub async fn send_typing(
    app: AppHandle,
    state: State<'_, MatrixState>,
    room_id: String,
    typing: bool,
) -> Result<(), String> {
    // Review fix (P1): same client-snapshot ordering as `send_read_receipt`
    // above.
    let client = state.require_client().await?;
    if typing
        && privacy_settings::current_settings_for_client(&app, &client)
            .await
            .hide_typing
    {
        return Ok(());
    }
    send_typing_impl(&client, &room_id, typing).await
}

/// Core logic behind [`send_typing`].
pub async fn send_typing_impl(
    client: &matrix_sdk::Client,
    room_id: &str,
    typing: bool,
) -> Result<(), String> {
    let room = parse_room(client, room_id)?;
    room.typing_notice(typing).await.map_err(|e| e.to_string())
}

/// Convenience command used both when a room becomes active and by the
/// room-list "mark read" action: resolves the latest event in the room and
/// sends a public read receipt + fully-read marker to it (the receipt is
/// downgraded to private, same as [`send_read_receipt`], when the user has
/// hidden read receipts — the fully-read marker is always sent).
#[tauri::command]
pub async fn mark_room_read(
    app: AppHandle,
    state: State<'_, MatrixState>,
    room_id: String,
) -> Result<(), String> {
    // Review fix (P1): same client-snapshot ordering as `send_read_receipt`
    // above.
    let client = state.require_client().await?;
    let hide_read_receipts = privacy_settings::current_settings_for_client(&app, &client)
        .await
        .hide_read_receipts;
    mark_room_read_impl(&client, &room_id, hide_read_receipts).await
}

/// Core logic behind [`mark_room_read`].
pub async fn mark_room_read_impl(
    client: &matrix_sdk::Client,
    room_id: &str,
    hide_read_receipts: bool,
) -> Result<(), String> {
    let room = parse_room(client, room_id)?;

    let Some(latest_event_id) = room.latest_event().event_id() else {
        // Nothing synced yet for this room — nothing to mark read.
        return Ok(());
    };

    let mut receipts = Receipts::new().fully_read_marker(latest_event_id.clone());
    // Review fix: hiding read receipts must only suppress the *public*
    // `m.read` receipt (visible to other room members) — this previously
    // skipped sending any receipt at all when hidden, including the
    // private `m.read.private` one. `mark_room_read` is what runs on
    // opening a room and from the room-list "mark as read" action, so a
    // user who hid public receipts would stop advancing their own
    // homeserver-tracked read position entirely, leaving unread/
    // notification counts stuck across sync and other devices.
    if hide_read_receipts {
        receipts = receipts.private_read_receipt(latest_event_id);
    } else {
        receipts = receipts.public_read_receipt(latest_event_id);
    }

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

    /// Review fix regression test: same downgrade-not-skip behavior for
    /// `send_read_receipt_impl` when a *public* receipt is requested while
    /// hidden.
    #[tokio::test]
    async fn send_read_receipt_impl_downgrades_a_public_receipt_when_hidden() {
        use matrix_sdk::test_utils::mocks::MatrixMockServer;

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;
        let event_id = matrix_sdk::ruma::owned_event_id!("$event");

        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{room_id}/read_markers"
            )))
            .and(wiremock::matchers::body_partial_json(serde_json::json!({
                "m.read.private": event_id,
            })))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(server.server())
            .await;

        let result =
            send_read_receipt_impl(&client, room_id.as_str(), event_id.to_string(), false, true)
                .await;
        assert!(
            result.is_ok(),
            "expected send-read-receipt to succeed, got {result:?}"
        );
    }
}
