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
    Session::new(client, user_id.to_string(), None)
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

/// `SessionStore::insert` is only ever used to reinsert a persisted session
/// under its original token at startup (see `persistence.rs`/`main.rs`) —
/// this exercises that path directly, standing in for "a restart doesn't
/// merge or leak sessions across accounts" without needing a real encrypted
/// persistence file on disk (that round trip is covered in
/// `persistence.rs`'s own unit tests).
#[tokio::test]
async fn restart_survival_reinsertion_preserves_isolation_across_accounts() {
    let store = SessionStore::new();
    let token_a = "restored-token-for-alice".to_string();
    let token_b = "restored-token-for-bob".to_string();

    store
        .insert(token_a.clone(), dummy_session("@alice:example.org").await)
        .await;
    store
        .insert(token_b.clone(), dummy_session("@bob:example.org").await)
        .await;

    let entry_a = store.get(&token_a).await.expect("alice must resolve");
    let entry_b = store.get(&token_b).await.expect("bob must resolve");
    assert_eq!(entry_a.user_id, "@alice:example.org");
    assert_eq!(entry_b.user_id, "@bob:example.org");
    assert!(!std::sync::Arc::ptr_eq(&entry_a, &entry_b));

    // A token that was never inserted (e.g. one issued after this
    // "restart") must still resolve to nothing — restoring persisted
    // sessions must not accidentally widen what counts as valid.
    assert!(store.get("some-other-token").await.is_none());
}

/// The WebSocket fan-out channel (sub-PR B) is per-`Session`, not global —
/// this is the isolation guarantee that actually matters for it: one
/// session's events must never be observable on another session's receiver,
/// even though both sessions live in the same process and `SessionStore`.
#[tokio::test]
async fn each_sessions_event_channel_is_independent() {
    let store = SessionStore::new();
    let a = store
        .create(dummy_session("@alice:example.org").await)
        .await;
    let b = store.create(dummy_session("@bob:example.org").await).await;

    let session_a = store.get(&a).await.unwrap();
    let session_b = store.get(&b).await.unwrap();

    let mut receiver_a = session_a.events.subscribe();
    let mut receiver_b = session_b.events.subscribe();

    let _ = session_a
        .events
        .send(charm_web_server::events::ServerEvent::SyncState(
            charm_lib::matrix::sync::SyncStateEvent::Idle,
        ));

    // Session A's subscriber sees the event...
    let received = tokio::time::timeout(std::time::Duration::from_secs(1), receiver_a.recv())
        .await
        .expect("receiver_a should not time out")
        .expect("receiver_a should receive the event");
    assert!(matches!(
        received,
        charm_web_server::events::ServerEvent::SyncState(_)
    ));

    // ...but session B's subscriber, on an entirely separate broadcast
    // channel, never does.
    let nothing_for_b =
        tokio::time::timeout(std::time::Duration::from_millis(200), receiver_b.recv()).await;
    assert!(
        nothing_for_b.is_err(),
        "session B must never observe session A's events"
    );
}
