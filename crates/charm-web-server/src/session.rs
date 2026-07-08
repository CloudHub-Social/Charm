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
    /// The most recent `sync:state`/`room_list:update`/`badge:update` triple
    /// `sync_loop`'s background loop produced, replayed by
    /// `crate::routes::ws_handler` on every new connection *before* it
    /// starts forwarding live events. Unlike the verification-event buffer
    /// above, this isn't "delivery guaranteed once" bookkeeping — it's a
    /// plain overwrite-in-place cache of "whatever's current", replayed
    /// every time regardless of whether a previous connection already saw
    /// it. Without this, a browser that opens its WebSocket any time after
    /// the very first sync iteration (essentially always, in practice:
    /// login/restore's own initial sync — and therefore the loop's first
    /// emit — completes before `finish_login` can even return a session
    /// cookie for a browser to open a socket with) would see nothing at all
    /// until the *next* sync iteration happened to change something,
    /// leaving the room list/badge/sync-status blank in the meantime.
    pub last_snapshot: Arc<std::sync::Mutex<Vec<ServerEvent>>>,
    /// The latest `timeline:update` per room this session has an open
    /// `Timeline` for — the per-room counterpart to `last_snapshot` above,
    /// replayed alongside it by `crate::routes::ws_handler` on every new
    /// connection. Without this, a WebSocket that's disconnected (a
    /// reconnecting tab, a brief network blip) while an already-open room
    /// keeps receiving live diffs would miss every message/edit/reaction
    /// that arrived during the gap: `spawn_timeline_listener`'s `events.send`
    /// is best-effort broadcast with no receiver during that window, and
    /// unlike `sync:state`/`room_list:update` (naturally resent by the
    /// *next* sync iteration regardless of what changed), a room's next
    /// `timeline:update` only fires on that room's next diff — which might
    /// not happen again for a long time, or ever, if the missed message was
    /// the last one sent. Keyed per room (not a single overwrite-in-place
    /// slot like `last_snapshot`) since more than one room can be open at
    /// once and each has its own independent history. Value is
    /// `(generation, event)`: `generation` is `spawn_timeline_listener`'s own
    /// per-listener-instance counter, so its cleanup on exit only removes
    /// the entry if it still owns it (see that function's doc comment) — a
    /// room can be LRU-evicted and reopened (a fresh listener spawned) while
    /// the *old* listener's 30s liveness check hasn't yet noticed its
    /// `Timeline` is gone; without the generation check, that old listener's
    /// eventual cleanup would delete the *new* listener's already-inserted
    /// snapshot for the same room, silently losing reconnect-replay for a
    /// room that's actually still open.
    pub room_snapshots:
        Arc<std::sync::Mutex<HashMap<matrix_sdk::ruma::OwnedRoomId, (u64, ServerEvent)>>>,
    /// The latest `room_details:update` per room, the `room_details:update`
    /// counterpart to `room_snapshots` above — `sync_loop::emit_room_updates`
    /// updates this whenever a synced state event changes a room's details,
    /// and `crate::routes::ws_handler` replays it alongside `room_snapshots`
    /// on every new connection. Same gap this closes: `useRoomDetails` on
    /// the frontend expects this push to keep its query cache current rather
    /// than polling, so a disconnect/reconnect gap while a room's
    /// name/power-levels/membership changed would otherwise leave the
    /// details panel and member list stale until the room is remounted.
    pub room_details_snapshots:
        Arc<std::sync::Mutex<HashMap<matrix_sdk::ruma::OwnedRoomId, ServerEvent>>>,
    /// The accumulated latest read receipt per (room, user, receipt type),
    /// updated by `sync_loop::emit_room_updates` on every `m.receipt` delta
    /// and replayed as one `receipts:update` per room by
    /// `crate::routes::ws_handler` on every new connection. Unlike
    /// `room_snapshots`/`room_details_snapshots` above (each just an
    /// overwrite-in-place "latest full state"), `receipts:update` is
    /// documented and treated by the frontend (`useReadReceipts`) as a pure
    /// *delta* stream with no snapshot/refetch concept — so a connection gap
    /// isn't fixed by replaying only the most recent delta (that would drop
    /// every other user's receipt that changed during the same gap); this
    /// has to actually accumulate current per-user state and replay all of
    /// it, the same shape a subscriber would have built up by receiving
    /// every individual delta live.
    pub receipt_snapshots: Arc<
        std::sync::Mutex<
            HashMap<matrix_sdk::ruma::OwnedRoomId, Vec<charm_lib::matrix::ephemeral::EventReceipt>>,
        >,
    >,
    /// The latest `typing:update` per room — an overwrite-in-place "latest
    /// full state" cache like `room_snapshots`/`room_details_snapshots`
    /// (`m.typing` is always a full replace of the currently-typing set,
    /// never a delta, so unlike `receipt_snapshots` there's nothing to
    /// accumulate). Without this, a WebSocket reconnect gap that spans both
    /// "user starts typing" and "user stops typing" would leave the
    /// frontend's typing indicator (`ChatShell`'s `onTypingUpdate`, which
    /// only clears on another typing event or a room change) stuck showing
    /// a user as typing indefinitely.
    pub typing_snapshots:
        Arc<std::sync::Mutex<HashMap<matrix_sdk::ruma::OwnedRoomId, ServerEvent>>>,
    /// The signed-in user's latest `profile:self` update (display
    /// name/avatar change), replayed on every new WebSocket connection. The
    /// frontend's `useOwnProfile` hook only refetches on mount or on this
    /// invalidation event — without a replay, a profile change that lands
    /// while a tab's WebSocket is disconnected leaves the header/profile
    /// chip stale until a remount.
    pub profile_snapshot: Arc<std::sync::Mutex<Option<ServerEvent>>>,
    /// The latest `presence:update` per user this session has seen. The
    /// frontend's `usePresence` only does a one-shot `getPresence` fetch
    /// when a user's presence atom is still empty — once populated, it
    /// relies entirely on live `presence:update` pushes to stay current, so
    /// a presence change missed during a WebSocket reconnect gap would
    /// otherwise leave that user's status stale indefinitely.
    pub presence_snapshots:
        Arc<std::sync::Mutex<HashMap<matrix_sdk::ruma::OwnedUserId, ServerEvent>>>,
}

/// Bundles `Session`'s "current state, replayed to every new connection"
/// caches (everything except `room_snapshots`, which
/// `get_or_create_timeline`'s per-room listener manages independently of
/// `sync_loop`) into one `Clone`-able value — `sync_loop::spawn` and
/// `emit_room_updates` take this as a single parameter rather than one
/// separate `Arc<Mutex<...>>` argument per cache, keeping their signatures
/// under clippy's `too_many_arguments` threshold.
#[derive(Clone)]
pub struct SyncSnapshots {
    pub last_snapshot: Arc<std::sync::Mutex<Vec<ServerEvent>>>,
    pub room_details_snapshots:
        Arc<std::sync::Mutex<HashMap<matrix_sdk::ruma::OwnedRoomId, ServerEvent>>>,
    pub receipt_snapshots: Arc<
        std::sync::Mutex<
            HashMap<matrix_sdk::ruma::OwnedRoomId, Vec<charm_lib::matrix::ephemeral::EventReceipt>>,
        >,
    >,
    pub typing_snapshots:
        Arc<std::sync::Mutex<HashMap<matrix_sdk::ruma::OwnedRoomId, ServerEvent>>>,
}

impl Session {
    pub fn sync_snapshots(&self) -> SyncSnapshots {
        SyncSnapshots {
            last_snapshot: self.last_snapshot.clone(),
            room_details_snapshots: self.room_details_snapshots.clone(),
            receipt_snapshots: self.receipt_snapshots.clone(),
            typing_snapshots: self.typing_snapshots.clone(),
        }
    }
}

/// `profile_snapshot`/`presence_snapshots` are updated by handlers
/// registered directly on the `Client` (`sync_loop::register_presence_handler`/
/// `register_self_profile_handler`) rather than by `sync_loop::spawn`'s own
/// loop like `SyncSnapshots`'s fields — passed as their own clones into
/// `sync_loop::register_event_handlers` rather than folded into
/// `SyncSnapshots`, matching that function's existing `events`/
/// `pending_verification_events` parameter shape.
pub struct ProfileAndPresenceSnapshots {
    pub profile_snapshot: Arc<std::sync::Mutex<Option<ServerEvent>>>,
    pub presence_snapshots:
        Arc<std::sync::Mutex<HashMap<matrix_sdk::ruma::OwnedUserId, ServerEvent>>>,
}

impl Session {
    pub fn profile_and_presence_snapshots(&self) -> ProfileAndPresenceSnapshots {
        ProfileAndPresenceSnapshots {
            profile_snapshot: self.profile_snapshot.clone(),
            presence_snapshots: self.presence_snapshots.clone(),
        }
    }
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
            last_snapshot: Arc::new(std::sync::Mutex::new(Vec::new())),
            room_snapshots: Arc::new(std::sync::Mutex::new(HashMap::new())),
            room_details_snapshots: Arc::new(std::sync::Mutex::new(HashMap::new())),
            receipt_snapshots: Arc::new(std::sync::Mutex::new(HashMap::new())),
            typing_snapshots: Arc::new(std::sync::Mutex::new(HashMap::new())),
            profile_snapshot: Arc::new(std::sync::Mutex::new(None)),
            presence_snapshots: Arc::new(std::sync::Mutex::new(HashMap::new())),
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
            self.room_snapshots.clone(),
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
    room_snapshots: Arc<
        std::sync::Mutex<HashMap<matrix_sdk::ruma::OwnedRoomId, (u64, ServerEvent)>>,
    >,
) {
    use futures_util::StreamExt;

    // Uniquely identifies *this* listener instance among any other listener
    // (past or future) for the same room — see `Session::room_snapshots`'s
    // doc comment for why the cleanup at the end of this function needs it.
    static NEXT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let generation = NEXT_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

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
        let initial_event = ServerEvent::Timeline(RoomTimelineUpdate {
            room_id: room_id.to_string(),
            messages: initial_messages,
        });
        room_snapshots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(room_id.clone(), (generation, initial_event.clone()));
        let _ = events.send(initial_event);

        let mut liveness_check = tokio::time::interval(LIVENESS_CHECK_INTERVAL);
        // The first `tick()` fires immediately, not after the first
        // interval — skip it so this doesn't do a redundant liveness check
        // the instant the listener starts, on top of whatever `stream.next()`
        // already resolves first (same fix as the WS keepalive in
        // `routes.rs`).
        liveness_check.tick().await;
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
            let event = ServerEvent::Timeline(RoomTimelineUpdate {
                room_id: room_id.to_string(),
                messages,
            });
            room_snapshots
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(room_id.clone(), (generation, event.clone()));
            let _ = events.send(event);
        }
        // The `Timeline` is gone (evicted, or the session itself is gone) —
        // drop this room's cached snapshot too, so a stale, possibly very
        // old room state doesn't keep getting replayed to every future
        // connection for a room this session no longer has open. If the
        // room is reopened later, `get_or_create_timeline` spawns a fresh
        // listener that repopulates this from a fresh subscribe.
        //
        // Only remove if the entry still belongs to *this* listener
        // (matching generation) — a room can be LRU-evicted and reopened
        // (spawning a fresh listener with a fresh snapshot already inserted)
        // before this old listener's own liveness check notices its
        // `Timeline` is gone and reaches this cleanup. Removing
        // unconditionally would delete the new listener's live entry out
        // from under it.
        {
            let mut snapshots = room_snapshots.lock().unwrap_or_else(|e| e.into_inner());
            if snapshots
                .get(&room_id)
                .is_some_and(|(g, _)| *g == generation)
            {
                snapshots.remove(&room_id);
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
