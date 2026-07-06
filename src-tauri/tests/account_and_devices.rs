//! Real-homeserver proof of Spec 08's core account/device logic — no mocking.
//! Builds `matrix_sdk::Client`s directly (like `verification_flow.rs` and
//! `persistence_isolation.rs`) rather than going through the
//! `#[tauri::command]` entry points in `matrix::account`/`matrix::devices`,
//! since those require a real `tauri::AppHandle` that isn't available outside
//! a running app — this exercises the exact matrix-rust-sdk calls those
//! commands wrap.
#![recursion_limit = "512"]

mod common;

use std::time::Duration;

use common::{synced_client, test_password};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::api::client::uiaa::{
    AuthData, MatrixUserIdentifier, Password, UserIdentifier,
};
use matrix_sdk::LoopCtrl;
use tokio::time::{sleep, timeout};

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

const POLL_TIMEOUT: Duration = Duration::from_secs(15);

/// `devices::request_device_verification` waits for the *other* device to
/// accept before emitting `verification:request`, so `VerificationOverlay` —
/// built for the incoming-request flow and reused unmodified for this
/// self-initiated one — always opens with a request that's already `Ready`.
/// That overlay's existing "Accept" button always calls
/// `accept_verification_request` regardless of which side started the flow;
/// this proves that calling it again on an already-`Ready`, self-initiated
/// request is a safe no-op (matrix-sdk-crypto's `InnerRequest::accept` only
/// applies from the `Requested` state and no-ops otherwise) and that
/// `start_sas` — which matches on `Ready` regardless of `we_started` — still
/// succeeds afterward.
#[tokio::test]
async fn accepting_an_already_ready_outgoing_request_is_a_safe_noop_and_start_sas_still_works() {
    let device_a = synced_client().await; // initiator — mirrors `request_device_verification`.
    let device_b = synced_client().await; // the other session, accepting like its own overlay would.

    let user_id = device_a.user_id().expect("logged in").to_owned();
    let device_b_id = device_b.device_id().expect("has device id").to_owned();

    let sync_a = tokio::spawn({
        let c = device_a.clone();
        async move {
            c.sync_with_callback(SyncSettings::default(), |_| async { LoopCtrl::Continue })
                .await
        }
    });
    let sync_b = tokio::spawn({
        let c = device_b.clone();
        async move {
            c.sync_with_callback(SyncSettings::default(), |_| async { LoopCtrl::Continue })
                .await
        }
    });

    let device_b_seen_by_a = timeout(POLL_TIMEOUT, async {
        loop {
            if let Some(device) = device_a
                .encryption()
                .get_device(&user_id, &device_b_id)
                .await
                .unwrap()
            {
                return device;
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("device B became visible to device A within timeout");

    let request_from_a = device_b_seen_by_a
        .request_verification()
        .await
        .expect("device A can request verification of device B");
    let flow_id = request_from_a.flow_id().to_string();

    // Device B's side: simulate its own `VerificationOverlay` reacting to the
    // incoming request and the user clicking Accept there.
    let request_on_b = timeout(POLL_TIMEOUT, async {
        loop {
            if let Some(request) = device_b
                .encryption()
                .get_verification_request(&user_id, &flow_id)
                .await
            {
                return request;
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("device B received the incoming request within timeout");
    request_on_b.accept().await.expect("device B accepts");

    // Device A's side: wait for Ready, mirroring `request_device_verification`'s
    // background watcher before it emits `verification:request`.
    timeout(POLL_TIMEOUT, async {
        loop {
            if request_from_a.is_ready() {
                return;
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("device A's request became ready within timeout");

    request_from_a
        .accept()
        .await
        .expect("accepting an already-ready, self-initiated request must not error");

    let sas = request_from_a
        .start_sas()
        .await
        .expect("start_sas call succeeds")
        .expect("other side supports SAS");
    assert!(
        !sas.is_done(),
        "the SAS flow should have just started, not already be done"
    );

    sync_a.abort();
    sync_b.abort();
}
