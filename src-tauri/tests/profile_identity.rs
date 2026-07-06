//! Real-network proof of Spec 01 (Timeline identity and profiles): a
//! member's globally-set display name/avatar shows up as resolved sender
//! identity on the timeline, and the room list carries the room's own
//! identity too. Two independent matrix-rust-sdk clients for two distinct
//! users sharing a room, no mocking — mirrors `tests/ephemeral.rs`'s
//! two-client harness. Requires a local Synapse (`dev/synapse/` locally, a
//! GitHub Actions service container in CI) with a room shared by both
//! `tests/common`'s primary and secondary test users, both already
//! registered.
//!
//! Relies on Synapse's standard behavior of propagating a global profile
//! change (`PUT /profile/{userId}/displayname`) onto the `m.room.member`
//! event for every room that user is already joined to — that's what
//! `EventTimelineItem::sender_profile()` (via matrix-sdk-ui) and
//! `Room::heroes()` actually read, not the global profile endpoint directly.
//!
//! See the `recursion_limit` comment in `src/lib.rs` — this test crate hits
//! the same trait-solver overflow proving Send-ness through
//! matrix-sdk-crypto's instrumented Store trait when it spawns sync loops.
#![recursion_limit = "512"]

mod common;

use std::time::Duration;

use charm_lib::matrix::snapshot_rooms;
use charm_lib::matrix::timeline::items_to_summaries;
use common::{synced_client, synced_client_2};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk_ui::timeline::RoomExt;
use tokio::time::timeout;

const POLL_TIMEOUT: Duration = Duration::from_secs(60);

#[tokio::test]
async fn timeline_and_room_list_carry_a_members_set_display_name_and_avatar() {
    let sender = synced_client().await;
    let observer = synced_client_2().await;

    // Either account may be joined to rooms the other isn't (e.g. the
    // primary account's `#alias-test-room` from `register-test-user.sh`) —
    // pick a room id both clients actually agree on, rather than assuming
    // either side's first room is the shared one.
    let observer_room_ids: std::collections::HashSet<_> = observer
        .rooms()
        .iter()
        .map(|room| room.room_id().to_owned())
        .collect();
    let room_id = sender
        .rooms()
        .into_iter()
        .map(|room| room.room_id().to_owned())
        .find(|room_id| observer_room_ids.contains(room_id))
        .expect("sender and observer share at least one room");

    // Distinguish this run's identity from whatever a previous run of this
    // same test (against the same long-lived dev/CI account) may have left
    // set, so a stale-but-matching display name from an earlier run can't
    // produce a false pass.
    let display_name = format!("Spec01 Test {}", std::process::id());
    sender
        .account()
        .set_display_name(Some(&display_name))
        .await
        .expect("set display name");

    let avatar_bytes = format!("spec01-test-avatar-{}", std::process::id()).into_bytes();
    let upload = sender
        .media()
        .upload(&mime::IMAGE_PNG, avatar_bytes, None)
        .await
        .expect("upload avatar");
    sender
        .account()
        .set_avatar_url(Some(&upload.content_uri))
        .await
        .expect("set avatar url");

    let sender_room = sender.get_room(&room_id).expect("room known to sender");
    sender_room
        .send(RoomMessageEventContent::text_plain(
            "hello from the spec 01 identity test",
        ))
        .await
        .expect("send message");

    let observer_room = observer.get_room(&room_id).expect("room known to observer");
    let timeline = observer_room.timeline().await.expect("build timeline");
    let own_user_id = observer.user_id().map(ToOwned::to_owned);
    let sender_user_id = sender.user_id().expect("sender is logged in").to_string();

    timeout(POLL_TIMEOUT, async {
        loop {
            let _ = observer.sync_once(SyncSettings::default()).await;
            let (items, _stream) = timeline.subscribe().await;
            let summaries =
                items_to_summaries(&items, own_user_id.as_deref(), &observer, None).await;

            let resolved = summaries.iter().find(|message| {
                message.sender == sender_user_id
                    && message.sender_display_name.as_deref() == Some(display_name.as_str())
            });
            if let Some(message) = resolved {
                assert_eq!(
                    message.sender_avatar_url.as_deref(),
                    Some(upload.content_uri.as_str()),
                    "resolved sender avatar mxc should match what was set"
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await
    .expect("observed the sender's resolved display name/avatar on the timeline");

    // Sanity check that `snapshot_rooms` (feeding `room_list:update`) also
    // surfaces this room at all — the room-name/avatar-fallback path this
    // spec adds is exercised by the unit tests in `mod.rs`; this just proves
    // the plumbing is wired against a real synced client.
    let room_summaries = snapshot_rooms(&observer, None).await;
    assert!(
        room_summaries.iter().any(|room| room.room_id == room_id),
        "room list should include the shared room"
    );
}
