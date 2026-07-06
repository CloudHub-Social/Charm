//! Command-boundary proof that Spec 06's room-organization tags, mute, and
//! space hierarchy actually round-trip against a real homeserver — no
//! mocking, same pattern as the other integration tests in this directory
//! (each one needs a local Synapse: `dev/synapse/` locally, a GitHub Actions
//! service container in CI).
//!
//! Calls the same public functions the `#[tauri::command]` wrappers in
//! `src/matrix/rooms.rs`/`src/matrix/spaces.rs` delegate to (`Room::set_is_favourite`,
//! `Room::set_unread_flag`, etc. — from matrix-rust-sdk directly, since these
//! commands are thin wrappers with no local logic to test beyond what's
//! already unit-tested in `rooms::has_unread`/`rooms::order_tag_name`), rather
//! than constructing a real `tauri::State<MatrixState>` outside a running
//! Tauri app — same rationale as `tests/message_actions.rs`.
//!
//! Scenarios run as ordered steps inside a single `#[tokio::test]` against
//! one shared client/room/space, rather than as separate tests: Synapse's
//! `rc_room_creation` rate limit is a small burst allowance, and a fresh
//! room/space per test would quickly exhaust it.
#![recursion_limit = "512"]

mod common;

use std::time::Duration;

use common::synced_client;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::notification_settings::RoomNotificationMode;
use matrix_sdk::ruma::api::client::room::create_room;
use matrix_sdk::ruma::api::client::space::get_hierarchy;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::events::tag::TagName;
use matrix_sdk::ruma::room::RoomType;
use matrix_sdk::Client;
use tokio::time::timeout;

const POLL_TIMEOUT: Duration = Duration::from_secs(15);

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

#[tokio::test]
async fn room_organization_round_trips_against_a_real_homeserver() {
    let client = synced_client().await;
    let room = create_test_room(&client).await;

    // --- Favourite / low-priority tags round-trip and stay mutually exclusive ---
    room.set_is_favourite(true, None)
        .await
        .expect("set favourite");
    let tags = timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default())
                .await
                .expect("sync");
            if let Ok(Some(tags)) = room.tags().await {
                if tags.contains_key(&TagName::Favorite) {
                    return tags;
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("m.favourite tag observed");
    assert!(tags.contains_key(&TagName::Favorite));
    assert!(room.is_favourite());

    room.set_is_low_priority(true, None)
        .await
        .expect("set low priority");
    timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default())
                .await
                .expect("sync");
            if room.is_low_priority() && !room.is_favourite() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("m.favourite cleared and m.lowpriority set");
    assert!(room.is_low_priority());
    assert!(
        !room.is_favourite(),
        "setting low-priority should clear favourite"
    );

    // --- Mark-unread flag round-trips via `is_marked_unread()` ---
    // `set_unread_flag` only sends the account-data mutation to the server;
    // `is_marked_unread()` reads the client's local cache, which only picks up
    // the change on the next sync — same pattern as the tag polls above.
    room.set_unread_flag(true).await.expect("set unread flag");
    timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default())
                .await
                .expect("sync");
            if room.is_marked_unread() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("unread flag observed");
    room.set_unread_flag(false)
        .await
        .expect("clear unread flag");
    timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default())
                .await
                .expect("sync");
            if !room.is_marked_unread() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("unread flag cleared");

    // --- Mute round-trips via `get_user_defined_room_notification_mode` ---
    // `NotificationSettings::set_room_notification_mode` applies the rule
    // change to its own in-memory `rules` immediately, which would let this
    // assertion pass even if the mutation never reached the server. To
    // actually prove the round-trip, sync until the account-data store picks
    // up the change, then read back through a *fresh*
    // `client.notification_settings()` instance (which rebuilds `rules` from
    // that store) rather than the mutated instance.
    client
        .notification_settings()
        .await
        .set_room_notification_mode(room.room_id(), RoomNotificationMode::Mute)
        .await
        .expect("mute room");
    let mode = timeout(POLL_TIMEOUT, async {
        loop {
            client
                .sync_once(SyncSettings::default())
                .await
                .expect("sync");
            let mode = client
                .notification_settings()
                .await
                .get_user_defined_room_notification_mode(room.room_id())
                .await;
            if mode == Some(RoomNotificationMode::Mute) {
                return mode;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("mute mode observed via a fresh NotificationSettings instance");
    assert_eq!(mode, Some(RoomNotificationMode::Mute));

    // --- Space hierarchy: create a space with this room as a child, list it, join it as a second membership check ---
    let mut space_creation_content = create_room::v3::CreationContent::new();
    space_creation_content.room_type = Some(RoomType::Space);
    let mut space_request = create_room::v3::Request::new();
    space_request.creation_content = Some(
        matrix_sdk::ruma::serde::Raw::new(&space_creation_content)
            .expect("serialize space creation content"),
    );
    let space = client
        .create_room(space_request)
        .await
        .expect("create space");
    client
        .sync_once(SyncSettings::default())
        .await
        .expect("sync after space creation");
    assert_eq!(space.room_type(), Some(RoomType::Space));

    // `via` must be non-empty for the server to treat this as a valid child
    // link — an empty list (as if the child had been removed) is silently
    // excluded from `/hierarchy` results. Derive it from the logged-in user's
    // own server name rather than the room ID: newer room versions (e.g. v12)
    // drop the `:server` component from room IDs, so `RoomId::server_name()`
    // would be `None` there even though the room is clearly reachable via
    // this homeserver.
    let via = client
        .user_id()
        .expect("logged in")
        .server_name()
        .to_owned();
    space
        .send_state_event_for_key(room.room_id(), SpaceChildEventContent::new(vec![via]))
        .await
        .expect("add room as space child");

    let hierarchy = timeout(POLL_TIMEOUT, async {
        loop {
            let response = client
                .send(get_hierarchy::v1::Request::new(space.room_id().to_owned()))
                .await
                .expect("fetch space hierarchy");
            if response
                .rooms
                .iter()
                .any(|r| r.summary.room_id == room.room_id())
            {
                return response;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("room appears as a space child in the hierarchy");

    let child = hierarchy
        .rooms
        .iter()
        .find(|r| r.summary.room_id == room.room_id())
        .expect("child room present in hierarchy response");
    assert_eq!(child.summary.num_joined_members, matrix_sdk::ruma::uint!(1));
}
