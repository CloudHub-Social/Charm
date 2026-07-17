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

/// Env var overriding [`DEFAULT_IDLE_TIMEOUT_SECS`] — see `main.rs`'s
/// periodic sweep task, which calls [`SessionStore::sweep_idle`] with
/// whichever of these two applies.
pub const IDLE_TIMEOUT_SECS_ENV: &str = "CHARM_WEB_SERVER_SESSION_IDLE_TIMEOUT_SECS";

/// How long a session (with no WebSocket connected — see
/// `Session::has_open_connection`) can go without an authenticated HTTP
/// request before `main.rs`'s periodic sweep evicts its in-memory `Client`.
/// 30 minutes: long enough that a user reading a long thread or stepping
/// away for a coffee without touching a room doesn't get evicted mid-session
/// (an open WebSocket keeps the session alive regardless, so this really
/// only bounds "tab open, nobody home, nothing polling it"), short enough
/// that a genuinely abandoned session's full `matrix_sdk::Client` (event
/// cache, crypto state, the works) doesn't sit in memory indefinitely on a
/// small instance. Eviction only drops the in-memory `Client` — the
/// persisted session is left alone and restored on demand if the cookie
/// comes back (see `persistence::PersistenceStore::restore_by_token`), so
/// this is purely a memory-pressure knob, not a security timeout.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 30 * 60;

/// How long the browser should hold onto the session cookie itself —
/// separate from [`DEFAULT_IDLE_TIMEOUT_SECS`], which only bounds the
/// in-memory `Client`, not the cookie or the persisted session it points at.
/// `persistence.rs` has no expiry on a persisted session at all (it lives
/// until explicit logout), so the cookie must outlive any plausible gap
/// between visits — otherwise the browser drops it as soon as it closes
/// (a cookie with no `Max-Age`/`Expires` is a session-only cookie), forcing
/// a full re-login and, with it, a brand-new Matrix device that needs the
/// recovery key again even though the server-side crypto store (Spec 25)
/// was never actually lost. 30 days: a conventional "remember me" window,
/// comfortably past `EVICTED_PRESENCE_MAX_AGE`'s week-long vacation case.
pub const SESSION_COOKIE_MAX_AGE_SECS: i64 = 30 * 24 * 60 * 60;

/// Minimum gap `routes::refresh_session_cookie` leaves between two
/// `PersistenceStore::touch_last_seen` calls for the same continuously-live
/// session — see [`Session::last_persistence_touch_unix`]'s doc comment for
/// why this exists at all. An hour comfortably keeps `last_seen_unix` within
/// `SESSION_COOKIE_MAX_AGE_SECS`'s 30-day window for any session seeing at
/// least one request per day, while capping the write-amplification cost of
/// a session under continuous heavy traffic to one object-store write an
/// hour rather than one per request.
pub const PERSISTENCE_TOUCH_THROTTLE_SECS: u64 = 60 * 60;

/// [`SESSION_COOKIE_MAX_AGE_SECS`] as a [`std::time::Duration`] — the exact
/// window `routes::session_cookie`'s `Max-Age` header uses. `.max(0)` guards
/// the `i64`→`u64` cast even though the constant is a positive literal, the
/// same defensive habit the call sites had before this helper existed. Only
/// `session_cookie` itself should use this one directly — every
/// server-side *revocation* decision (`PersistenceStore::is_expired`,
/// `sweep_expired`, `restore_all`) needs [`session_revocation_grace`]
/// instead.
pub fn session_cookie_max_age() -> std::time::Duration {
    std::time::Duration::from_secs(SESSION_COOKIE_MAX_AGE_SECS.max(0) as u64)
}

/// [`session_cookie_max_age`] plus [`PERSISTENCE_TOUCH_THROTTLE_SECS`] — the
/// window every server-side revocation check (`PersistenceStore::is_expired`,
/// `sweep_expired`, `restore_all`) uses instead of the bare cookie `Max-Age`.
/// `routes::refresh_session_cookie` extends the browser's cookie by a fresh
/// `SESSION_COOKIE_MAX_AGE_SECS` on every authenticated request, but only
/// bumps the server-side `last_seen_unix` at most once per
/// `PERSISTENCE_TOUCH_THROTTLE_SECS` (to avoid an object-store write on
/// every single request) — so right before that throttle next allows a
/// bump, `last_seen_unix` can lag the cookie's own actual freshness by up
/// to that same window. Checking expiry against the bare `Max-Age` window
/// would then let a server-side revocation reject or revoke a session the
/// browser's cookie is still genuinely valid for, forcing an avoidable
/// re-login (and, since e2ee verification doesn't survive that, a fresh
/// recovery-key prompt too) purely from the throttle's own bookkeeping lag,
/// not real inactivity (Codex review finding on #280).
pub fn session_revocation_grace() -> std::time::Duration {
    session_cookie_max_age() + std::time::Duration::from_secs(PERSISTENCE_TOUCH_THROTTLE_SECS)
}

/// How often `main.rs`'s periodic task calls [`SessionStore::sweep_idle`].
/// Shorter than the idle timeout itself so an idle session isn't kept around
/// much longer than the timeout implies, but long enough not to churn a
/// write-lock over the whole session map too often on a busy server.
pub const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// How long `SessionStore::evicted_presence` keeps an entry nobody has
/// restored yet before giving up on it — deliberately much longer than
/// `DEFAULT_IDLE_TIMEOUT_SECS`, since a persisted session (and the browser
/// cookie pointing at it) both stay restorable far longer than that; see
/// `sweep_idle`'s doc comment for why tying this to the idle timeout itself
/// was wrong. Seven days: long enough to cover a week-long vacation/absence,
/// short enough that a truly abandoned session's tiny presence-cache entry
/// doesn't linger forever.
const EVICTED_PRESENCE_MAX_AGE: std::time::Duration =
    std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// How many rooms' live `matrix-sdk-ui` `Timeline`s one session holds open
/// at once — same bound and rationale as desktop's `MatrixState::
/// MAX_LIVE_TIMELINES` (see `src-tauri/src/matrix/mod.rs`): bounds memory so
/// visiting many rooms in one session doesn't grow the set of subscribed
/// timelines without limit. LRU-evicted.
const MAX_LIVE_TIMELINES: usize = 20;

/// Identifies this session's on-disk crypto store (`crypto_store.rs`) —
/// `None` when persistence isn't configured, or for a session restored from
/// a `PersistedSession` written before Spec 25 shipped (requirement 9's
/// fail-open backfill). Cloned into `sync_loop::PersistHandle` at spawn time
/// so a later re-save (token refresh, idle-eviction) can keep writing the
/// same crypto fields rather than losing them on the very first re-save
/// after login.
#[derive(Clone)]
pub struct CryptoStoreHandle {
    pub store_key: String,
    pub passphrase: String,
}

/// Manual, not derived: the default `Debug` for a struct with a plaintext
/// `passphrase: String` field would print that passphrase verbatim on any
/// `{:?}` of a `Session`/`PersistHandle` that embeds this (e.g. an
/// unguarded debug log or panic message) — a secret capable of unlocking
/// this session's on-disk crypto store. `store_key` isn't secret on its own
/// (it's a directory name, not a credential), but there's no reason to log
/// it either.
impl std::fmt::Debug for CryptoStoreHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CryptoStoreHandle")
            .field("store_key", &self.store_key)
            .field("passphrase", &"<redacted>")
            .finish()
    }
}

/// One authenticated web-client session: the logged-in `Client`, the account
/// id it belongs to (used only for diagnostics/logging — every lookup is
/// keyed by the opaque token, never by user id, so there's no path from a
/// guessed/leaked user id to another user's session), and this session's
/// live per-room `Timeline`s.
pub struct Session {
    pub client: Client,
    pub user_id: String,
    /// The crypto-store key/passphrase pair to keep writing on every re-save
    /// of this session (token refresh, idle-eviction re-save) — deliberately
    /// *not* the same signal as [`Self::crypto_store_open`]. At restore this
    /// is populated from the persisted entry's fields whenever they exist,
    /// regardless of whether this particular restore attempt actually
    /// managed to open that store: if it didn't (transient lock/permissions
    /// issue, not necessarily the directory being gone for good), re-saves
    /// must still carry the *original* key/passphrase forward so a later
    /// restart gets another chance to open it — deriving this from
    /// `crypto_store_open` instead (an earlier revision of this field did
    /// exactly that) would silently overwrite the persisted pair with `None`
    /// on the very next re-save, permanently orphaning a store that might
    /// still be perfectly readable.
    pub persisted_crypto: Option<CryptoStoreHandle>,
    /// Whether *this* session's live `client` is actually backed by an
    /// opened on-disk crypto store right now — the signal
    /// [`Self::has_unpersisted_encrypted_room`] uses to gate idle eviction.
    /// This is about safety of evicting *this* client's current in-memory
    /// crypto state (accumulated since it was built, whether or not that
    /// happened to come from a successfully-opened store), which is a
    /// different question from "what should we keep telling
    /// `PersistenceStore::save` to write" ([`Self::persisted_crypto`]):
    /// e.g. a session whose store failed to open this restore attempt has
    /// `persisted_crypto = Some(..)` (so re-saves don't lose the original
    /// pair) but `crypto_store_open = false` (evicting it now would still
    /// lose whatever this fallback in-memory client has learned since it
    /// started, exactly like a session with no persisted store at all).
    pub crypto_store_open: bool,
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
    /// When this session last did something other than sit idle — bumped by
    /// `routes::require_session` on every authenticated HTTP request, so
    /// `SessionStore::sweep_idle` can tell a genuinely abandoned session
    /// (browser closed, cookie never coming back) apart from one that's just
    /// between requests. Deliberately *not* bumped by anything inside
    /// `sync_loop`'s own background loop — a session nobody is looking at
    /// shouldn't count as active just because it keeps long-polling `/sync`
    /// in the background, or idle eviction would never trigger for an
    /// abandoned browser tab that was left open. An open WebSocket
    /// connection is tracked separately (`ws_connections` below) and always
    /// counts as active regardless of this timestamp.
    pub last_active: std::sync::Mutex<std::time::Instant>,
    /// Separate from [`Self::last_active`] — the last time this session's
    /// activity was *transport-validated*, not merely "a request with a
    /// matching cookie reached `require_session`". `last_active` is bumped
    /// by `SessionStore::get`'s own `touch()` on every such request, which
    /// includes a same-site subdomain's untrusted "simple" (no-preflight,
    /// no custom-header) request — `routes::refresh_session_cookie`
    /// already refuses to slide the *cookie* for exactly that request shape
    /// (see its own doc comment), but `last_active` alone can't make the
    /// same distinction, since the touch happens deep inside
    /// `require_session`, well before that middleware's transport-header/
    /// `Origin` check ever runs. `SessionStore::is_genuinely_active` reads
    /// this field instead of `last_active` for exactly that reason:
    /// without it, an attacker who can get the browser to keep resending
    /// the victim's cookie on such requests (the cookie is never refreshed,
    /// but each request still reaches `require_session`'s fast path) could
    /// keep a pinned-but-abandoned session artificially "genuinely active"
    /// forever, bypassing `PersistenceStore::sweep_expired`'s revocation
    /// the same way the cookie-refresh gap did (Codex review finding on
    /// #280). Bumped only from `routes::refresh_session_cookie`, and only
    /// once its transport-header-or-allowed-origin check has already
    /// passed.
    pub last_validated_active: std::sync::Mutex<std::time::Instant>,
    /// Unix timestamp of the last time `routes::refresh_session_cookie`
    /// fired `PersistenceStore::touch_last_seen` for this session — `0`
    /// (never) initially. Throttles that call to at most once per
    /// `PERSISTENCE_TOUCH_THROTTLE_SECS`: without it, every single
    /// authenticated request on a continuously-live session (one that never
    /// idle-evicts, and so never otherwise revisits `PersistenceStore`)
    /// would write to the object store, purely to keep `last_seen_unix`
    /// fresh for a check (`PersistenceStore::sweep_expired`) that already
    /// skips anything resident in `SessionStore` regardless of that
    /// timestamp — closing a Sentry-flagged edge case
    /// (`refresh_session_cookie` extending the *cookie's* lifetime with no
    /// corresponding server-side signal) without paying a write on every
    /// request to do it.
    pub last_persistence_touch_unix: std::sync::atomic::AtomicU64,
    /// `true` only for a session whose *very first* `PersistenceStore::save`
    /// (in `routes::finish_login`, immediately after login/register) failed
    /// — a transient disk/lock error, not a sign anything is actually
    /// wrong with the session itself. `sync_loop`'s `repersist_if_token_changed`
    /// keeps retrying that first save in the background
    /// (`SaveMode::RetryInitialSave`) until it lands; until it does, there
    /// is genuinely no persisted object for this token yet, so
    /// `routes::refresh_session_cookie`'s durable touch reports
    /// `TouchOutcome::NotFound` on every request — indistinguishable, from
    /// that call alone, from a *different* token whose persisted record
    /// really was deleted by another instance's logout. Without this flag,
    /// an earlier revision of `refresh_session_cookie` treated both cases
    /// identically and force-logged out a brand-new session still waiting
    /// on its first successful save, defeating the documented
    /// keep-it-live-and-retry fallback entirely (Codex review finding on
    /// #280). Cleared back to `false` the moment *any* save actually lands
    /// — either `routes::refresh_session_cookie`'s durable touch succeeding
    /// (`TouchOutcome::Touched`), or `sync_loop::repersist_if_token_changed`'s
    /// own `SaveMode::RetryInitialSave` retry succeeding first, whichever
    /// happens sooner (a further Codex review finding on #280: without also
    /// clearing it from the retry-save path, a rolling-deploy/load-balanced
    /// sequence — retry succeeds, another instance logs the session out,
    /// this instance's next request arrives after that delete — would still
    /// misread the resulting `NotFound` as "initial save still pending"
    /// instead of a real cross-instance logout). `Arc`-wrapped so
    /// `sync_loop::PersistHandle` can share and clear the exact same flag
    /// `require_session`/`refresh_session_cookie` read, not a
    /// `sync_loop`-local copy that would never reach them. `false` for
    /// every other construction path (restored sessions —
    /// `restore_by_token`/`restore_all` — already came from a persisted
    /// record by definition, and a fresh login whose initial save actually
    /// succeeded has nothing to wait on).
    pub awaiting_initial_persistence: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Count of this session's currently-connected WebSocket clients (zero,
    /// one, or more — the same "zero or more tabs" shape as `events`
    /// above). `crate::routes::handle_socket` increments this on connect and
    /// decrements it on disconnect via a drop guard, so it stays accurate
    /// across every exit path (clean close, send failure, lag-induced
    /// close). `SessionStore::sweep_idle` never evicts a session with at
    /// least one connection open, regardless of `last_active` — a tab left
    /// open and quietly receiving live updates is active by definition, even
    /// if the user hasn't issued an HTTP request in a while.
    pub ws_connections: std::sync::atomic::AtomicUsize,
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
    pub fn new(
        client: Client,
        user_id: String,
        persisted_crypto: Option<CryptoStoreHandle>,
        crypto_store_open: bool,
    ) -> Self {
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            client,
            user_id,
            persisted_crypto,
            crypto_store_open,
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
            last_active: std::sync::Mutex::new(std::time::Instant::now()),
            last_validated_active: std::sync::Mutex::new(std::time::Instant::now()),
            last_persistence_touch_unix: std::sync::atomic::AtomicU64::new(0),
            awaiting_initial_persistence: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
                false,
            )),
            ws_connections: std::sync::atomic::AtomicUsize::new(0),
            events,
        }
    }

    /// Marks this session as active right now — see `last_active`'s doc
    /// comment for who calls this and why.
    pub fn touch(&self) {
        *self.last_active.lock().unwrap_or_else(|e| e.into_inner()) = std::time::Instant::now();
    }

    /// How long since this session was last touched by an authenticated HTTP
    /// request. Not itself sufficient to decide eviction — see
    /// `has_open_connection` and `SessionStore::sweep_idle`, which combines
    /// both.
    fn idle_for(&self) -> std::time::Duration {
        self.last_active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .elapsed()
    }

    /// Marks this session as *transport-validated* active right now — see
    /// `last_validated_active`'s doc comment for who calls this and why.
    pub fn touch_validated(&self) {
        *self
            .last_validated_active
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = std::time::Instant::now();
    }

    /// [`Self::idle_for`]'s counterpart for [`Self::last_validated_active`]
    /// — what `SessionStore::is_genuinely_active` actually reads.
    fn idle_for_validated(&self) -> std::time::Duration {
        self.last_validated_active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .elapsed()
    }

    /// Whether at least one WebSocket client is currently connected — see
    /// `ws_connections`'s doc comment.
    fn has_open_connection(&self) -> bool {
        self.ws_connections
            .load(std::sync::atomic::Ordering::Relaxed)
            > 0
    }

    /// Whether this session has an undelivered verification event sitting in
    /// `pending_verification_events`. Per that field's own doc comment, none
    /// of the three event kinds buffered there (`verification:request`, an
    /// outgoing "other device accepted", a `verification:sas_update`) are
    /// ever reissued once the sync loop has already produced them — the
    /// buffer *is* the only remaining copy until a WebSocket connects and
    /// `routes::handle_socket` drains it. Idle-evicting a session in that
    /// state would abort the sync loop and drop the `Client` with that
    /// buffer still non-empty; the entry itself survives on the `Session`
    /// (evicted sessions are simply dropped, not persisted separately), but
    /// there is no live sync loop left to eventually finish the flow, and no
    /// mechanism to hand the buffer to whatever fresh `Session` a later
    /// on-demand restore builds — so the verification flow would be
    /// silently stuck forever with no way for the browser to ever learn
    /// what happened. `SessionStore::sweep_idle` treats this the same as an
    /// open WebSocket connection: it keeps the session alive regardless of
    /// how long it's been idle until the buffer drains.
    fn has_pending_verification_events(&self) -> bool {
        !self
            .pending_verification_events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    }

    /// Whether this session belongs to at least one end-to-end-encrypted
    /// room *and* its live `client` isn't currently backed by an opened
    /// on-disk crypto store — a cheap, synchronous check
    /// (`Room::encryption_state` reads already-synced local state, no
    /// network call) used as a proxy for "evicting this session's in-memory
    /// `matrix_sdk::Client` would irrecoverably lose Megolm/Olm state, not
    /// just require a homeserver round-trip to rebuild it."
    ///
    /// Gates on [`Self::crypto_store_open`], not [`Self::persisted_crypto`]:
    /// the question here is whether *this client's* current in-memory crypto
    /// state (accumulated since it was built) would survive eviction, which
    /// is true only when this client is actually backed by a store on disk
    /// right now — a session whose store *exists* on disk but failed to open
    /// on this particular restore attempt (`persisted_crypto = Some(..)`,
    /// `crypto_store_open = false`) is running on a fallback in-memory
    /// client just like a session with no persisted store at all, so
    /// evicting it loses exactly the same kind of state.
    ///
    /// Before Spec 25, `charm-web-server` never persisted the Olm/Megolm
    /// crypto store at all — restoring a session (there, only ever after a
    /// full process restart) rebuilt a bare in-memory `Client` that could no
    /// longer decrypt history it had already learned, or continue an
    /// established verification. Idle eviction hit the exact same gap, just
    /// far more often (a normal 30-minute idle gap during the same process's
    /// uptime, not only a restart), so this exempted *any* encrypted-room
    /// session from idle eviction entirely — narrower than "never evict,"
    /// since a session that's never touched E2EE has nothing at risk, but
    /// still meant every E2EE session held its full `Client` (event cache,
    /// crypto state, timelines) in memory indefinitely regardless of how
    /// long it sat idle. Now that a session's crypto store is persisted
    /// (see `crypto_store.rs`), a session actually backed by an opened store
    /// can be safely evicted and restored again on demand — same as any
    /// other persisted session — so this exemption only still applies when
    /// this client currently has no working store to fall back on.
    fn has_unpersisted_encrypted_room(&self) -> bool {
        !self.crypto_store_open
            && self
                .client
                .rooms()
                .iter()
                .any(|room| room.encryption_state().is_encrypted())
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
    /// The presence choice an idle-evicted session had at the instant
    /// `sweep_idle` evicted it, keyed by token, paired with the `Instant` it
    /// was recorded at — populated there, consumed once by
    /// `routes::require_session`'s on-demand restore (via
    /// `take_evicted_presence`) to seed the freshly rebuilt `Session`'s
    /// `sync_presence` before its sync loop starts, instead of silently
    /// reverting an explicit `unavailable`/`offline` choice back to `Online`
    /// (see `sync_loop::spawn`'s doc comment for why that would otherwise
    /// happen). This is plain in-memory bookkeeping, not persisted — a full
    /// process restart already loses this the same way it loses everything
    /// else in-memory, no worse than before this existed; it only smooths
    /// over the *much* more frequent idle-eviction-then-restore case this
    /// module introduces.
    ///
    /// The recorded `Instant` isn't for `take_evicted_presence` — it's so
    /// `sweep_idle` can prune entries for tokens that were evicted but never
    /// came back (browser closed for good, cookie discarded). Without this,
    /// an entry inserted here lives forever: nothing else ever removes it
    /// except a restore that may never happen, so this map would otherwise
    /// grow without bound over the process's lifetime — the exact kind of
    /// unbounded memory growth this whole module exists to fix. `sweep_idle`
    /// prunes anything older than its own `idle_timeout` on every run, since
    /// that's the same "give up on this eventually" threshold already
    /// governing everything else in this store.
    evicted_presence: Arc<
        std::sync::Mutex<
            HashMap<
                String,
                (
                    charm_lib::matrix::presence::PresenceStateDto,
                    std::time::Instant,
                ),
            >,
        >,
    >,
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

    /// Inserts `session` under a caller-chosen `token` — for reinserting a
    /// persisted session under the exact token it was already issued to a
    /// browser as a cookie, so that already-set cookie keeps working. Two
    /// call sites do this: `main.rs`'s startup restore (see
    /// `persistence::PersistenceStore::restore_all`), and
    /// `routes::require_session`'s on-demand restore of an idle-evicted
    /// session (see `SessionStore::sweep_idle` and
    /// `persistence::PersistenceStore::restore_by_token`) — the latter *is*
    /// exposed to request handlers, updated from this doc comment's
    /// original claim otherwise.
    ///
    /// This still never lets a client or caller choose a *new* token,
    /// though: both call sites only ever pass back a token that was already
    /// a valid cookie for an existing persisted session (looked up by
    /// `sha256(token)` — see `persistence::object_path_for_token`), not one
    /// invented at request time. A request presenting an unknown or forged
    /// token never reaches this function at all; it 401s in
    /// `require_session` before any restore is attempted. Every *fresh*
    /// login still goes through [`Self::create`]'s server-chosen token —
    /// this function only ever re-establishes a token that already existed.
    pub async fn insert(&self, token: String, session: Session) {
        self.inner.write().await.insert(token, Arc::new(session));
    }

    /// Looks up `token` and marks the session active in the same step —
    /// `touch()` runs while this still holds `inner`'s read lock, which
    /// blocks `sweep_idle`'s write lock from running concurrently. Without
    /// that, a caller doing `get` then `touch()` as two separate steps (an
    /// earlier version of this did exactly that) leaves a gap between them
    /// where the sweeper can evict this exact session — a WebSocket upgrade
    /// racing the sweep in that gap could then attach to a `Session` that's
    /// already been removed from the store and whose sync loop is being
    /// aborted, leaving the browser connected to a dead event channel.
    /// Folding the touch in here closes that window: by the time this
    /// returns, the session is guaranteed fresh enough that this same sweep
    /// cycle can't have just evicted it.
    pub async fn get(&self, token: &str) -> Option<Arc<Session>> {
        let inner = self.inner.read().await;
        let session = inner.get(token)?;
        session.touch();
        Some(Arc::clone(session))
    }

    /// Whether `token`'s session is *genuinely* active right now — not
    /// merely resident in this map. `persistence::PersistenceStore::sweep_expired`
    /// uses this (never [`Self::get`]) to decide whether to skip revoking an
    /// expired session: `get` both mutates (`touch()`s `last_active`, which
    /// would itself silently reset the very idle clock this check needs to
    /// read) and treats bare map presence as proof of activity, which
    /// [`Self::sweep_idle`]'s own exemptions make false — a session with a
    /// pending verification event or an unpersisted encrypted room stays in
    /// this map *indefinitely*, with no idle timeout at all, regardless of
    /// whether a browser has touched it in months. Without this distinction,
    /// such a session would be permanently exempt from `sweep_expired`'s
    /// revocation the moment it entered one of those states, bypassing the
    /// whole retention model for exactly the sessions `sweep_idle` can never
    /// evict on its own (Codex review finding on #280).
    ///
    /// "Genuinely active" here means either an open WebSocket connection —
    /// safe to keep alive regardless of activity timestamps, same as
    /// `sweep_idle` itself, since revoking a token still backing a live
    /// connection would break it out from under the browser mid-session —
    /// or [`Session::last_validated_active`] (not the plain `last_active`
    /// `get`/`touch` maintain) within `max_age`. Using the validated
    /// timestamp specifically, not `last_active`, matters for the same
    /// reason `routes::refresh_session_cookie` gates the *cookie* refresh on
    /// a transport-header/`Origin` check: an untrusted same-site subdomain's
    /// request still reaches `require_session`'s fast path (bumping
    /// `last_active` via `get`'s own `touch()`) even though that middleware
    /// refuses to slide anything for it — using `last_active` here would
    /// let exactly that untrusted traffic keep a pinned-but-abandoned
    /// session artificially exempt from revocation forever (Codex review
    /// finding on #280). A session pinned by pending-verification/
    /// unpersisted-room state alone, with no open connection and no
    /// *validated* request in over `max_age`, is neither: it's eligible for
    /// revocation, exactly as if it had already been idle-evicted.
    pub async fn is_genuinely_active(&self, token: &str, max_age: std::time::Duration) -> bool {
        let inner = self.inner.read().await;
        let Some(session) = inner.get(token) else {
            return false;
        };
        session.has_open_connection() || session.idle_for_validated() < max_age
    }

    pub async fn remove(&self, token: &str) -> Option<Arc<Session>> {
        self.inner.write().await.remove(token)
    }

    /// Stable snapshot of the currently-live sessions for graceful process
    /// shutdown. Cloning the `Arc`s releases the map lock before any crypto
    /// snapshot I/O begins, so shutdown cannot hold up request handlers on a
    /// long object-store write.
    pub async fn entries(&self) -> Vec<(String, Arc<Session>)> {
        self.inner
            .read()
            .await
            .iter()
            .map(|(token, session)| (token.clone(), Arc::clone(session)))
            .collect()
    }

    /// Removes and returns every session idle longer than `idle_timeout`
    /// with no WebSocket currently connected (see `Session::idle_for` /
    /// `Session::has_open_connection`) — the caller (a periodic background
    /// task in `main.rs`) is responsible for cleaning up each returned
    /// session's `sync_handle` afterwards; this only touches the map itself,
    /// same division of responsibility as `routes::logout`.
    ///
    /// Deliberately does **not** touch `PersistenceStore` — an evicted
    /// session's persisted object is left exactly as-is, so a request
    /// arriving later with that session's still-valid cookie can restore it
    /// on demand (see `persistence::PersistenceStore::restore_by_token` and
    /// `routes::require_session`) instead of forcing a full re-login just
    /// because nobody happened to use the tab for a while.
    pub async fn sweep_idle(
        &self,
        idle_timeout: std::time::Duration,
    ) -> Vec<(String, Arc<Session>)> {
        let mut inner = self.inner.write().await;
        let mut evicted = Vec::new();
        inner.retain(|token, session| {
            if session.has_open_connection()
                || session.has_pending_verification_events()
                || session.has_unpersisted_encrypted_room()
                || session.idle_for() < idle_timeout
            {
                true
            } else {
                // Abort the sync loop right here — synchronously, still
                // under this write lock, in the same statement as the
                // `has_pending_verification_events` check above — rather
                // than leaving it to `main.rs`'s caller to abort later, one
                // session at a time, only after this whole sweep has
                // returned and (previously) after an awaited persistence
                // save per session. That gap mattered: a verification event
                // or a token refresh landing in it would be silently lost
                // (the event) or discarded (the refresh) once the loop
                // finally stopped. `abort()` itself is synchronous and
                // non-blocking (it only requests cancellation — the task
                // actually stops at its own next `.await` point, not
                // instantly), so this doesn't fully eliminate the window,
                // but shrinks it from "however long the rest of this sweep
                // plus every prior evicted session's save call takes" down
                // to "essentially zero, right next to the check above."
                if let Some(handle) = session
                    .sync_handle
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take()
                {
                    handle.abort();
                }
                // Captured *before* this session is dropped from the map —
                // see `evicted_presence`'s doc comment for why, and
                // `routes::require_session` for where this gets consumed.
                let presence = *session
                    .sync_presence
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                self.evicted_presence
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(token.clone(), (presence, std::time::Instant::now()));
                evicted.push((token.clone(), Arc::clone(session)));
                false
            }
        });
        // Prune `evicted_presence` entries nobody ever came back to claim —
        // see that field's doc comment for why this would otherwise leak,
        // and `prune_evicted_presence`'s own doc comment for why this uses
        // `EVICTED_PRESENCE_MAX_AGE` rather than `idle_timeout`. Piggybacks
        // on this same periodic call rather than a separate task, since
        // `main.rs` already invokes `sweep_idle` on a timer for exactly this
        // kind of periodic upkeep.
        self.prune_evicted_presence(EVICTED_PRESENCE_MAX_AGE);
        evicted
    }

    /// Drops every `evicted_presence` entry recorded more than `max_age`
    /// ago — split out from [`Self::sweep_idle`] (which always calls this
    /// with [`EVICTED_PRESENCE_MAX_AGE`]) purely so tests can exercise the
    /// pruning logic itself with a short `max_age` instead of waiting out
    /// the real multi-day constant.
    fn prune_evicted_presence(&self, max_age: std::time::Duration) {
        self.evicted_presence
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, (_, recorded_at)| recorded_at.elapsed() < max_age);
    }

    /// Removes and returns `token`'s presence choice at eviction time, if
    /// any was ever recorded — see `evicted_presence`'s doc comment. `None`
    /// covers "this token was never evicted", "already consumed by an
    /// earlier restore", and "pruned for having gone unclaimed too long",
    /// all three of which just mean the restore path falls back to the
    /// freshly built `Session`'s default (`Online`).
    pub fn take_evicted_presence(
        &self,
        token: &str,
    ) -> Option<charm_lib::matrix::presence::PresenceStateDto> {
        self.evicted_presence
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token)
            .map(|(presence, _)| presence)
    }

    /// Non-destructive counterpart to [`Self::take_evicted_presence`] — reads
    /// `token`'s recorded presence without removing it. `routes::require_session`
    /// uses this before attempting a restore rather than `take`: a restore
    /// can fail (timeout, unreachable homeserver, transient object-store
    /// error), and an earlier version of this took the entry unconditionally
    /// up front, so a failed restore attempt permanently lost the only
    /// record of the user's `unavailable`/`offline` choice — a *later*,
    /// successful retry with the same still-valid cookie would then fall
    /// back to the default `Online` even though the cached value had been
    /// sitting right there the whole time. Callers should still call
    /// [`Self::forget_evicted_presence`] once a restore actually succeeds,
    /// so a claimed entry doesn't linger until `EVICTED_PRESENCE_MAX_AGE`.
    pub fn peek_evicted_presence(
        &self,
        token: &str,
    ) -> Option<charm_lib::matrix::presence::PresenceStateDto> {
        self.evicted_presence
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .map(|(presence, _)| *presence)
    }

    /// Drops `token`'s recorded presence, if any, without returning it —
    /// called from `routes::logout` once the persisted session itself is
    /// being deleted, so an explicit logout doesn't leave a now-meaningless
    /// entry sitting around for `EVICTED_PRESENCE_MAX_AGE` for no reason.
    pub fn forget_evicted_presence(&self, token: &str) {
        self.evicted_presence
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_revocation_grace_exceeds_the_bare_cookie_max_age_by_the_touch_throttle() {
        assert_eq!(
            session_revocation_grace(),
            session_cookie_max_age()
                + std::time::Duration::from_secs(PERSISTENCE_TOUCH_THROTTLE_SECS)
        );
        assert!(session_revocation_grace() > session_cookie_max_age());
    }

    async fn dummy_session(user_id: &str) -> Session {
        let client = Client::builder()
            .homeserver_url("http://localhost:1")
            .build()
            .await
            .expect(
                "building a client against an unreachable homeserver shouldn't require network \
                 access",
            );
        Session::new(client, user_id.to_string(), None, false)
    }

    /// Backdates a session's `last_active` so tests don't need to actually
    /// sleep past the idle timeout to exercise eviction.
    fn backdate(session: &Session, ago: std::time::Duration) {
        let backdated = std::time::Instant::now() - ago;
        *session
            .last_active
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = backdated;
        // Also backdates `last_validated_active` — tests using this helper
        // want "no recent activity at all" in the general sense, and
        // `is_genuinely_active` specifically reads the validated field, not
        // `last_active`.
        *session
            .last_validated_active
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = backdated;
    }

    #[tokio::test]
    async fn sweep_idle_evicts_only_sessions_past_the_timeout_with_no_open_connection() {
        let store = SessionStore::new();
        let idle_timeout = std::time::Duration::from_secs(60);

        let idle_token = store.create(dummy_session("@idle:example.org").await).await;
        backdate(&store.get(&idle_token).await.unwrap(), idle_timeout * 2);

        let active_token = store
            .create(dummy_session("@active:example.org").await)
            .await;
        store.get(&active_token).await.unwrap().touch();

        let evicted = store.sweep_idle(idle_timeout).await;

        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].0, idle_token);
        assert!(
            store.get(&idle_token).await.is_none(),
            "the idle session must be gone from the store"
        );
        assert!(
            store.get(&active_token).await.is_some(),
            "a recently-touched session must survive the sweep"
        );
    }

    #[tokio::test]
    async fn an_open_websocket_connection_prevents_eviction_regardless_of_idle_time() {
        let store = SessionStore::new();
        let idle_timeout = std::time::Duration::from_secs(60);

        let token = store
            .create(dummy_session("@connected:example.org").await)
            .await;
        let session = store.get(&token).await.unwrap();
        backdate(&session, idle_timeout * 10);
        session
            .ws_connections
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        let evicted = store.sweep_idle(idle_timeout).await;

        assert!(
            evicted.is_empty(),
            "a session with a live WebSocket connection must never be evicted, no matter how \
             long ago its last HTTP request was"
        );
        assert!(store.get(&token).await.is_some());
    }

    #[tokio::test]
    async fn sweep_idle_is_a_no_op_when_nothing_is_idle_yet() {
        let store = SessionStore::new();
        let token = store
            .create(dummy_session("@fresh:example.org").await)
            .await;

        let evicted = store.sweep_idle(std::time::Duration::from_secs(60)).await;

        assert!(evicted.is_empty());
        assert!(store.get(&token).await.is_some());
    }

    /// Regression test: an idle session with an undelivered verification
    /// event must not be evicted, since nobody would ever be left to
    /// deliver it — see `Session::has_pending_verification_events`'s doc
    /// comment.
    #[tokio::test]
    async fn a_pending_verification_event_prevents_eviction_regardless_of_idle_time() {
        let store = SessionStore::new();
        let idle_timeout = std::time::Duration::from_secs(60);

        let token = store
            .create(dummy_session("@verifying:example.org").await)
            .await;
        let session = store.get(&token).await.unwrap();
        backdate(&session, idle_timeout * 10);
        session.pending_verification_events.lock().unwrap().push(
            crate::events::ServerEvent::VerificationRequest(
                charm_lib::matrix::verification::VerificationRequestSummary {
                    flow_id: "flow-1".to_string(),
                    other_user_id: "@other:example.org".to_string(),
                    other_device_id: "DEVICE".to_string(),
                },
            ),
        );

        let evicted = store.sweep_idle(idle_timeout).await;

        assert!(
            evicted.is_empty(),
            "a session with an undelivered verification event must never be evicted — there \
             would be nothing left to ever deliver it"
        );
        assert!(store.get(&token).await.is_some());
    }

    /// Regression test for the actual review finding: a session pinned in
    /// this map *only* by a pending verification event (never evicted by
    /// `sweep_idle`, no timeout at all) but with no open connection and no
    /// real activity in ages must not be reported as "genuinely active" —
    /// `persistence::PersistenceStore::sweep_expired` relies on this
    /// distinction to still revoke exactly this kind of stuck-forever
    /// session once it's past the retention window, instead of treating
    /// bare map presence as proof of activity forever.
    #[tokio::test]
    async fn is_genuinely_active_is_false_for_a_session_only_pinned_by_verification() {
        let store = SessionStore::new();
        let max_age = std::time::Duration::from_secs(30 * 24 * 60 * 60);

        let token = store
            .create(dummy_session("@stuck-verifying:example.org").await)
            .await;
        let session = store.get(&token).await.unwrap();
        backdate(&session, max_age * 2);
        session.pending_verification_events.lock().unwrap().push(
            crate::events::ServerEvent::VerificationRequest(
                charm_lib::matrix::verification::VerificationRequestSummary {
                    flow_id: "flow-1".to_string(),
                    other_user_id: "@other:example.org".to_string(),
                    other_device_id: "DEVICE".to_string(),
                },
            ),
        );

        assert!(
            !store.is_genuinely_active(&token, max_age).await,
            "a session with no open connection, idle well past max_age, must not count as \
             genuinely active just because a pending verification event keeps it in the map"
        );
    }

    #[tokio::test]
    async fn is_genuinely_active_is_true_for_an_open_connection_regardless_of_idle_time() {
        let store = SessionStore::new();
        let max_age = std::time::Duration::from_secs(30 * 24 * 60 * 60);

        let token = store
            .create(dummy_session("@connected:example.org").await)
            .await;
        let session = store.get(&token).await.unwrap();
        backdate(&session, max_age * 2);
        session
            .ws_connections
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        assert!(
            store.is_genuinely_active(&token, max_age).await,
            "an open connection must count as active regardless of idle time — revoking its \
             token would break the live connection out from under the browser"
        );
    }

    #[tokio::test]
    async fn is_genuinely_active_is_true_for_recent_activity() {
        let store = SessionStore::new();
        let max_age = std::time::Duration::from_secs(30 * 24 * 60 * 60);
        let token = store
            .create(dummy_session("@recently-active:example.org").await)
            .await;

        assert!(store.is_genuinely_active(&token, max_age).await);
    }

    /// Regression test for the actual review finding: `SessionStore::get`'s
    /// own `touch()` (bumping `last_active`, not `last_validated_active`)
    /// must never be enough on its own to make `is_genuinely_active` return
    /// `true` for a session that's otherwise stale — that's exactly the
    /// untrusted same-site request shape `routes::refresh_session_cookie`
    /// already refuses to slide the cookie for, and it still reaches
    /// `require_session`'s fast path regardless.
    #[tokio::test]
    async fn is_genuinely_active_ignores_a_plain_get_touch() {
        let store = SessionStore::new();
        let max_age = std::time::Duration::from_secs(30 * 24 * 60 * 60);
        let token = store
            .create(dummy_session("@get-only:example.org").await)
            .await;
        let session = store.get(&token).await.unwrap();
        backdate(&session, max_age * 2);

        // Simulates an untrusted request reaching `require_session`'s fast
        // path — `get` touches `last_active`, but never
        // `last_validated_active`.
        store.get(&token).await;

        assert!(
            !store.is_genuinely_active(&token, max_age).await,
            "a plain SessionStore::get touch must not count as genuine activity"
        );
    }

    #[tokio::test]
    async fn is_genuinely_active_is_false_for_an_unknown_token() {
        let store = SessionStore::new();
        assert!(
            !store
                .is_genuinely_active("no-such-token", std::time::Duration::from_secs(60))
                .await
        );
    }

    /// Regression test: `sweep_idle` must capture a session's presence
    /// choice at eviction time so a later on-demand restore can seed it back
    /// in, instead of silently reverting to `Online` — see
    /// `SessionStore::evicted_presence`'s doc comment.
    #[tokio::test]
    async fn sweep_idle_captures_presence_for_a_later_restore_to_consume() {
        let store = SessionStore::new();
        let idle_timeout = std::time::Duration::from_secs(60);

        let token = store.create(dummy_session("@away:example.org").await).await;
        let session = store.get(&token).await.unwrap();
        backdate(&session, idle_timeout * 2);
        *session.sync_presence.lock().unwrap() =
            charm_lib::matrix::presence::PresenceStateDto::Unavailable;

        let evicted = store.sweep_idle(idle_timeout).await;
        assert_eq!(evicted.len(), 1);

        assert_eq!(
            store.take_evicted_presence(&token),
            Some(charm_lib::matrix::presence::PresenceStateDto::Unavailable),
            "the presence choice recorded at eviction time must be retrievable exactly once"
        );
        assert_eq!(
            store.take_evicted_presence(&token),
            None,
            "a second take for the same token must find nothing left — it's consumed once"
        );
    }

    /// Regression test: an `evicted_presence` entry for a token nobody ever
    /// restored must eventually be pruned rather than living forever — see
    /// `evicted_presence`'s doc comment for why an unbounded version of this
    /// map would be its own memory leak.
    #[tokio::test]
    async fn evicted_presence_entries_are_pruned_once_max_age_elapses_unclaimed() {
        let store = SessionStore::new();
        let idle_timeout = std::time::Duration::from_millis(50);

        let token = store
            .create(dummy_session("@never-returns:example.org").await)
            .await;
        backdate(&store.get(&token).await.unwrap(), idle_timeout * 2);

        let evicted = store.sweep_idle(idle_timeout).await;
        assert_eq!(evicted.len(), 1);
        assert!(
            store.evicted_presence.lock().unwrap().contains_key(&token),
            "the presence entry must exist right after eviction"
        );

        tokio::time::sleep(idle_timeout * 3).await;
        // Exercises the pruning pass directly with a short `max_age` — the
        // real `EVICTED_PRESENCE_MAX_AGE` this backs onto in `sweep_idle` is
        // multiple days, deliberately independent of `idle_timeout` (see
        // `sweep_idle`'s doc comment), so this test can't wait it out for
        // real.
        store.prune_evicted_presence(idle_timeout);

        assert!(
            store.take_evicted_presence(&token).is_none(),
            "an entry nobody ever came back to claim must be pruned, not kept forever"
        );
    }

    /// Regression test: `sweep_idle` must *not* prune `evicted_presence`
    /// entries against its own short `idle_timeout` parameter — only
    /// `prune_evicted_presence`'s separate, much longer `max_age` should
    /// ever remove one. An earlier version of this tied pruning directly to
    /// `idle_timeout`, which threw away a user's explicit presence choice
    /// almost immediately after eviction even though the persisted session
    /// itself stays restorable far longer.
    #[tokio::test]
    async fn sweep_idle_does_not_prune_evicted_presence_against_its_own_idle_timeout() {
        let store = SessionStore::new();
        let idle_timeout = std::time::Duration::from_millis(50);

        let token = store
            .create(dummy_session("@away-a-while:example.org").await)
            .await;
        backdate(&store.get(&token).await.unwrap(), idle_timeout * 2);
        store.sweep_idle(idle_timeout).await;
        assert!(store.evicted_presence.lock().unwrap().contains_key(&token));

        tokio::time::sleep(idle_timeout * 5).await;
        // Several `idle_timeout`s have now passed — if pruning were still
        // tied to `idle_timeout`, this call would drop the entry. It must
        // not: only `EVICTED_PRESENCE_MAX_AGE` (multiple days) governs that.
        store.sweep_idle(idle_timeout).await;

        assert!(
            store.evicted_presence.lock().unwrap().contains_key(&token),
            "evicted_presence must survive many multiples of idle_timeout — only the \
             separate, much longer EVICTED_PRESENCE_MAX_AGE should ever prune it"
        );
    }
}
