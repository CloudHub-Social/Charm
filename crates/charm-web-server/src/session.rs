//! Ephemeral, in-memory session store.
//!
//! Sub-PR A scope: sessions live only for the lifetime of this process, keyed
//! by a server-issued opaque token (never client-chosen — see
//! [`SessionStore::create`]). No disk persistence, no encryption-at-rest —
//! that's sub-PR B (see the crate README).

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Arc;

use charm_lib::matrix::timeline::{get_timeline_page_impl, RoomTimelineUpdate};
use matrix_sdk::Client;
use matrix_sdk_ui::Timeline;
use rand::distr::Alphanumeric;
use rand::RngExt;
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::events::{ServerEvent, EVENT_CHANNEL_CAPACITY};

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
    /// Fan-out for this session's WebSocket event channel (sub-PR B) — the
    /// sync loop and per-room timeline listeners below push onto this;
    /// `crate::routes::ws_handler` subscribes one receiver per connected
    /// WebSocket. A session can have zero (no tab connected yet/right now)
    /// or more than one (multiple tabs) receivers at once; `broadcast`
    /// handles both.
    pub events: broadcast::Sender<ServerEvent>,
    /// The task driving this session's background sync loop (see
    /// `sync_loop::spawn`) — aborted on logout so a signed-out session
    /// doesn't keep polling `/sync` against the homeserver forever with
    /// nothing left to deliver its events to. `std::sync::Mutex`, not
    /// `tokio::sync::Mutex`: only ever touched synchronously (set once right
    /// after spawning, taken once on logout), never held across an `.await`.
    pub sync_handle: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The presence state the *next* `/sync` request should report, mirrors
    /// desktop's `MatrixState::sync_presence` — `sync_loop`'s steady-state
    /// loop reads this fresh on every iteration rather than baking a single
    /// `SyncSettings::default()` (always `Online`) into the whole loop, so
    /// an explicit `unavailable`/`offline` choice via `PUT /api/presence`
    /// actually sticks across syncs instead of being silently reverted to
    /// online by the next long-poll. `Arc` (not just a plain field): shared
    /// between this `Session` (routes.rs writes to it) and the sync-loop
    /// task spawned before the session is wrapped in the `SessionStore`'s
    /// own `Arc` (see `sync_loop::spawn`'s caller in `routes.rs`/`main.rs`).
    pub sync_presence: Arc<std::sync::Mutex<charm_lib::matrix::presence::PresenceStateDto>>,
}

impl Session {
    pub fn new(client: Client, user_id: String) -> Self {
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            client,
            user_id,
            sync_presence: Arc::new(std::sync::Mutex::new(
                charm_lib::matrix::presence::PresenceStateDto::default(),
            )),
            sync_handle: std::sync::Mutex::new(None),
            timelines: Mutex::new(lru::LruCache::new(
                NonZeroUsize::new(MAX_LIVE_TIMELINES)
                    .expect("MAX_LIVE_TIMELINES is a nonzero constant"),
            )),
            events,
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
        // Re-check: another concurrent call may have built and inserted one
        // for this same room while this call was awaiting `room.timeline()`
        // above (lock isn't held across that await) — keep whichever was
        // inserted first, and don't spawn a second, redundant listener for it.
        if let Some(existing) = timelines.get(room_id) {
            return Ok(Arc::clone(existing));
        }

        spawn_timeline_listener(
            self.client.clone(),
            Arc::downgrade(&timeline),
            room_id.to_owned(),
            self.events.clone(),
        );
        timelines.put(room_id.to_owned(), Arc::clone(&timeline));
        Ok(timeline)
    }
}

/// Pushes `timeline:update` every time this room's live `Timeline` reports a
/// diff, for as long as the `Timeline` stays alive (weak handle: once it's
/// LRU-evicted from `Session::timelines` and every other clone is dropped,
/// this listener notices on its next diff/liveness tick and exits rather
/// than keeping the room's sync subscription alive forever).
///
/// Deliberately simpler than desktop's `timeline::spawn_timeline_listener`:
/// rather than hand-diffing `matrix-sdk-ui`'s `VectorDiff`s into a
/// `RoomMessageSummary` list itself (that logic is desktop-internal, not
/// `pub`), this just re-fetches the current page via the same
/// `get_timeline_page_impl` the HTTP `GET .../timeline` route already uses
/// on every diff. A browser tab already has a full page of messages loaded
/// client-side, so re-sending that page on every diff is more bytes than a
/// true incremental patch, but is correct and reuses the one page-building
/// code path this crate has — revisit if a room with very high message
/// volume makes this too chatty for a real deployment.
fn spawn_timeline_listener(
    client: Client,
    timeline: std::sync::Weak<Timeline>,
    room_id: matrix_sdk::ruma::OwnedRoomId,
    events: broadcast::Sender<ServerEvent>,
) {
    use futures_util::StreamExt;

    const LIVENESS_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

    tokio::spawn(async move {
        let Some(strong) = timeline.upgrade() else {
            return;
        };
        let (_initial_items, mut stream) = strong.subscribe().await;
        drop(strong);

        let mut liveness_check = tokio::time::interval(LIVENESS_CHECK_INTERVAL);
        loop {
            let diffs = tokio::select! {
                diffs = stream.next() => diffs,
                _ = liveness_check.tick() => {
                    if timeline.upgrade().is_some() {
                        continue;
                    }
                    break;
                }
            };
            if diffs.is_none() {
                break;
            }
            let Some(strong) = timeline.upgrade() else {
                break;
            };
            if let Ok(page) = get_timeline_page_impl(&client, &strong, None, None).await {
                let _ = events.send(ServerEvent::Timeline(RoomTimelineUpdate {
                    room_id: room_id.to_string(),
                    messages: page.messages,
                }));
            }
        }
    });
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

    /// Inserts `session` under a caller-chosen `token` — used only at
    /// startup to reinsert a persisted session under the exact token it was
    /// issued to a browser under before the restart (see
    /// `persistence::PersistenceStore::restore_all` and `main.rs`), so an
    /// already-set cookie keeps working. Never exposed to request handlers:
    /// every other insertion path goes through [`Self::create`]'s
    /// server-chosen token, preserving the "tokens are never client/caller
    /// influenced at request time" property.
    pub async fn insert(&self, token: String, session: Session) {
        self.inner.write().await.insert(token, Arc::new(session));
    }

    pub async fn get(&self, token: &str) -> Option<Arc<Session>> {
        self.inner.read().await.get(token).cloned()
    }

    pub async fn remove(&self, token: &str) -> Option<Arc<Session>> {
        self.inner.write().await.remove(token)
    }
}
