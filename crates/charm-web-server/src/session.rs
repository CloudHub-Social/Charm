//! Ephemeral, in-memory session store.
//!
//! Sub-PR A scope: sessions live only for the lifetime of this process, keyed
//! by a server-issued opaque token (never client-chosen — see
//! [`SessionStore::create`]). No disk persistence, no encryption-at-rest —
//! that's sub-PR B (see the crate README).

use std::collections::HashMap;
use std::sync::Arc;

use matrix_sdk::Client;
use rand::distr::Alphanumeric;
use rand::RngExt;
use tokio::sync::RwLock;

/// Number of random alphanumeric characters in a session token — comfortably
/// large to make guessing/brute-forcing infeasible for an in-memory,
/// process-lifetime secret.
const SESSION_TOKEN_LEN: usize = 48;

/// One authenticated web-client session: the logged-in `Client` plus the
/// account id it belongs to (used only for diagnostics/logging — every
/// lookup is keyed by the opaque token, never by user id, so there's no path
/// from a guessed/leaked user id to another user's session).
pub struct Session {
    pub client: Client,
    pub user_id: String,
}

/// `Arc<RwLock<HashMap<...>>>` so it can be cloned cheaply into axum's
/// `State` and shared across request handlers/tasks.
#[derive(Clone, Default)]
pub struct SessionStore {
    inner: Arc<RwLock<HashMap<String, Arc<Session>>>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mints a fresh, server-chosen opaque token, stores `session` under it,
    /// and returns the token to be set as the session cookie's value. Tokens
    /// are never derived from or influenced by client input.
    pub async fn create(&self, session: Session) -> String {
        let token: String = rand::rng()
            .sample_iter(&Alphanumeric)
            .take(SESSION_TOKEN_LEN)
            .map(char::from)
            .collect();

        self.inner
            .write()
            .await
            .insert(token.clone(), Arc::new(session));
        token
    }

    pub async fn get(&self, token: &str) -> Option<Arc<Session>> {
        self.inner.read().await.get(token).cloned()
    }

    pub async fn remove(&self, token: &str) {
        self.inner.write().await.remove(token);
    }
}
