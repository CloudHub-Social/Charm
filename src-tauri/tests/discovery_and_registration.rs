//! Real network proof that homeserver discovery and UIAA-dummy-stage
//! registration work against a real Synapse — no mocking. Requires a local
//! Synapse (`dev/synapse/` locally, a GitHub Actions service container in
//! CI) with open registration enabled (`enable_registration: true` in
//! `homeserver.yaml` — the default generated config has it disabled).

mod common;

use charm_lib::matrix::{discover, register_with_dummy_auth};
use common::HOMESERVER;
use matrix_sdk::Client;

#[tokio::test]
async fn discover_resolves_a_plain_homeserver_url() {
    let resolved = discover(HOMESERVER).await.expect("discovery succeeds");
    assert_eq!(resolved, format!("{HOMESERVER}/"));
}

#[tokio::test]
async fn discover_rejects_an_unreachable_server() {
    let result = discover("localhost:1").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn register_with_dummy_auth_creates_a_working_session() {
    let username = format!(
        "charm-reg-test-{}",
        std::process::id() // unique enough to avoid colliding with a previous run against the same server
    );
    let client = Client::builder()
        .homeserver_url(HOMESERVER)
        .build()
        .await
        .expect("build client");

    register_with_dummy_auth(&client, &username, "testpass123")
        .await
        .expect("registration succeeds against a homeserver with open dummy-stage registration");

    let session = client
        .matrix_auth()
        .session()
        .expect("a session is set on the client after registration");
    assert_eq!(session.meta.user_id.localpart(), username);

    // Prove the session is actually usable, not just present.
    client
        .whoami()
        .await
        .expect("the freshly registered session can make an authenticated request");
}
