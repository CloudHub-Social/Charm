//! Command-boundary proof that edit/redact/react/reply/send actually
//! round-trip against a real homeserver, through a real `matrix-sdk-ui`
//! `Timeline` — no mocking, same pattern as the other integration tests in
//! this directory (each one needs a local Synapse: `dev/synapse/` locally, a
//! GitHub Actions service container in CI).
//!
//! These call the `..._impl(&Client, ...)` core functions directly rather
//! than the `#[tauri::command]` wrappers, since constructing a real
//! `tauri::State<MatrixState>` outside a running Tauri app isn't practical —
//! same rationale as the existing tests in this directory calling e.g.
//! `discover`/`register_with_dummy_auth`/`resolve_alias` instead of their
//! command wrappers.
//!
//! All scenarios run as steps inside a single `#[tokio::test]` against one
//! shared client/room/`Timeline`, rather than as separate `#[tokio::test]`
//! functions: Synapse's default `rc_room_creation` rate limit is a small
//! burst allowance (a fresh room per test quickly exhausts it), and the
//! `can_redact` scenario mutates the room's power levels, which would race
//! against other tests running concurrently against the same shared room.
//! Running everything as ordered steps against one shared `Timeline` also
//! directly exercises Spec 14's acceptance criteria: a single, long-lived
//! `Timeline` accumulating sends/edits/reactions/redactions/replies over many
//! sync round-trips, the same way a real chat session would.

mod common;

use std::time::Duration;

use charm_lib::matrix::actions::{
    can_redact_impl, edit_message_impl, redact_event_impl, send_reply_impl, toggle_reaction_impl,
    ReactionToggleResult,
};
use charm_lib::matrix::timeline::{items_to_summaries, RoomMessageSummary, SendState};
use common::synced_client;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::api::client::room::create_room;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::Client;
use matrix_sdk_ui::timeline::RoomExt as _;
use matrix_sdk_ui::Timeline;
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

/// Current snapshot of `timeline`'s items, mapped the same way the real
/// `get_timeline_page`/`timeline:update` path does.
async fn snapshot(timeline: &Timeline, client: &Client) -> Vec<RoomMessageSummary> {
    let (items, _stream) = timeline.subscribe().await;
    items_to_summaries(&items, client.user_id(), client, None).await
}

/// Sends a plain text message via the send queue and polls `timeline` until
/// it shows up as a message with a real (non-transaction-id) event id.
async fn send_and_wait_for_event_id(client: &Client, timeline: &Timeline, body: &str) -> String {
    timeline
        .send(AnyMessageLikeEventContent::RoomMessage(
            RoomMessageEventContent::text_plain(body),
        ))
        .await
        .expect("queue message");

    timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default().timeout(SYNC_TIMEOUT))
                .await
                .ok();
            let summaries = snapshot(timeline, client).await;
            if let Some(found) = summaries
                .iter()
                .find(|m| m.body == body && m.event_id.starts_with('$'))
            {
                return found.event_id.clone();
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await
    .expect("message appears in the timeline before timeout")
}

/// Polls `timeline`'s live snapshot until `predicate` matches a summary for
/// `event_id`, or times out.
async fn wait_for_summary(
    client: &Client,
    timeline: &Timeline,
    event_id: &str,
    predicate: impl Fn(&RoomMessageSummary) -> bool,
) {
    timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default().timeout(SYNC_TIMEOUT))
                .await
                .ok();
            let summaries = snapshot(timeline, client).await;
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

async fn step_edit_message_replaces_body_and_marks_edited(client: &Client, timeline: &Timeline) {
    let event_id = send_and_wait_for_event_id(client, timeline, "hello").await;

    edit_message_impl(
        client,
        timeline.room().room_id().as_str(),
        &event_id,
        "hello world".to_string(),
    )
    .await
    .expect("edit succeeds");

    wait_for_summary(client, timeline, &event_id, |found| {
        found.edited && found.body == "hello world"
    })
    .await;
}

async fn step_redact_event_clears_body_and_sets_redacted(client: &Client, timeline: &Timeline) {
    let event_id = send_and_wait_for_event_id(client, timeline, "to be deleted").await;

    redact_event_impl(client, timeline.room().room_id().as_str(), &event_id, None)
        .await
        .expect("redact succeeds");

    wait_for_summary(client, timeline, &event_id, |found| {
        found.redacted && found.body.is_empty()
    })
    .await;
}

async fn step_can_redact_true_for_own_and_for_others_via_power_level(
    client: &Client,
    timeline: &Timeline,
) {
    let own_user_id = client.user_id().expect("logged in").to_string();
    let _event_id = send_and_wait_for_event_id(client, timeline, "mine").await;

    // Own messages are always redactable.
    let can_redact_own = can_redact_impl(client, timeline.room().room_id().as_str(), &own_user_id)
        .await
        .expect("can_redact succeeds");
    assert!(can_redact_own);

    // The room creator holds power level 100 by default, well above the
    // typical redact requirement (50) — so the creator can redact others'
    // messages too. This exercises the power-level-granted path, distinct
    // from the "it's my own message" shortcut above.
    let can_redact_other = can_redact_impl(
        client,
        timeline.room().room_id().as_str(),
        "@someone-else:example.org",
    )
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
    timeline: &Timeline,
) {
    let room = timeline.room();
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

async fn step_toggle_reaction_adds_then_removes(client: &Client, timeline: &Timeline) {
    let event_id = send_and_wait_for_event_id(client, timeline, "react to me").await;

    let added = toggle_reaction_impl(
        client,
        timeline.room().room_id().as_str(),
        &event_id,
        "👍".to_string(),
    )
    .await
    .expect("toggle (add) succeeds");
    assert!(matches!(added, ReactionToggleResult::Added));

    wait_for_summary(client, timeline, &event_id, |found| {
        found
            .reactions
            .iter()
            .any(|r| r.key == "👍" && r.reacted_by_me)
    })
    .await;

    let removed = toggle_reaction_impl(
        client,
        timeline.room().room_id().as_str(),
        &event_id,
        "👍".to_string(),
    )
    .await
    .expect("toggle (remove) succeeds");
    assert!(matches!(removed, ReactionToggleResult::Removed));
}

async fn step_send_reply_carries_in_reply_to(client: &Client, timeline: &Timeline) {
    let original_event_id = send_and_wait_for_event_id(client, timeline, "original message").await;

    send_reply_impl(
        client,
        timeline.room().room_id().as_str(),
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
            let summaries = snapshot(timeline, client).await;
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

/// Documents a real behavior difference from the pre-Spec-14 hand-rolled
/// fold discovered while writing this suite: against a fast local homeserver,
/// `matrix-sdk-ui`'s `Timeline` can promote a send-queue local echo straight
/// to a `Remote` item (real `$...` event id) fast enough that there's no
/// reliably observable window where `EventTimelineItem::transaction_id()` —
/// which only ever returns `Some` for the `Local` item kind, per its own doc
/// comment ("currently only kept until the remote echo ... is received") —
/// can be polled and asserted against what `send_and_capture_transaction_id`
/// returned. That's fine for the actual bug this spec fixes: unlike the old
/// fold, `Timeline` never produces two separate items for one message in the
/// first place (the remote echo replaces the local one at the same
/// position), so nothing downstream needs to match a synced event back to
/// its transaction id — see `step_send_shows_exactly_one_bubble_pending_then_sent`
/// for the actual no-duplication/no-stuck-pending regression coverage.
async fn step_send_message_reaches_a_real_event_id(client: &Client, timeline: &Timeline) {
    let content = AnyMessageLikeEventContent::RoomMessage(RoomMessageEventContent::text_plain(
        "reconciliation check",
    ));
    charm_lib::matrix::send::send_and_capture_transaction_id(client, timeline.room(), content)
        .await
        .expect("send succeeds and yields a transaction id");

    timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default().timeout(SYNC_TIMEOUT))
                .await
                .ok();
            let summaries = snapshot(timeline, client).await;
            let synced = summaries
                .iter()
                .find(|m| m.body == "reconciliation check" && m.event_id.starts_with('$'));
            if synced.is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await
    .expect("sent message is reflected in the timeline before timeout");
}

/// Spec 14 acceptance criterion #2: sending a message shows exactly one
/// bubble that transitions `pending -> sent` — no duplicate, no stuck
/// "pending". Before Spec 14, the hand-rolled fold had no local-echo concept
/// at all (echoes were entirely a frontend construct keyed on a
/// client-invented id that never matched anything the SDK produced), so this
/// specifically exercises the `Timeline`-sourced `send_state` transition that
/// replaces it.
async fn step_send_shows_exactly_one_bubble_pending_then_sent(
    client: &Client,
    timeline: &Timeline,
) {
    let body = "exactly one bubble please";

    timeline
        .send(AnyMessageLikeEventContent::RoomMessage(
            RoomMessageEventContent::text_plain(body),
        ))
        .await
        .expect("queue message");

    // Immediately after queuing (before any sync), the Timeline's own local
    // echo should already show exactly one item for this body, pending.
    timeout(POLL_TIMEOUT, async {
        loop {
            let summaries = snapshot(timeline, client).await;
            let matching: Vec<_> = summaries.iter().filter(|m| m.body == body).collect();
            if !matching.is_empty() {
                assert_eq!(
                    matching.len(),
                    1,
                    "expected exactly one local-echo bubble for {body:?}, got {matching:?}"
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("local echo appears before timeout");

    // Once the homeserver acks it (via sync), it must still be exactly one
    // bubble — the local echo replaced in place, not a second item appended
    // alongside it — and its `send_state` must have flipped to `Sent`.
    timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default().timeout(SYNC_TIMEOUT))
                .await
                .ok();
            let summaries = snapshot(timeline, client).await;
            let matching: Vec<_> = summaries.iter().filter(|m| m.body == body).collect();
            assert_eq!(
                matching.len(),
                1,
                "expected the echo to be replaced in place, not duplicated: {matching:?}"
            );
            if matches!(matching[0].send_state, SendState::Sent) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await
    .expect("bubble reaches Sent (not stuck Pending) before timeout");
}

/// Spec 14 acceptance criterion #3: reacting to a message that's already
/// loaded but older than the current sync batch updates it in place. Before
/// Spec 14, the hand-rolled fold only aggregated relations within a single
/// `room.messages()`/sync-batch slice — a reaction to a message several
/// messages back (already scrolled out of the current batch) silently
/// dropped. `Timeline` aggregates against its whole held item set, not a
/// single batch, so this reacts to the very first message sent in this test
/// (many sends/edits/redactions ago) and expects it to update in place.
async fn step_react_to_an_old_out_of_batch_message_updates_in_place(
    client: &Client,
    timeline: &Timeline,
    old_event_id: &str,
) {
    let added = toggle_reaction_impl(
        client,
        timeline.room().room_id().as_str(),
        old_event_id,
        "🎉".to_string(),
    )
    .await
    .expect("toggle (add) succeeds");
    assert!(matches!(added, ReactionToggleResult::Added));

    wait_for_summary(client, timeline, old_event_id, |found| {
        found
            .reactions
            .iter()
            .any(|r| r.key == "🎉" && r.reacted_by_me)
    })
    .await;
}

#[tokio::test]
async fn message_actions_round_trip_against_a_real_homeserver() {
    let client = synced_client().await;
    let room = create_test_room(&client).await;
    let timeline = room.timeline().await.expect("build timeline");

    let very_first_event_id =
        send_and_wait_for_event_id(&client, &timeline, "the very first message").await;

    step_edit_message_replaces_body_and_marks_edited(&client, &timeline).await;
    step_redact_event_clears_body_and_sets_redacted(&client, &timeline).await;
    step_can_redact_true_for_own_and_for_others_via_power_level(&client, &timeline).await;
    step_can_redact_false_for_a_genuinely_low_power_member(&client, &timeline).await;
    step_toggle_reaction_adds_then_removes(&client, &timeline).await;
    step_send_reply_carries_in_reply_to(&client, &timeline).await;
    step_send_message_reaches_a_real_event_id(&client, &timeline).await;
    step_send_shows_exactly_one_bubble_pending_then_sent(&client, &timeline).await;
    // By now several other messages have been sent/edited/redacted/reacted to
    // in this room since `very_first_event_id` — it's well out of any
    // reasonably-sized single sync batch.
    step_react_to_an_old_out_of_batch_message_updates_in_place(
        &client,
        &timeline,
        &very_first_event_id,
    )
    .await;
}
