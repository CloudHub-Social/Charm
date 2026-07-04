//! End-to-end proof that the SAS verification primitives our Rust commands
//! wrap actually work against a real homeserver — two independent
//! matrix-rust-sdk clients (simulating two devices of the same account),
//! no mocking. Requires a local Synapse (`dev/synapse/` locally, a
//! GitHub Actions service container in CI) with the test user from
//! `tests/common` already registered.

mod common;

use std::time::Duration;

use common::synced_client;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::encryption::verification::{SasState, Verification};
use matrix_sdk::LoopCtrl;
use tokio::time::{sleep, timeout};

const POLL_TIMEOUT: Duration = Duration::from_secs(15);

#[tokio::test]
async fn sas_verification_completes_with_matching_emojis() {
    let device_a = synced_client().await;
    let device_b = synced_client().await;

    let user_id = device_a.user_id().expect("logged in").to_owned();
    let device_a_id = device_a.device_id().expect("has device id").to_owned();

    // Continuous sync on both devices so to-device verification events flow.
    let sync_a = tokio::spawn({
        let c = device_a.clone();
        async move {
            c.sync_with_callback(SyncSettings::default(), |_response| async {
                LoopCtrl::Continue
            })
            .await
        }
    });
    let sync_b = tokio::spawn({
        let c = device_b.clone();
        async move {
            c.sync_with_callback(SyncSettings::default(), |_response| async {
                LoopCtrl::Continue
            })
            .await
        }
    });

    // Let device B discover device A over the device-list/key-query machinery
    // before requesting verification of it.
    let device_a_seen_by_b = timeout(POLL_TIMEOUT, async {
        loop {
            if let Some(device) = device_b
                .encryption()
                .get_device(&user_id, &device_a_id)
                .await
                .expect("get_device call")
            {
                return device;
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("device A became visible to device B within timeout");

    let request_from_b = device_a_seen_by_b
        .request_verification()
        .await
        .expect("device B can request verification of device A");
    let flow_id = request_from_b.flow_id().to_string();

    // Device A should see the incoming request appear — this is exactly the
    // condition our `register_verification_handler` reacts to in the app.
    let request_on_a = timeout(POLL_TIMEOUT, async {
        loop {
            if let Some(request) = device_a
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
    .expect("device A received the verification request within timeout");

    request_on_a.accept().await.expect("device A accepts");

    // Device B's request needs to observe the acceptance before starting SAS.
    timeout(POLL_TIMEOUT, async {
        loop {
            if request_from_b.is_ready() {
                return;
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("request became ready within timeout");

    let sas_b = request_from_b
        .start_sas()
        .await
        .expect("start_sas call")
        .expect("other side supports SAS");

    let sas_a = timeout(POLL_TIMEOUT, async {
        loop {
            if let Some(Verification::SasV1(sas)) = device_a
                .encryption()
                .get_verification(&user_id, &flow_id)
                .await
            {
                return sas;
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("device A saw the SAS start within timeout");

    sas_a.accept().await.expect("device A accepts SAS");

    let emojis_a = timeout(POLL_TIMEOUT, async {
        loop {
            if let Some(emojis) = sas_a.emoji() {
                return emojis;
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("device A's emojis became available within timeout");

    let emojis_b = timeout(POLL_TIMEOUT, async {
        loop {
            if let Some(emojis) = sas_b.emoji() {
                return emojis;
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("device B's emojis became available within timeout");

    // The actual cryptographic proof: both sides must derive the identical
    // short auth string independently.
    let symbols_a: Vec<&str> = emojis_a.iter().map(|e| e.symbol).collect();
    let symbols_b: Vec<&str> = emojis_b.iter().map(|e| e.symbol).collect();
    assert_eq!(
        symbols_a, symbols_b,
        "both devices must see the same emojis"
    );

    sas_a.confirm().await.expect("device A confirms");
    sas_b.confirm().await.expect("device B confirms");

    timeout(POLL_TIMEOUT, async {
        loop {
            if matches!(sas_a.state(), SasState::Done { .. }) {
                return;
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("verification reached Done within timeout");

    sync_a.abort();
    sync_b.abort();
}
