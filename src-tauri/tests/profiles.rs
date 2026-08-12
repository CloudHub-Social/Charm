//! Real-homeserver command-boundary proof for Spec 36 profile writes and
//! direct-message actions. The GitHub Actions service container supplies two
//! registered users; local runs use `dev/synapse/` and the same helpers.
#![recursion_limit = "512"]

mod common;

use std::time::Duration;

use charm_lib::matrix::profiles::{set_room_profile_impl, start_direct_message_impl};
use common::{synced_client, synced_client_2};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::api::client::room::create_room;
use tokio::time::timeout;

const POLL_TIMEOUT: Duration = Duration::from_secs(20);

#[tokio::test]
async fn profile_actions_round_trip_against_a_real_homeserver() {
    let primary = synced_client().await;
    let secondary = synced_client_2().await;
    let primary_user_id = primary.user_id().expect("primary logged in").to_owned();
    let secondary_user_id = secondary.user_id().expect("secondary logged in").to_owned();

    let room = primary
        .create_room(create_room::v3::Request::new())
        .await
        .expect("create profile test room");
    room.invite_user_by_id(&secondary_user_id)
        .await
        .expect("invite secondary user");
    secondary
        .join_room_by_id(room.room_id())
        .await
        .expect("secondary joins profile test room");
    primary
        .sync_once(SyncSettings::default())
        .await
        .expect("primary syncs joined room");

    set_room_profile_impl(
        &primary,
        room.room_id().as_str(),
        Some("Spec 36 Room Name".to_string()),
        Some("mxc://localhost/spec36-avatar".to_string()),
    )
    .await
    .expect("set room-scoped profile");

    timeout(POLL_TIMEOUT, async {
        loop {
            secondary
                .sync_once(SyncSettings::default())
                .await
                .expect("secondary sync");
            if let Some(secondary_room) = secondary.get_room(room.room_id()) {
                if let Ok(Some(member)) = secondary_room.get_member(&primary_user_id).await {
                    if member.display_name() == Some("Spec 36 Room Name")
                        && member.avatar_url().map(|url| url.as_str())
                            == Some("mxc://localhost/spec36-avatar")
                    {
                        return;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("secondary observes room-scoped display name and avatar");

    let direct_room_id = start_direct_message_impl(&primary, secondary_user_id.as_str())
        .await
        .expect("create direct message");
    primary
        .sync_once(SyncSettings::default())
        .await
        .expect("sync direct-message account data");
    let reopened_room_id = start_direct_message_impl(&primary, secondary_user_id.as_str())
        .await
        .expect("reuse direct message");
    assert_eq!(reopened_room_id, direct_room_id);
}
