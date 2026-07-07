//! Ephemeral, in-memory session store.
//!
//! Sub-PR A scope: sessions live only for the lifetime of this process, keyed
//! by a server-issued opaque token (never client-chosen — see
//! [`SessionStore::create`]). No disk persistence, no encryption-at-rest —
//! that's sub-PR B (see the crate README).

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Arc;

use matrix_sdk::Client;
use matrix_sdk_ui::Timeline;
use rand::distr::Alphanumeric;
use rand::RngExt;
use tokio::sync::{Mutex, RwLock};

/// Number of random alphanumeric characters in a session token — comfortably
/// large to make guessing/brute-forcing infeasible for an in-memory,
/// process-lifetime secret.
const SESSION_TOKEN_LEN: usize = 48;

/// How many rooms' live `matrix-sdk-ui` `Timeline`s one session holds open
/// at once — same bound and rationale as desktop's `MatrixState::
/// MAX_LIVE_TIMELINES` (see `src-tauri/src/matrix/mod.rs`): bounds memory so
/// visiting many rooms in one session doesn't grow the set of subscribed
/// timelines without limit. LRU-evicted.
const MAX_LIVE_TIMELINES: usize = 20;

/// One authenticated web-client session: the logged-in `Client`, the account
/// id it belongs to (used only for diagnostics/logging — every lookup is
/// keyed by the opaque token, never by user id, so there's no path from a
/// guessed/leaked user id to another user's session), and this session's
/// live per-room `Timeline`s.
pub struct Session {
    pub client: Client,
    pub user_id: String,
    /// Mirrors desktop's `MatrixState::get_or_create_timeline`: a `Timeline`
    /// carries its own pagination cursor, so building a fresh one on every
    /// `get_timeline_page` request (as sub-PR A originally did) silently
    /// resets pagination and made "load older messages" always return the
    /// same first page. Caching per-room here, scoped to this session (never
    /// shared across sessions, keeping the same "session A can't see
    /// session B's state" isolation every other field on `Session` has).
    timelines: Mutex<lru::LruCache<matrix_sdk::ruma::OwnedRoomId, Arc<Timeline>>>,
}

impl Session {
    pub fn new(client: Client, user_id: String) -> Self {
        Self {
            client,
            user_id,
            timelines: Mutex::new(lru::LruCache::new(
                NonZeroUsize::new(MAX_LIVE_TIMELINES)
                    .expect("MAX_LIVE_TIMELINES is a nonzero constant"),
            )),
        }
    }

    /// Returns this session's cached `Timeline` for `room_id`, building and
    /// caching one on first access. Concurrent first-accesses for the same
    /// room can both build a `Timeline` (the lock isn't held across the
    /// `await`); whichever inserts first wins; the loser's freshly built one
    /// is simply dropped rather than run as a second, redundant listener.
    pub async fn get_or_create_timeline(
        &self,
        room_id: &matrix_sdk::ruma::RoomId,
    ) -> Result<Arc<Timeline>, String> {
        use matrix_sdk_ui::timeline::RoomExt as _;

        if let Some(existing) = self.timelines.lock().await.get(room_id) {
            return Ok(Arc::clone(existing));
        }

        let room = self
            .client
            .get_room(room_id)
            .ok_or_else(|| format!("room {room_id} not found"))?;
        let timeline = Arc::new(room.timeline().await.map_err(|e| e.to_string())?);

        let mut timelines = self.timelines.lock().await;
        if let Some(existing) = timelines.get(room_id) {
            return Ok(Arc::clone(existing));
        }
        timelines.put(room_id.to_owned(), Arc::clone(&timeline));
        Ok(timeline)
    }
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
    ///
    /// Retries on the astronomically unlikely case of a collision with an
    /// existing token — `HashMap::insert` would otherwise silently overwrite
    /// (and orphan) another session, which would violate the "two sessions
    /// must never share a token" isolation guarantee this store exists to
    /// provide (see `tests/isolation.rs`).
    pub async fn create(&self, session: Session) -> String {
        let session = Arc::new(session);
        loop {
            let token: String = rand::rng()
                .sample_iter(&Alphanumeric)
                .take(SESSION_TOKEN_LEN)
                .map(char::from)
                .collect();

            let mut inner = self.inner.write().await;
            if let std::collections::hash_map::Entry::Vacant(entry) = inner.entry(token.clone()) {
                entry.insert(session);
                return token;
            }
            // Collision: drop the write lock and mint a new token instead of
            // looping while holding it.
        }
    }

    pub async fn get(&self, token: &str) -> Option<Arc<Session>> {
        self.inner.read().await.get(token).cloned()
    }

    pub async fn remove(&self, token: &str) -> Option<Arc<Session>> {
        self.inner.write().await.remove(token)
    }
}
