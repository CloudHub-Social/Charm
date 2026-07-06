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
    room.set_unread_flag(true).await.expect("set unread flag");
    assert!(room.is_marked_unread());
    room.set_unread_flag(false)
        .await
        .expect("clear unread flag");
    assert!(!room.is_marked_unread());

    // --- Mute round-trips via `get_user_defined_room_notification_mode` ---
    client
        .notification_settings()
        .await
        .set_room_notification_mode(room.room_id(), RoomNotificationMode::Mute)
        .await
        .expect("mute room");
    let mode = client
        .notification_settings()
        .await
        .get_user_defined_room_notification_mode(room.room_id())
        .await;
    assert_eq!(mode, Some(RoomNotificationMode::Mute));

    // --- A room-level override survives a "mute all rooms" / unmute cycle ---
    // (Spec 08 review: `notifications::set_global_mute` only overrode the
    // four *default* rules, which a room-level override always takes
    // precedence over — so a room like this one, explicitly set to
    // `MentionsAndKeywordsOnly`, would keep notifying right through "Mute all
    // rooms" being shown as active. `mute_room_overrides`/
    // `restore_room_overrides` in `notifications.rs` fix this by snapshotting
    // every room-level override before forcing it to `Mute`, then restoring
    // the snapshot on unmute — this proves that exact sequence round-trips
    // against a real homeserver, using the same `NotificationSettings` calls
    // those private helpers make.)
    let settings = client.notification_settings().await;
    settings
        .set_room_notification_mode(
            room.room_id(),
            RoomNotificationMode::MentionsAndKeywordsOnly,
        )
        .await
        .expect("set room to mentions-only");
    assert!(settings
        .get_rooms_with_user_defined_rules(None)
        .await
        .contains(&room.room_id().to_string()));
    let pre_mute_mode = settings
        .get_user_defined_room_notification_mode(room.room_id())
        .await
        .expect("room has a user-defined mode before muting");
    assert_eq!(pre_mute_mode, RoomNotificationMode::MentionsAndKeywordsOnly);

    settings
        .set_room_notification_mode(room.room_id(), RoomNotificationMode::Mute)
        .await
        .expect("force-mute the room's override, simulating 'mute all rooms'");
    assert_eq!(
        settings
            .get_user_defined_room_notification_mode(room.room_id())
            .await,
        Some(RoomNotificationMode::Mute)
    );

    settings
        .set_room_notification_mode(room.room_id(), pre_mute_mode)
        .await
        .expect("restore the snapshotted override, simulating unmute");
    assert_eq!(
        settings
            .get_user_defined_room_notification_mode(room.room_id())
            .await,
        Some(RoomNotificationMode::MentionsAndKeywordsOnly),
        "the room's specific override must survive a mute/unmute cycle, not collapse to Mute"
    );

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

    space
        .send_state_event_for_key(room.room_id(), SpaceChildEventContent::new(vec![]))
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
