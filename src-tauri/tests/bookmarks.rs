//! Command-boundary proof that bookmarking a message snapshots its
//! sender/body/timestamp from a real, live `matrix-sdk-ui` `Timeline` — same
//! pattern as `message_actions.rs`: calls `build_bookmark_entry` (the
//! `..._impl`-style core function) directly, since constructing a real
//! `tauri::State<MatrixState>` outside a running Tauri app isn't practical.

// `build_bookmark_entry` now composes through an extra `resolve_from_timeline`
// async layer (review fix: shared with `list_bookmarks`'s read-time
// resolution — see `bookmarks.rs`), which pushed this integration test
// binary's async-block layout query past rustc's default 128 recursion
// limit on CI's toolchain (query depth increased by 130 computing the
// layout of this file's own top-level async test block). Bumping just this
// binary's limit is the fix rustc itself suggests for this error.
#![recursion_limit = "256"]

mod common;

use std::time::Duration;

use charm_lib::matrix::bookmarks::build_bookmark_entry;
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

async fn wait_for_event_id(timeline: &Timeline, body: &str) -> String {
    timeout(POLL_TIMEOUT, async {
        loop {
            let (items, _stream) = timeline.subscribe().await;
            for item in items.iter().filter_map(|item| item.as_event()) {
                if item
                    .content()
                    .as_message()
                    .is_some_and(|m| m.body() == body)
                {
                    if let Some(event_id) = item.event_id() {
                        return event_id.to_string();
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("message never appeared in timeline")
}

#[tokio::test]
async fn build_bookmark_entry_snapshots_the_loaded_message() {
    let client = synced_client().await;
    let room = create_test_room(&client).await;
    let timeline = room.timeline().await.expect("build timeline");

    room.send(AnyMessageLikeEventContent::RoomMessage(
        RoomMessageEventContent::text_plain("bookmark me"),
    ))
    .await
    .expect("send message");

    let event_id = wait_for_event_id(&timeline, "bookmark me").await;

    let entry = build_bookmark_entry(room.room_id().as_str(), &event_id, &client, &timeline)
        .await
        .expect("bookmark the loaded message");

    assert_eq!(entry.event_id, event_id);
    assert_eq!(entry.room_id, room.room_id().as_str());
    assert_eq!(entry.body_preview, "bookmark me");
}

#[tokio::test]
async fn build_bookmark_entry_errors_for_an_event_not_in_the_timeline() {
    let client = synced_client().await;
    let room = create_test_room(&client).await;
    let timeline = room.timeline().await.expect("build timeline");

    let result = build_bookmark_entry(
        room.room_id().as_str(),
        "$definitely-not-loaded",
        &client,
        &timeline,
    )
    .await;

    assert!(result.is_err());
}
