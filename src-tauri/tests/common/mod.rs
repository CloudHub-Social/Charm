//! Shared setup for integration tests that need a real homeserver.
//!
//! Credentials come from `TEST_MATRIX_USERNAME`/`TEST_MATRIX_PASSWORD` env
//! vars (set from GitHub Actions secrets in CI, generated fresh in the local
//! dev Synapse's `register-test-user.sh`) rather than being hardcoded, so the
//! same test account name/password isn't published in the repo alongside
//! instructions for reaching the (normally-local-only) homeserver.
//!
//! This module is compiled fresh into each integration test binary that
//! declares `mod common;`, so any given binary that doesn't use every helper
//! here would otherwise warn — hence the blanket allow.
#![allow(dead_code)]

use matrix_sdk::config::SyncSettings;
use matrix_sdk::Client;

pub const HOMESERVER: &str = "http://localhost:8008";

pub fn test_username() -> String {
    std::env::var("TEST_MATRIX_USERNAME").unwrap_or_else(|_| "evie".to_string())
}

pub fn test_password() -> String {
    std::env::var("TEST_MATRIX_PASSWORD").unwrap_or_else(|_| "testpass123".to_string())
}

pub async fn logged_in_client() -> Client {
    let client = Client::builder()
        .homeserver_url(HOMESERVER)
        .build()
        .await
        .expect("build client");
    client
        .matrix_auth()
        .login_username(test_username(), &test_password())
        .send()
        .await
        .expect("login");
    client
}

/// Same as [`logged_in_client`] but also performs the initial sync — needed
/// by tests that read room/device/crypto state rather than making a single
/// stateless API call.
pub async fn synced_client() -> Client {
    let client = logged_in_client().await;
    client
        .sync_once(SyncSettings::default())
        .await
        .expect("initial sync");
    client
}
