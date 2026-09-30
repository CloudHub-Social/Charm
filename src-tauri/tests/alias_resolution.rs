//! Real network proof that room-alias resolution (used to route matrix.to
//! deep links that reference an alias rather than a raw room id) works.
//! Requires a local Synapse (`dev/synapse/` locally, a GitHub Actions
//! service container in CI) with a room published at
//! `#alias-test-room:localhost` and the test user from `tests/common`
//! already registered.

mod common;

use charm_lib::matrix::rooms::resolve_alias;
use common::{logged_in_client, synced_client};

#[tokio::test]
async fn resolve_alias_returns_the_room_id() {
    let client = synced_client().await;
    let expected_room = client
        .joined_rooms()
        .into_iter()
        .find(|room| {
            room.canonical_alias()
                .is_some_and(|alias| alias.as_str() == "#alias-test-room:localhost")
        })
        .expect("fixture room is joined and has its canonical alias");

    let room_id = resolve_alias(&client, "#alias-test-room:localhost")
        .await
        .expect("alias resolves");

    // Room IDs are opaque; modern room versions do not include a server name.
    assert_eq!(room_id, expected_room.room_id().as_str());
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
