//! Multi-session isolation test (named acceptance criterion in Spec 16):
//! two concurrent sessions on the same `SessionStore` must never be able to
//! reach each other's `Client`, and an unknown/forged token must never
//! resolve to *any* session.
//!
//! Doesn't require a live homeserver — it exercises `SessionStore` itself
//! (token issuance, lookup, removal), which is where cross-session leakage
//! would actually occur. HTTP-level end-to-end isolation tests against a
//! real Synapse belong in a later slice once this crate has its own test
//! harness (see the crate README's "Deferred" section).

use charm_web_server::session::{Session, SessionStore};
use matrix_sdk::Client;

async fn dummy_session(user_id: &str) -> Session {
    let client = Client::builder()
        .homeserver_url("http://localhost:1")
        .build()
        .await
        .expect(
            "building a client against an unreachable homeserver shouldn't require network access",
        );
    Session::new(client, user_id.to_string())
}

#[tokio::test]
async fn distinct_sessions_get_distinct_unguessable_tokens() {
    let store = SessionStore::new();
    let a = store
        .create(dummy_session("@alice:example.org").await)
        .await;
    let b = store.create(dummy_session("@bob:example.org").await).await;

    assert_ne!(a, b, "two sessions must never share a token");
    assert!(
        a.len() >= 32,
        "session tokens must have real entropy, not be short/guessable"
    );
}

#[tokio::test]
async fn a_session_token_only_ever_resolves_its_own_session() {
    let store = SessionStore::new();
    let a = store
        .create(dummy_session("@alice:example.org").await)
        .await;
    let b = store.create(dummy_session("@bob:example.org").await).await;

    let entry_a = store.get(&a).await.expect("session a must resolve");
    let entry_b = store.get(&b).await.expect("session b must resolve");

    assert_eq!(entry_a.user_id, "@alice:example.org");
    assert_eq!(entry_b.user_id, "@bob:example.org");
    assert!(!std::sync::Arc::ptr_eq(&entry_a, &entry_b));
}

#[tokio::test]
async fn unknown_token_resolves_to_nothing() {
    let store = SessionStore::new();
    let _real = store
        .create(dummy_session("@alice:example.org").await)
        .await;

    assert!(store.get("this-token-was-never-issued").await.is_none());
    assert!(store.get("").await.is_none());
}

#[tokio::test]
async fn removing_one_session_never_affects_another() {
    let store = SessionStore::new();
    let a = store
        .create(dummy_session("@alice:example.org").await)
        .await;
    let b = store.create(dummy_session("@bob:example.org").await).await;

    store.remove(&a).await;

    assert!(
        store.get(&a).await.is_none(),
        "removed session must be gone"
    );
    assert!(
        store.get(&b).await.is_some(),
        "unrelated session must be unaffected"
    );
}
