//! Command-boundary proof that edit/redact/react/reply actually round-trip
//! against a real homeserver — no mocking, same pattern as the other
//! integration tests in this directory (each one needs a local Synapse:
//! `dev/synapse/` locally, a GitHub Actions service container in CI).
//!
//! These call the `..._impl(&Client, ...)` core functions directly rather
//! than the `#[tauri::command]` wrappers, since constructing a real
//! `tauri::State<MatrixState>` outside a running Tauri app isn't practical —
//! same rationale as the existing tests in this directory calling e.g.
//! `discover`/`register_with_dummy_auth`/`resolve_alias` instead of their
//! command wrappers.
//!
//! All scenarios run as steps inside a single `#[tokio::test]` against one
//! shared client/room, rather than as separate `#[tokio::test]` functions:
//! Synapse's default `rc_room_creation` rate limit is a small burst
//! allowance (a fresh room per test quickly exhausts it), and the
//! `can_redact` scenario mutates the room's power levels, which would race
//! against other tests running concurrently against the same shared room.
//! Running everything as ordered steps in one test avoids both problems.

mod common;

use std::time::Duration;

use charm_lib::matrix::actions::{
    can_redact_impl, edit_message_impl, redact_event_impl, send_reply_impl, toggle_reaction_impl,
    ReactionToggleResult,
};
use charm_lib::matrix::timeline::{events_to_summaries, RoomMessageSummary};
use common::synced_client;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::api::client::room::create_room;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::Client;
use tokio::time::timeout;

const POLL_TIMEOUT: Duration = Duration::from_secs(15);
const SYNC_TIMEOUT: Duration = Duration::from_secs(2);

async fn create_test_room(client: &Client) -> matrix_sdk::Room {
    let room = client
        .create_room(create_room::v3::Request::new())
        .await
        .expect("create room");
    client
        .sync_once(SyncSettings::default())
        .await
        .expect("sync after room creation");
    room
}

/// Sends a plain text message via the send queue and polls until it shows up
/// as a message the local client can fetch by event id.
async fn send_and_wait_for_event_id(
    client: &Client,
    room: &matrix_sdk::Room,
    body: &str,
) -> String {
    room.send_queue()
        .send(AnyMessageLikeEventContent::RoomMessage(
            RoomMessageEventContent::text_plain(body),
        ))
        .await
        .expect("queue message");

    let poll = async {
        let found_event_id: String = loop {
            client
                .sync_once(SyncSettings::default().timeout(SYNC_TIMEOUT))
                .await
                .ok();
            let messages = room
                .messages(MessagesOptions::backward())
                .await
                .expect("fetch messages");
            let summaries = events_to_summaries(&messages.chunk, client.user_id());
            if let Some(found) = summaries.iter().find(|m| m.body == body) {
                break found.event_id.clone();
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        };
        found_event_id
    };
    timeout(POLL_TIMEOUT, poll)
        .await
        .expect("message appears in timeline before timeout")
}

/// Polls the room's message history until `predicate` matches a summary for
/// `event_id`, or times out.
async fn wait_for_summary(
    client: &Client,
    room: &matrix_sdk::Room,
    event_id: &str,
    predicate: impl Fn(&RoomMessageSummary) -> bool,
) {
    timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default().timeout(SYNC_TIMEOUT))
                .await
                .ok();
            let messages = room
                .messages(MessagesOptions::backward())
                .await
                .expect("fetch messages");
            let summaries = events_to_summaries(&messages.chunk, client.user_id());
            if let Some(found) = summaries.iter().find(|m| m.event_id == event_id) {
                if predicate(found) {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await
    .expect("expected condition reflected in the timeline before timeout");
}

async fn step_edit_message_replaces_body_and_marks_edited(
    client: &Client,
    room: &matrix_sdk::Room,
) {
    let event_id = send_and_wait_for_event_id(client, room, "hello").await;

    edit_message_impl(
        client,
        room.room_id().as_str(),
        &event_id,
        "hello world".to_string(),
    )
    .await
    .expect("edit succeeds");

    wait_for_summary(client, room, &event_id, |found| {
        found.edited && found.body == "hello world"
    })
    .await;
}

async fn step_redact_event_clears_body_and_sets_redacted(client: &Client, room: &matrix_sdk::Room) {
    let event_id = send_and_wait_for_event_id(client, room, "to be deleted").await;

    redact_event_impl(client, room.room_id().as_str(), &event_id, None)
        .await
        .expect("redact succeeds");

    wait_for_summary(client, room, &event_id, |found| {
        found.redacted && found.body.is_empty()
    })
    .await;
}

async fn step_can_redact_true_for_own_and_for_others_via_power_level(
    client: &Client,
    room: &matrix_sdk::Room,
) {
    let own_user_id = client.user_id().expect("logged in").to_string();
    let _event_id = send_and_wait_for_event_id(client, room, "mine").await;

    // Own messages are always redactable.
    let can_redact_own = can_redact_impl(client, room.room_id().as_str(), &own_user_id)
        .await
        .expect("can_redact succeeds");
    assert!(can_redact_own);

    // The room creator holds power level 100 by default, well above the
    // typical redact requirement (50) — so the creator can redact others'
    // messages too. This exercises the power-level-granted path, distinct
    // from the "it's my own message" shortcut above.
    let can_redact_other =
        can_redact_impl(client, room.room_id().as_str(), "@someone-else:example.org")
            .await
            .expect("can_redact succeeds");
    assert!(
        can_redact_other,
        "room creator (power level 100) can redact others' messages"
    );
}

/// Proves `can_redact_impl` actually reads the room's `redact` power-level
/// requirement rather than unconditionally trusting the caller.
///
/// A single homeserver user can't test this against themselves: Synapse
/// refuses to let a user set a power level (their own or the `redact`
/// threshold) above their own current level, so a creator-level user can
/// never end up genuinely under-privileged in their own room without a
/// second party to demote them. So this registers a second, low-power
/// account (default `users_default` = 0), invites and joins it into the
/// room, and checks `can_redact_impl` from that account's point of view —
/// it must be unable to redact the creator's message (default `redact`
/// threshold is 50, well above 0).
async fn step_can_redact_false_for_a_genuinely_low_power_member(
    client: &Client,
    room: &matrix_sdk::Room,
) {
    let low_power_username = format!("charm-lowpower-test-{}", std::process::id());
    let low_power_client = Client::builder()
        .homeserver_url(common::HOMESERVER)
        .build()
        .await
        .expect("build low-power client");
    charm_lib::matrix::register_with_dummy_auth(
        &low_power_client,
        &low_power_username,
        "testpass123",
    )
    .await
    .expect("register low-power account");

    let low_power_user_id = low_power_client.user_id().expect("logged in").to_owned();
    room.invite_user_by_id(&low_power_user_id)
        .await
        .expect("invite low-power user");

    low_power_client
        .join_room_by_id(room.room_id())
        .await
        .expect("low-power user joins room");
    low_power_client
        .sync_once(SyncSettings::default().timeout(SYNC_TIMEOUT))
        .await
        .expect("low-power user syncs after joining");
    client
        .sync_once(SyncSettings::default().timeout(SYNC_TIMEOUT))
        .await
        .expect("creator syncs after invite/join round-trip");

    // As the low-power member (default power level 0, well under the
    // default `redact` threshold of 50), we can't redact the creator's
    // message.
    let low_power_room = low_power_client
        .get_room(room.room_id())
        .expect("low-power client sees the room");
    let creator_user_id = client.user_id().expect("logged in").to_string();
    let can_redact_creator = can_redact_impl(
        &low_power_client,
        low_power_room.room_id().as_str(),
        &creator_user_id,
    )
    .await
    .expect("can_redact succeeds");
    assert!(!can_redact_creator);
}

async fn step_toggle_reaction_adds_then_removes(client: &Client, room: &matrix_sdk::Room) {
    let event_id = send_and_wait_for_event_id(client, room, "react to me").await;

    let added = toggle_reaction_impl(client, room.room_id().as_str(), &event_id, "👍".to_string())
        .await
        .expect("toggle (add) succeeds");
    assert!(matches!(added, ReactionToggleResult::Added));

    wait_for_summary(client, room, &event_id, |found| {
        found
            .reactions
            .iter()
            .any(|r| r.key == "👍" && r.reacted_by_me)
    })
    .await;

    let removed =
        toggle_reaction_impl(client, room.room_id().as_str(), &event_id, "👍".to_string())
            .await
            .expect("toggle (remove) succeeds");
    assert!(matches!(removed, ReactionToggleResult::Removed));
}

async fn step_send_reply_carries_in_reply_to(client: &Client, room: &matrix_sdk::Room) {
    let original_event_id = send_and_wait_for_event_id(client, room, "original message").await;

    send_reply_impl(
        client,
        room.room_id().as_str(),
        &original_event_id,
        "reply body".to_string(),
    )
    .await
    .expect("reply succeeds");

    timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default().timeout(SYNC_TIMEOUT))
                .await
                .ok();
            let messages = room
                .messages(MessagesOptions::backward())
                .await
                .expect("fetch messages");
            let summaries = events_to_summaries(&messages.chunk, client.user_id());
            let reply = summaries.iter().find(|m| {
                m.in_reply_to
                    .as_ref()
                    .is_some_and(|r| r.event_id == original_event_id)
            });
            if reply.is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await
    .expect("reply is reflected in the timeline before timeout");
}

#[tokio::test]
async fn message_actions_round_trip_against_a_real_homeserver() {
    let client = synced_client().await;
    let room = create_test_room(&client).await;

    step_edit_message_replaces_body_and_marks_edited(&client, &room).await;
    step_redact_event_clears_body_and_sets_redacted(&client, &room).await;
    step_can_redact_true_for_own_and_for_others_via_power_level(&client, &room).await;
    step_can_redact_false_for_a_genuinely_low_power_member(&client, &room).await;
    step_toggle_reaction_adds_then_removes(&client, &room).await;
    step_send_reply_carries_in_reply_to(&client, &room).await;
}
