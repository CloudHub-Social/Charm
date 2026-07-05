//! End-to-end proof that read receipts and typing notices actually round-trip
//! over a real homeserver — two independent matrix-rust-sdk clients
//! (simulating two devices/users), no mocking. Mirrors
//! `tests/verification_flow.rs`'s two-client harness. Requires a local
//! Synapse (`dev/synapse/` locally, a GitHub Actions service container in
//! CI) with a room shared by both test users and the test user from
//! `tests/common` already registered.
//!
//! See the `recursion_limit` comment in `src/lib.rs` — this test crate hits
//! the same trait-solver overflow proving Send-ness through
//! matrix-sdk-crypto's instrumented Store trait when it spawns sync loops.
#![recursion_limit = "512"]

mod common;

use std::time::Duration;

use charm_lib::matrix::ephemeral::{receipt_content_to_updates, typing_content_to_user_ids};
use common::synced_client;
use matrix_sdk::room::Receipts;
use matrix_sdk::ruma::events::AnySyncEphemeralRoomEvent;
use tokio::time::timeout;

const POLL_TIMEOUT: Duration = Duration::from_secs(15);

/// Both directions of Spec 05's ephemeral-event plumbing against a real
/// homeserver: sending a read receipt and a typing notice from one client,
/// and observing the raw `m.receipt`/`m.typing` ephemeral events land in the
/// other client's sync response in a shape `receipt_content_to_updates` /
/// `typing_content_to_user_ids` can flatten. This intentionally exercises the
/// same mapper functions unit-tested in `src/matrix/ephemeral.rs`, just fed
/// with real server data instead of hand-built fixtures.
#[tokio::test]
async fn read_receipt_and_typing_notice_round_trip_between_two_clients() {
    let sender = synced_client().await;
    let observer = synced_client().await;

    let room_id = sender
        .rooms()
        .first()
        .expect("sender is joined to at least one room shared with the observer")
        .room_id()
        .to_owned();

    let sender_room = sender.get_room(&room_id).expect("room known to sender");
    let latest_event_id = timeout(POLL_TIMEOUT, async {
        loop {
            if let Some(event_id) = sender_room.latest_event().event_id() {
                return event_id;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("room has at least one event to receipt");

    // Send a public read receipt + typing notice from `sender`.
    sender_room
        .send_multiple_receipts(Receipts::new().public_read_receipt(latest_event_id.clone()))
        .await
        .expect("send read receipt");
    sender_room
        .typing_notice(true)
        .await
        .expect("send typing notice");

    // Poll `observer`'s sync until both ephemeral events show up for the room.
    let (mut seen_receipt, mut seen_typing) = (false, false);
    timeout(POLL_TIMEOUT, async {
        loop {
            let response = observer
                .sync_once(matrix_sdk::config::SyncSettings::default())
                .await
                .expect("sync");

            if let Some(update) = response.rooms.joined.get(&room_id) {
                for raw_event in &update.ephemeral {
                    match raw_event.deserialize() {
                        Ok(AnySyncEphemeralRoomEvent::Receipt(event)) => {
                            let updates = receipt_content_to_updates(&event.content);
                            if updates
                                .iter()
                                .any(|u| u.event_id == latest_event_id.as_str())
                            {
                                seen_receipt = true;
                            }
                        }
                        Ok(AnySyncEphemeralRoomEvent::Typing(event)) => {
                            let user_ids =
                                typing_content_to_user_ids(&event.content, observer.user_id());
                            if !user_ids.is_empty() {
                                seen_typing = true;
                            }
                        }
                        _ => {}
                    }
                }
            }

            if seen_receipt && seen_typing {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("observed both a receipt and a typing notice before the timeout");

    assert!(
        seen_receipt,
        "expected the observer to see the read receipt"
    );
    assert!(
        seen_typing,
        "expected the observer to see the typing notice"
    );
}
