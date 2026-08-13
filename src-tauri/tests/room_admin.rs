//! Command-boundary proof that Spec 07's room settings, power levels, and
//! member management round-trip against a real homeserver — same pattern as
//! `tests/room_org.rs` (ordered steps inside one `#[tokio::test]` per
//! scenario, one room per scenario, to stay under Synapse's
//! `rc_room_creation` rate limit).
//!
//! Calls the same public functions the `#[tauri::command]` wrappers in
//! `src/matrix/room_admin.rs` delegate to, exactly like `tests/room_org.rs`.
#![recursion_limit = "512"]

mod common;

use std::time::Duration;

use charm_lib::matrix::room_admin::{
    build_room_details, upgrade_room_impl, HistoryVisibilityKind, JoinRuleKind,
    PowerLevelThresholds,
};
use charm_lib::matrix::timeline::{
    items_to_timeline_items, TimelineItemSummary, TimelineMembershipChange, TimelineStateChange,
};
use common::{synced_client, synced_client_2, test_username_2};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::api::client::room::create_room;
use matrix_sdk::ruma::events::room::avatar::RoomAvatarEventContent;
use matrix_sdk::ruma::events::room::history_visibility::{
    HistoryVisibility, RoomHistoryVisibilityEventContent,
};
use matrix_sdk::ruma::events::room::join_rules::{JoinRule, RoomJoinRulesEventContent};
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::room::tombstone::RoomTombstoneEventContent;
use matrix_sdk::ruma::{int, Int, RoomVersionId};
use matrix_sdk::Client;
use matrix_sdk_ui::timeline::RoomExt as _;
use tokio::time::timeout;

const POLL_TIMEOUT: Duration = Duration::from_secs(20);

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
async fn room_admin_round_trips_against_a_real_homeserver() {
    let admin = synced_client().await;
    let room = create_test_room(&admin).await;
    let timeline = room.timeline().await.expect("build room timeline");

    // --- Room settings: name, topic, join rule, history visibility ---
    room.set_name("Spec 07 Test Room".to_string())
        .await
        .expect("set name");
    timeout(POLL_TIMEOUT, async {
        loop {
            let _ = admin.sync_once(SyncSettings::default()).await;
            if room.name().as_deref() == Some("Spec 07 Test Room") {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("room name observed");

    room.set_room_topic("testing room settings")
        .await
        .expect("set topic");
    timeout(POLL_TIMEOUT, async {
        loop {
            let _ = admin.sync_once(SyncSettings::default()).await;
            if room.topic().as_deref() == Some("testing room settings") {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("room topic observed");

    let avatar_upload = admin
        .media()
        .upload(
            &mime::IMAGE_PNG,
            format!("spec39-room-avatar-{}", std::process::id()).into_bytes(),
            None,
        )
        .await
        .expect("upload room avatar");
    let mut avatar = RoomAvatarEventContent::new();
    avatar.url = Some(avatar_upload.content_uri.clone());
    room.send_state_event(avatar)
        .await
        .expect("set room avatar");

    room.send_state_event(RoomJoinRulesEventContent::new(JoinRule::Public))
        .await
        .expect("set join rule");
    timeout(POLL_TIMEOUT, async {
        loop {
            let _ = admin.sync_once(SyncSettings::default()).await;
            if matches!(room.join_rule(), Some(JoinRule::Public)) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("public join rule observed");

    room.send_state_event(RoomHistoryVisibilityEventContent::new(
        HistoryVisibility::WorldReadable,
    ))
    .await
    .expect("set history visibility");
    timeout(POLL_TIMEOUT, async {
        loop {
            let _ = admin.sync_once(SyncSettings::default()).await;
            if matches!(
                room.history_visibility(),
                Some(HistoryVisibility::WorldReadable)
            ) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("world-readable history visibility observed");

    // --- Encryption: one-way enable ---
    room.enable_encryption().await.expect("enable encryption");
    timeout(POLL_TIMEOUT, async {
        loop {
            if room
                .latest_encryption_state()
                .await
                .map(|state| state.is_encrypted())
                .unwrap_or(false)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("room observed as encrypted");

    // --- Membership: invite, kick, ban, unban a second real user ---
    let second = synced_client_2().await;
    let second_user_id = second
        .user_id()
        .expect("second client logged in")
        .to_owned();

    room.invite_user_by_id(&second_user_id)
        .await
        .expect("invite second user");
    wait_for_membership(&admin, &room, &second_user_id, MembershipState::Invite).await;

    second
        .join_room_by_id(room.room_id())
        .await
        .expect("second user joins");
    wait_for_membership(&admin, &room, &second_user_id, MembershipState::Join).await;

    room.kick_user(&second_user_id, None)
        .await
        .expect("kick second user");
    wait_for_membership(&admin, &room, &second_user_id, MembershipState::Leave).await;

    room.invite_user_by_id(&second_user_id)
        .await
        .expect("re-invite second user");
    wait_for_membership(&admin, &room, &second_user_id, MembershipState::Invite).await;

    room.ban_user(&second_user_id, None)
        .await
        .expect("ban second user");
    wait_for_membership(&admin, &room, &second_user_id, MembershipState::Ban).await;

    room.unban_user(&second_user_id, None)
        .await
        .expect("unban second user");
    wait_for_membership(&admin, &room, &second_user_id, MembershipState::Leave).await;

    // --- Power levels: per-user + thresholds ---
    room.update_power_levels(vec![(&second_user_id, Int::from(50))])
        .await
        .expect("set member power level");
    timeout(POLL_TIMEOUT, async {
        loop {
            let _ = admin.sync_once(SyncSettings::default()).await;
            if room
                .get_user_power_level(&second_user_id)
                .await
                .is_ok_and(|level| level == Int::from(50))
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("member power level observed");

    let thresholds = PowerLevelThresholds {
        invite: 10,
        kick: 60,
        ban: 60,
        redact: 60,
        events_default: 0,
        state_default: 60,
        users_default: 0,
    };
    room.apply_power_level_changes(thresholds.into())
        .await
        .expect("set power level thresholds");
    timeout(POLL_TIMEOUT, async {
        loop {
            let _ = admin.sync_once(SyncSettings::default()).await;
            if room
                .power_levels()
                .await
                .is_ok_and(|pl| pl.invite == int!(10))
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("power level thresholds observed");

    // --- RoomDetails/RoomPermissions as the admin sees them ---
    let details = build_room_details(&admin, room.room_id().as_str())
        .await
        .expect("build room details as admin");
    assert!(
        details.can.set_name,
        "admin (creator) should be able to rename"
    );
    assert!(
        details.can.set_power_levels,
        "admin should be able to edit power levels"
    );
    assert_eq!(details.join_rule, JoinRuleKind::Public);
    assert_eq!(
        details.history_visibility,
        HistoryVisibilityKind::WorldReadable
    );
    assert!(details.is_encrypted);

    let replacement = create_test_room(&admin).await;
    room.send_state_event(RoomTombstoneEventContent::new(
        "This room has moved".to_owned(),
        replacement.room_id().to_owned(),
    ))
    .await
    .expect("send room tombstone");

    timeout(POLL_TIMEOUT, async {
        loop {
            let _ = admin.sync_once(SyncSettings::default()).await;
            let (items, _stream) = timeline.subscribe().await;
            let summaries = items_to_timeline_items(&items, admin.user_id(), &admin, None).await;

            let has_name = summaries.iter().any(|item| {
                matches!(
                    item,
                    TimelineItemSummary::State {
                        change: TimelineStateChange::Name { new_value, .. },
                        ..
                    } if new_value.as_deref() == Some("Spec 07 Test Room")
                )
            });
            let has_topic = summaries.iter().any(|item| {
                matches!(
                    item,
                    TimelineItemSummary::State {
                        change: TimelineStateChange::Topic { new_value, .. },
                        ..
                    } if new_value.as_deref() == Some("testing room settings")
                )
            });
            let has_avatar = summaries.iter().any(|item| {
                matches!(
                    item,
                    TimelineItemSummary::State {
                        change: TimelineStateChange::Avatar { new_value, .. },
                        ..
                    } if new_value.as_deref() == Some(avatar_upload.content_uri.as_str())
                )
            });
            let has_tombstone = summaries.iter().any(|item| {
                matches!(
                    item,
                    TimelineItemSummary::State {
                        change: TimelineStateChange::Tombstone { replacement_room_id, .. },
                        ..
                    } if replacement_room_id.as_deref() == Some(replacement.room_id().as_str())
                )
            });
            let has_join = summaries.iter().any(|item| {
                matches!(
                    item,
                    TimelineItemSummary::Membership {
                        target_user_id,
                        change: TimelineMembershipChange::Joined
                            | TimelineMembershipChange::InvitationAccepted,
                        ..
                    } if target_user_id == second_user_id.as_str()
                )
            });
            let has_leave = summaries.iter().any(|item| {
                matches!(
                    item,
                    TimelineItemSummary::Membership {
                        target_user_id,
                        change: TimelineMembershipChange::Left
                            | TimelineMembershipChange::Kicked,
                        ..
                    } if target_user_id == second_user_id.as_str()
                )
            });

            if has_name && has_topic && has_avatar && has_tombstone && has_join && has_leave {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("Spec 39 state and membership variants appeared in Charm's timeline DTO");
}

async fn wait_for_membership(
    admin: &Client,
    room: &matrix_sdk::Room,
    user_id: &matrix_sdk::ruma::UserId,
    expected: MembershipState,
) {
    timeout(POLL_TIMEOUT, async {
        loop {
            let _ = admin.sync_once(SyncSettings::default()).await;
            let membership = room
                .get_member(user_id)
                .await
                .ok()
                .flatten()
                .map(|m| m.membership().clone());
            if membership.as_ref() == Some(&expected) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("membership {expected:?} observed"));
}

/// A second, low-power-level user should see every mutating permission as
/// `false` in `RoomDetails.can`, and a mutating call as that user should
/// error — the gating the Spec 07 UI relies on to disable controls.
#[tokio::test]
async fn low_power_level_user_is_denied_room_admin_actions() {
    let admin = synced_client().await;
    let room = create_test_room(&admin).await;

    let second = synced_client_2().await;
    let second_user_id = second
        .user_id()
        .expect("second client logged in")
        .to_owned();

    room.invite_user_by_id(&second_user_id)
        .await
        .expect("invite second user");
    second
        .join_room_by_id(room.room_id())
        .await
        .expect("second user joins");

    timeout(POLL_TIMEOUT, async {
        loop {
            let _ = second.sync_once(SyncSettings::default()).await;
            if second.get_room(room.room_id()).is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("second client observes the room after joining");

    let second_room = second
        .get_room(room.room_id())
        .expect("room known to second client");

    let details = build_room_details(&second, room.room_id().as_str())
        .await
        .expect("build room details as low-PL member");
    assert!(!details.can.set_name);
    assert!(!details.can.set_topic);
    assert!(!details.can.set_power_levels);
    assert!(!details.can.kick);
    assert!(!details.can.ban);
    assert!(!details.can.upgrade_room);

    let upgrade_result = upgrade_room_impl(&second, room.room_id().as_str()).await;
    assert!(
        upgrade_result.is_err(),
        "a low-PL user's room-upgrade attempt should be rejected"
    );

    let result = second_room
        .set_name(format!("renamed by {}", test_username_2()))
        .await;
    assert!(
        result.is_err(),
        "a low-PL user's rename attempt should be rejected"
    );
}

#[tokio::test]
async fn room_upgrade_uses_the_homeserver_default_version() {
    let admin = synced_client().await;
    let mut request = create_room::v3::Request::new();
    request.room_version = Some(RoomVersionId::V9);
    let room = admin.create_room(request).await.expect("create v9 room");
    admin
        .sync_once(SyncSettings::default())
        .await
        .expect("sync before room upgrade");

    let replacement_room_id = upgrade_room_impl(&admin, room.room_id().as_str())
        .await
        .expect("upgrade room");

    assert_ne!(replacement_room_id, room.room_id().as_str());

    // Deliberately retry before syncing: the SDK state store is still stale,
    // so this proves the duplicate-upgrade guard reads current homeserver
    // state rather than trusting the local room cache.
    let repeated_upgrade = upgrade_room_impl(&admin, room.room_id().as_str()).await;
    assert_eq!(
        repeated_upgrade.expect_err("an existing tombstone must reject a repeat upgrade"),
        "This room has already been upgraded.",
        "an existing tombstone must prevent creating a second replacement room"
    );

    admin
        .sync_once(SyncSettings::default())
        .await
        .expect("sync tombstone after room upgrade");
    let details = build_room_details(&admin, room.room_id().as_str())
        .await
        .expect("build upgraded room details");
    assert_eq!(
        details
            .tombstone
            .as_ref()
            .map(|tombstone| tombstone.replacement_room_id.as_str()),
        Some(replacement_room_id.as_str())
    );
}
