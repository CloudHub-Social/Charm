//! Real network proof that room-alias resolution (used to route matrix.to
//! deep links that reference an alias rather than a raw room id) works.
//! Requires a local Synapse (`dev/synapse/` locally, a GitHub Actions
//! service container in CI) with a room published at
//! `#alias-test-room:localhost` and the test user from `tests/common`
//! already registered.

mod common;

use charm_lib::matrix::resolve_alias;
use common::logged_in_client;

#[tokio::test]
async fn resolve_alias_returns_the_room_id() {
    let client = logged_in_client().await;

    let room_id = resolve_alias(&client, "#alias-test-room:localhost")
        .await
        .expect("alias resolves");

    assert!(room_id.starts_with('!'));
    assert!(room_id.ends_with(":localhost"));
}

#[tokio::test]
async fn resolve_alias_rejects_a_malformed_alias() {
    let client = logged_in_client().await;

    // Rejected by RoomAliasId::parse before any network call, so this is fast
    // and deterministic — unlike a lookup for a genuinely nonexistent alias,
    // which triggers Synapse's federation-timeout path and made this suite
    // flaky/slow, so that case isn't covered here.
    let result = resolve_alias(&client, "not-a-valid-alias").await;
    assert!(result.is_err());
}
