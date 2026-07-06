//! Real-homeserver proof of Spec 08's core account/device logic — no mocking.
//! Builds `matrix_sdk::Client`s directly (like `verification_flow.rs` and
//! `persistence_isolation.rs`) rather than going through the
//! `#[tauri::command]` entry points in `matrix::account`/`matrix::devices`,
//! since those require a real `tauri::AppHandle` that isn't available outside
//! a running app — this exercises the exact matrix-rust-sdk calls those
//! commands wrap.
#![recursion_limit = "512"]

mod common;

use common::{synced_client, test_password};
use matrix_sdk::ruma::api::client::uiaa::{
    AuthData, MatrixUserIdentifier, Password, UserIdentifier,
};

#[tokio::test]
async fn set_display_name_round_trips_via_get_display_name() {
    let client = synced_client().await;

    // A fresh, unique name each run — this mutates the shared dev/CI test
    // account's profile, same as other integration tests that touch live
    // account state (e.g. `room_org.rs`'s tag tests).
    let name = format!(
        "spec-08-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );

    client
        .account()
        .set_display_name(Some(&name))
        .await
        .expect("set_display_name succeeds");

    let fetched = client
        .account()
        .get_display_name()
        .await
        .expect("get_display_name succeeds");
    assert_eq!(fetched.as_deref(), Some(name.as_str()));
}

#[tokio::test]
async fn list_devices_marks_the_current_device() {
    let client = synced_client().await;
    let own_device_id = client
        .device_id()
        .expect("logged in has a device id")
        .to_owned();

    let response = client.devices().await.expect("devices() call succeeds");

    // Mirrors `devices::list_devices`'s `is_current` derivation exactly.
    assert!(
        response
            .devices
            .iter()
            .any(|d| d.device_id == own_device_id),
        "this session's own device must be present in the list"
    );
}

/// Two sessions of the *same* account (mirrors `verification_flow.rs`'s
/// two-devices-one-account setup) — device A revokes device B via
/// `delete_devices`, satisfying UIA with the shared account's real password,
/// then confirms B is gone from A's device list.
#[tokio::test]
async fn delete_device_removes_a_second_logged_in_device() {
    let device_a = synced_client().await;
    let device_b = synced_client().await;

    let device_b_id = device_b
        .device_id()
        .expect("device B has a device id")
        .to_owned();
    let user_id = device_a.user_id().expect("logged in").to_owned();

    let before = device_a.devices().await.expect("devices() call succeeds");
    assert!(
        before.devices.iter().any(|d| d.device_id == device_b_id),
        "device B should be visible to device A before revocation"
    );

    let first_attempt = device_a
        .delete_devices(std::slice::from_ref(&device_b_id), None)
        .await;
    let uiaa_info = first_attempt
        .expect_err("a password-less delete_devices call must hit a UIA challenge")
        .as_uiaa_response()
        .expect("the error carries a recognizable UIA response")
        .clone();

    let mut password_auth = Password::new(
        UserIdentifier::Matrix(MatrixUserIdentifier::new(user_id.to_string())),
        test_password(),
    );
    password_auth.session = uiaa_info.session;

    device_a
        .delete_devices(
            std::slice::from_ref(&device_b_id),
            Some(AuthData::Password(password_auth)),
        )
        .await
        .expect("delete_devices succeeds once authenticated");

    let after = device_a.devices().await.expect("devices() call succeeds");
    assert!(
        !after.devices.iter().any(|d| d.device_id == device_b_id),
        "device B must be gone from the list after revocation"
    );
}
