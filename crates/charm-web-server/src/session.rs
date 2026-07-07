//! Ephemeral, in-memory session store.
//!
//! Sub-PR A scope: sessions live only for the lifetime of this process, keyed
//! by a server-issued opaque token (never client-chosen — see
//! [`SessionStore::create`]). No disk persistence, no encryption-at-rest —
//! that's sub-PR B (see the crate README).

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Arc;

use charm_lib::matrix::timeline::RoomTimelineUpdate;
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
    /// Verification events this session has generated (an incoming
    /// `verification:request`, an outgoing one from
    /// `sync_loop::request_device_verification`'s own "other device
    /// accepted" watcher, or a `verification:sas_update`) that no WebSocket
    /// client was connected to receive at the time — see
    /// `crate::routes::ws_handler`, which drains this on every new
    /// connection (and re-buffers anything it fails to actually deliver
    /// before the socket dies). A `broadcast::Sender::send` with zero
    /// subscribers simply drops the event (returns an error, which every
    /// handler already checks for before deciding whether to buffer), and
    /// none of these three event kinds — unlike `room_list:update`/
    /// `timeline:update`, which the *next* sync iteration naturally
    /// resends — are ever reissued by anything later: a verification flow's
    /// events only ever fire once each as the flow progresses. Losing one
    /// (e.g. because it landed during login/register/restore's own initial
    /// sync, before `finish_login` can even return a cookie for a browser
    /// to open a WebSocket with, or during a reconnect gap) leaves the flow
    /// permanently stuck with no way for the browser to ever learn what
    /// happened. Bounded defensively (verification flows are rare in
    /// practice) so an abandoned session with nobody ever connecting can't
    /// grow this unboundedly; `sync_loop::buffer_verification_event`
    /// additionally dedupes `verification:sas_update` by flow id, since
    /// only the *latest* state per flow is ever worth resuming from.
    pub pending_verification_events: Arc<std::sync::Mutex<Vec<ServerEvent>>>,
}

/// See `Session::pending_verification_events`'s doc comment.
pub(crate) const MAX_PENDING_VERIFICATION_EVENTS: usize = 20;

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
            pending_verification_events: Arc::new(std::sync::Mutex::new(Vec::new())),
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
/// Applies each `VectorDiff` batch to a local snapshot and re-summarizes via
/// `charm_lib::matrix::timeline::items_to_summaries` (the same `pub`
/// snapshot-to-DTO function desktop's own listener uses) — **not**
/// `get_timeline_page_impl`, which this used in an earlier version of this
/// function: that helper unconditionally calls `Timeline::paginate_backwards`
/// before taking its snapshot, since its actual job is serving the HTTP
/// `GET .../timeline` "load older messages" route. Calling it from *every*
/// live diff meant every new message/edit in a room silently walked that
/// room's backward-pagination cursor further back and fetched more history
/// the user never asked for — a real bug, not just a style choice, since it
/// also meant a genuine "load older" request racing a live update could
/// return duplicated or skipped history depending on which of the two had
/// most recently moved the cursor.
fn spawn_timeline_listener(
    client: Client,
    timeline: std::sync::Weak<Timeline>,
    room_id: matrix_sdk::ruma::OwnedRoomId,
    events: broadcast::Sender<ServerEvent>,
) {
    use futures_util::StreamExt;

    const LIVENESS_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

    let own_user_id = client.user_id().map(ToOwned::to_owned);

    tokio::spawn(async move {
        let Some(strong) = timeline.upgrade() else {
            return;
        };
        let (mut items, mut stream) = strong.subscribe().await;
        drop(strong);

        // Emit the current snapshot immediately on subscribe, not just on
        // the next diff — mirrors desktop's `spawn_timeline_listener`
        // (`timeline.rs`'s own initial `app.emit`). Without this, a room
        // opened via `get_or_create_timeline` (which is what spawns this
        // listener in the first place) would show nothing over the
        // WebSocket until the *next* live event happened to arrive; the
        // `GET .../timeline` HTTP route separately serves the same initial
        // page on request, but a frontend that treats the WebSocket as its
        // single source of live room state (again, matching desktop's own
        // contract) would otherwise see an empty room until then.
        let initial_messages = charm_lib::matrix::timeline::items_to_summaries(
            &items,
            own_user_id.as_deref(),
            &client,
            None,
        )
        .await;
        let _ = events.send(ServerEvent::Timeline(RoomTimelineUpdate {
            room_id: room_id.to_string(),
            messages: initial_messages,
        }));

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
            let Some(diffs) = diffs else { break };
            if timeline.upgrade().is_none() {
                break;
            }
            for diff in diffs {
                diff.apply(&mut items);
            }
            // No media cache in this crate yet (matches every other
            // `items_to_summaries`/`snapshot_rooms` call site here) — media
            // metadata is still carried, just without a locally resolved
            // thumbnail path.
            let messages = charm_lib::matrix::timeline::items_to_summaries(
                &items,
                own_user_id.as_deref(),
                &client,
                None,
            )
            .await;
            let _ = events.send(ServerEvent::Timeline(RoomTimelineUpdate {
                room_id: room_id.to_string(),
                messages,
            }));
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
