pub mod account;
pub mod account_data;
pub mod actions;
pub mod auth;
pub mod bookmarks;
pub mod commands;
pub mod devices;
pub mod dnd;
pub mod ephemeral;
pub mod link_preview;
pub mod media;
pub mod members;
pub mod notifications;
pub mod persistence;
pub mod presence;
pub mod profiles;
pub mod qr_login;
pub mod room_admin;
pub mod rooms;
pub mod secret_store;
pub mod send;
pub mod shell;
pub mod spaces;
pub mod sync;
pub mod timeline;
pub mod verification;

use matrix_sdk::Client;
use tauri::AppHandle;
use tokio::sync::Mutex;

/// How many rooms' live `matrix-sdk-ui` `Timeline`s are held open at once
/// (see `MatrixState::get_or_create_timeline`) — bounds memory so visiting
/// many rooms in one session doesn't grow the set of subscribed timelines
/// (and their background listener tasks) without limit. LRU-evicted; the
/// evicted `Arc<Timeline>`'s `Drop` tears down its background tasks once
/// every clone (including any in-flight command still holding one) is gone.
const MAX_LIVE_TIMELINES: usize = 20;

/// How many recently-notified event ids `MatrixState::notified_event_ids`
/// remembers — comfortably more than could plausibly be in flight across the
/// opened-room/unopened-room notification race window at once.
const MAX_NOTIFIED_EVENT_IDS: usize = 200;

/// A per-room `Timeline` paired with its listener task's `JoinHandle` — see
/// `MatrixState::timelines`'s doc comment for why the handle is kept
/// alongside the `Arc` — plus whether this entry is a `TimelineFocus::Event`
/// view (`replace_timeline`) rather than the room's ordinary live tail
/// (`get_or_create_timeline`).
///
/// Review fix: `is_timeline_open` used to treat *any* cached entry as "this
/// room is being handled elsewhere, skip the unopened-room notification
/// path" — but a `TimelineFocus::Event`-focused `Timeline` (left behind by a
/// Saved Messages jump-to-message) doesn't receive new live sync events the
/// way a `TimelineFocus::Live` one does, so its listener never fires
/// `maybe_notify_new_message` for messages that arrive after the jump. That
/// silently dropped notifications for the room until something evicted the
/// focused entry. `is_focused` lets `is_timeline_open` (and
/// `get_or_create_timeline`, which now also self-heals a focused entry back
/// to live the next time the room is genuinely queried) tell the two cases
/// apart.
type TimelineEntry = (
    std::sync::Arc<matrix_sdk_ui::Timeline>,
    tokio::task::JoinHandle<()>,
    bool,
);

/// Holds the active matrix-rust-sdk client for the running session.
/// One `MatrixState` per app instance; per-account multiplexing (multiple
/// *concurrently active* clients) is a Day-2 concern. Storage itself,
/// however, is already isolated per account on disk/keychain — see
/// `persistence::account_key`.
pub struct MatrixState {
    pub(crate) client: Mutex<Option<Client>>,
    /// Serializes an interactive login's *entire* completion sequence —
    /// stopping the previous sync loop/client, relocating the account's
    /// store, saving the session, and adopting the new client — across
    /// `login`/`register`/`complete_sso_login`/QR login's completion. Without
    /// this, two overlapping completions for the same account (e.g. a
    /// double-submitted login racing an in-flight QR login) could interleave
    /// arbitrarily: one could finish adopting its client while the other was
    /// mid-abort of the *first* one's now-stale sync loop, and that first
    /// completion's abort step would then unconditionally clear
    /// `MatrixState::client` — wiping out the second completion's
    /// just-installed winning client. Holding this for the whole sequence
    /// (not just the store-swap `persistence::RELOCATE_LOCK` already
    /// guards) makes the sequence atomic instead: a second completion simply
    /// waits for the first to fully finish before starting its own abort
    /// step, so there's no window where "which client is currently active"
    /// is ambiguous. A `tokio::sync::Mutex`, not `std::sync::Mutex`, because
    /// this needs to be held across `.await` points.
    pub(crate) login_completion_lock: Mutex<()>,
    /// Set by `auth::start_sso_login`, consumed by `auth::complete_sso_login`.
    /// Built once and carried across the two calls (rather than rebuilt in
    /// `complete_sso_login`) so it keeps whatever `.well-known` discovery
    /// result and homeserver connection `start_sso_login` already resolved.
    pub(crate) pending_sso: Mutex<Option<auth::PendingSso>>,
    /// Set while a QR login is in the `QrScanned` stage (waiting for the
    /// user to type in the check code shown on the other device) — see
    /// `qr_login::submit_qr_check_code`.
    pub(crate) pending_qr_check_code:
        Mutex<Option<matrix_sdk::authentication::oauth::qrcode::CheckCodeSender>>,
    /// The task driving the current QR login attempt (spawned by
    /// `qr_login::start_qr_login`). Unlike SSO login, which just waits on a
    /// deep-link callback with nothing running in the background, QR login
    /// actively drives `login_with_qr_code` to completion in a spawned task —
    /// so cancelling it requires aborting this handle, not just clearing
    /// state. A plain `std::sync::Mutex`, not `tokio::sync::Mutex`: storing
    /// the handle right after `tokio::spawn` returns must be synchronous
    /// (no `.await` in between), or a `cancel_qr_login` racing in that gap
    /// could find nothing to abort yet.
    pub(crate) pending_qr_login_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The temp store key the in-flight QR login (if any) opened its client
    /// against — see `PendingSso::store_key`'s doc comment; same rationale,
    /// same `std::sync::Mutex` synchronous-with-spawn requirement.
    pub(crate) pending_qr_temp_store_key: std::sync::Mutex<Option<String>>,
    /// Temp-store keys for an SSO login whose callback has arrived and is
    /// actively completing (`auth::complete_sso_login`), from the moment it
    /// takes the entry out of `pending_sso` through relocation finishing —
    /// unlike QR login, whose `pending_qr_temp_store_key` naturally stays
    /// set until relocation completes, `complete_sso_login` clears
    /// `pending_sso` immediately (needed so a *different* SSO callback can't
    /// still match the same entry mid-completion), which leaves a window
    /// where `lib.rs`'s delayed sweep pass would no longer see this store
    /// as pending anything (Codex review on #288, P2). Consulted alongside
    /// `pending_sso`/`pending_qr_temp_store_key` when that pass gathers its
    /// protected set.
    pub(crate) completing_sso_temp_store_keys: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Temp-store keys reserved by `start_sso_login`/`start_qr_login`
    /// immediately after generating them, before any `.await` — closes a
    /// window at the *other* end of the flow from
    /// `completing_sso_temp_store_keys`: both flows `.await` a client
    /// build (network discovery) and, for SSO, a second network call for
    /// the login URL, before ever publishing to `pending_sso`/
    /// `pending_qr_temp_store_key` — so a `tmp-*` directory can exist on
    /// disk, unprotected by either of those, for however long that setup
    /// takes (Codex review on #288, P2). Cleared once ownership transfers
    /// to `pending_sso`/`pending_qr_temp_store_key` (which then protect it
    /// themselves the rest of the way) or on early failure — see each
    /// call site's `ReservedTempStoreGuard`.
    pub(crate) reserved_temp_store_keys: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Filesystem media cache (`<app_data>/media/`), built once at app
    /// startup and shared across every login/restore — see
    /// `media::MediaCache`. `OnceCell` rather than living inside the client
    /// swap above: the cache directory doesn't depend on which account is
    /// logged in, and outlives any single `Client`.
    pub(crate) media_cache: tokio::sync::OnceCell<media::MediaCache>,
    /// The presence state the *next* `/sync` request should report, kept in
    /// sync with the last successful `set_presence` call. `sync::spawn_sync_loop`
    /// reads this fresh on every iteration (rather than baking a single
    /// `SyncSettings::default()` — which always reports `Online` — into one
    /// long-lived `sync_with_callback` call) so an explicit `unavailable`/
    /// `offline` choice actually sticks across syncs instead of being
    /// silently reverted to online by the next long-poll.
    pub(crate) sync_presence: std::sync::Mutex<presence::PresenceStateDto>,
    /// Live per-room `matrix-sdk-ui` `Timeline`s, built lazily the first time
    /// a room is opened (`get_timeline_page`) and bounded to
    /// [`MAX_LIVE_TIMELINES`] — see `get_or_create_timeline`. Each entry also
    /// carries its listener task's `JoinHandle` (see
    /// `timeline::spawn_timeline_listener`) so [`clear_timelines`] can abort
    /// and *await* every listener — not just drop the cache's own `Arc`
    /// references — genuinely guaranteeing no listener is still holding its
    /// own `Client` clone (and the store's open file handles under it) by
    /// the time it returns, the same rigor `sync::abort_current_sync_loop`
    /// applies to the main sync loop.
    timelines: Mutex<lru::LruCache<matrix_sdk::ruma::OwnedRoomId, TimelineEntry>>,
    /// Rooms currently mid-swap in `replace_timeline`/`get_or_create_timeline`'s
    /// `force_live` path — between the previous listener being aborted and
    /// (genuinely, by `.await`) confirmed stopped, and the new one being
    /// pushed into `timelines`. Review fix: without this, closing that
    /// window by *awaiting* the old listener's full shutdown before spawning
    /// the new one would require briefly `pop`-ing the entry out of
    /// `timelines` to get ownership of its `JoinHandle` (a plain `&self`
    /// `.abort()` call doesn't need ownership, but consuming `.await` does)
    /// — during which `is_timeline_open` would incorrectly report the room
    /// as closed (the same bug an earlier round of this fix already closed
    /// for the non-awaited case). This set lets `is_timeline_open` also
    /// check "is this room mid-transition" so it stays correct even while
    /// `timelines` itself briefly has no entry for it.
    transitioning_timelines: Mutex<std::collections::HashSet<matrix_sdk::ruma::OwnedRoomId>>,
    /// Per-room "most recently requested" Saved Messages jump target event
    /// id — set by `timeline::load_timeline_around_event` before it starts
    /// working, and checked by `timeline::load_focused_event_timeline`
    /// immediately before it calls `replace_timeline`. Review fix: without
    /// this, starting a second jump (event B) in a room while an earlier
    /// jump (event A) is still awaiting its own server `/context` lookup
    /// has no way to know it's been superseded — if A's slower request
    /// finishes *after* B's, A would call `replace_timeline` last and
    /// silently swap the room back to A's focused context, even though the
    /// user is looking at (and the frontend's own `jumpToEventId` reflects)
    /// B by then. Only the request whose target still matches this map
    /// entry is allowed to install its focused timeline; a superseded one
    /// reports "not found" instead, matching how the frontend already
    /// treats it (see `ChatShell`'s jump effect ignoring a stale request's
    /// resolution once a newer one has started).
    latest_jump_target: Mutex<
        std::collections::HashMap<matrix_sdk::ruma::OwnedRoomId, matrix_sdk::ruma::OwnedEventId>,
    >,
    /// The task driving the current background sync loop (see
    /// `sync::spawn_sync_loop`). Login/session-restore has several independent
    /// success paths (password, SSO, QR, restored-session) and none of them
    /// checks whether a client — and therefore a sync loop — is already
    /// active before starting a new one; without tracking this handle, a
    /// double-invocation (e.g. a double-submitted login button, or restoring
    /// twice) would leak the earlier loop's task forever, since nothing ever
    /// aborts it and it polls `/sync` indefinitely. `spawn_sync_loop` aborts
    /// whatever's here before storing its own new handle.
    pub(crate) sync_loop_handle: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The detached one-shot task `spawn_sync_loop` fires to report presence
    /// as online (see its own doc comment for why that's separate from
    /// `sync_loop_handle`'s long-running loop). Tracked for the same reason
    /// as `sync_loop_handle`: it holds its own `Client` clone, so
    /// `sync::abort_current_sync_loop` needs to abort and await this too —
    /// otherwise a slow presence request could still be holding the old
    /// store's SQLite files open when a login supersedes it, same hazard,
    /// different task.
    pub(crate) presence_task_handle: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The room currently open/focused in the frontend, set by
    /// `shell::set_focused_room` — read by each room's timeline listener to
    /// suppress local notifications for whatever room the user is already
    /// looking at (Spec 10). `None` when no room has focus (e.g. the room
    /// list, settings, or another window has it).
    pub(crate) focused_room_id: std::sync::Mutex<Option<String>>,
    /// Event ids a local notification has already been fired for, shared
    /// between the opened-room timeline listener and the sync loop's
    /// unopened-room path (`shell::maybe_send_notification` checks this
    /// before either fires one). Needed because a room can transition
    /// between the two paths mid-flight: `spawn_timeline_listener`'s
    /// liveness check only notices its `Timeline` was evicted from the LRU
    /// up to [`shell::TIMELINE_LIVENESS_CHECK_INTERVAL`] late, during which
    /// window both paths could otherwise independently notify for the same
    /// new message (`spawn_timeline_listener`'s own liveness check only polls
    /// every 30s). Bounded the same way `timelines` is — an unbounded set
    /// would grow for the life of the process.
    pub(crate) notified_event_ids: std::sync::Mutex<lru::LruCache<String, ()>>,
    /// The transport (if any) `push::register_push` last successfully
    /// registered — held so `push::unregister_push` can tell it to drop its
    /// endpoint/token without re-deriving which platform impl is active.
    pub(crate) push_transport:
        std::sync::Mutex<Option<std::sync::Arc<dyn crate::push::NotificationTransport>>>,
    /// Last-known push registration state, mirrored to every `push:status`
    /// emit — lets `push::get_push_status` answer synchronously on settings
    /// panel mount without waiting for the next event.
    pub(crate) push_status: std::sync::Mutex<crate::push::PushStatus>,
    /// Do Not Disturb state (Spec 30) — loaded from `focus.json` at startup
    /// by `dnd::init` and mutated by both the Settings panel (`dnd::set_dnd_state`
    /// command) and the tray menu's DND submenu, so both surfaces read the
    /// same single source of truth. See `dnd`'s module doc comment for why
    /// Rust (not the frontend) owns persistence here, unlike appearance.
    pub(crate) dnd: std::sync::Mutex<dnd::DndRuntimeState>,
    /// Room ids currently registered with `matrix-sdk`'s `LatestEvents`
    /// tracker for Spec 54's message-preview slice
    /// (`rooms::last_message_preview`). Tracked so `rooms::snapshot_rooms`
    /// can `forget_room` a registration once the `room_list_message_preview`
    /// flag is turned off or a room is no longer joined — `LatestEvents`
    /// keeps listening for a room until explicitly forgotten, so without
    /// this the background work (and the flag's kill-switch) would outlive
    /// both of those conditions.
    pub(crate) preview_registered_rooms:
        std::sync::Mutex<std::collections::HashSet<matrix_sdk::ruma::OwnedRoomId>>,
    /// Per-room locks serializing `room_admin::pin_event`/`unpin_event`.
    ///
    /// Review fix: matrix-sdk's own `Room::pin_event`/`unpin_event` each do a
    /// read-current-list-then-send-full-replacement-state-event
    /// read-modify-write, with no locking of their own (confirmed by reading
    /// their implementation) — two pin/unpin commands for the same room
    /// firing close together (e.g. pinning two messages in quick succession)
    /// can each read the same pre-mutation list and send a full
    /// `m.room.pinned_events` state event built from it, so whichever send
    /// lands second on the server silently drops the first one's change.
    /// Serializing here, per room (so unrelated rooms never block each
    /// other), closes that window: the second call's own read now happens
    /// only after the first call's state event has actually been sent, so it
    /// starts from a list that already includes the first change.
    pub(crate) pinned_event_locks:
        Mutex<std::collections::HashMap<matrix_sdk::ruma::OwnedRoomId, std::sync::Arc<Mutex<()>>>>,
    /// This module's own authoritative last-known-pinned list per room,
    /// used (and kept current) by `room_admin::pin_event`/`unpin_event`.
    ///
    /// Review fix: `pinned_event_locks` alone serializes *calls*, but
    /// matrix-sdk's `Room::pin_event`/`unpin_event` still build their
    /// replacement list from `Room::pinned_event_ids()` — local, synced
    /// room state that our own state-event send doesn't retroactively
    /// update; it only lands once a later `/sync` response processes it.
    /// So even with calls fully serialized, a second call arriving before
    /// that sync round-trip completes would still read the same
    /// pre-first-write list matrix-sdk has cached, silently dropping the
    /// first call's change. This cache is seeded from that same local
    /// state on first use per room, then updated immediately after every
    /// successful write — always read/written while holding this room's
    /// `pinned_event_locks` guard, so no separate locking discipline is
    /// needed between the two maps.
    pub(crate) pinned_event_cache: Mutex<
        std::collections::HashMap<
            matrix_sdk::ruma::OwnedRoomId,
            Vec<matrix_sdk::ruma::OwnedEventId>,
        >,
    >,
    /// Bumped by `clear_pinned_event_cache` (logout/re-login/account
    /// switch). `pin_event`/`unpin_event` capture this before their
    /// homeserver send and skip their own cache write if it's since
    /// changed — a send that outlives a client swap (the old client clone
    /// it's holding can still complete the request against the *old*
    /// session after the new one is already active) must not resurrect a
    /// stale entry into the new session's freshly-cleared cache. A plain
    /// `std::sync::atomic::AtomicU64` (not the `tokio::sync::Mutex` the
    /// two maps above use): read/incremented without ever needing to hold
    /// across an `.await`.
    pub(crate) pinned_event_cache_generation: std::sync::atomic::AtomicU64,
}

impl Default for MatrixState {
    fn default() -> Self {
        Self {
            client: Mutex::default(),
            login_completion_lock: Mutex::default(),
            pending_sso: Mutex::default(),
            pending_qr_check_code: Mutex::default(),
            pending_qr_login_task: std::sync::Mutex::default(),
            pending_qr_temp_store_key: std::sync::Mutex::default(),
            completing_sso_temp_store_keys: std::sync::Mutex::default(),
            reserved_temp_store_keys: std::sync::Mutex::default(),
            media_cache: tokio::sync::OnceCell::default(),
            sync_presence: std::sync::Mutex::default(),
            timelines: Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(MAX_LIVE_TIMELINES)
                    .expect("MAX_LIVE_TIMELINES is a nonzero constant"),
            )),
            transitioning_timelines: Mutex::default(),
            latest_jump_target: Mutex::default(),
            sync_loop_handle: std::sync::Mutex::default(),
            presence_task_handle: std::sync::Mutex::default(),
            focused_room_id: std::sync::Mutex::default(),
            notified_event_ids: std::sync::Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(MAX_NOTIFIED_EVENT_IDS)
                    .expect("MAX_NOTIFIED_EVENT_IDS is a nonzero constant"),
            )),
            push_transport: std::sync::Mutex::default(),
            push_status: std::sync::Mutex::new(crate::push::PushStatus::default()),
            dnd: std::sync::Mutex::default(),
            preview_registered_rooms: std::sync::Mutex::default(),
            pinned_event_locks: Mutex::default(),
            pinned_event_cache: Mutex::default(),
            pinned_event_cache_generation: std::sync::atomic::AtomicU64::default(),
        }
    }
}

/// RAII handle for an entry in [`MatrixState::reserved_temp_store_keys`].
/// Removes the key on drop unless [`Self::defuse`] was called first — the
/// pattern is: reserve immediately (before any `.await`), do the
/// network-dependent setup, then `defuse()` right before handing ownership
/// off to `pending_sso`/`pending_qr_temp_store_key` (which protect the key
/// themselves from that point on). An early return via `?` from anywhere in
/// between drops the guard un-defused, cleaning the reservation up
/// automatically so a failed attempt doesn't leak protection for a store
/// that no longer has anything actually pending.
pub(crate) struct ReservedTempStoreGuard<'a> {
    matrix_state: &'a MatrixState,
    store_key: String,
    defused: bool,
}

impl<'a> ReservedTempStoreGuard<'a> {
    pub(crate) fn new(matrix_state: &'a MatrixState, store_key: String) -> Self {
        matrix_state
            .reserved_temp_store_keys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(store_key.clone());
        Self {
            matrix_state,
            store_key,
            defused: false,
        }
    }

    pub(crate) fn defuse(mut self) {
        self.defused = true;
        // Removed here, not left for `Drop` to skip: `defuse` means
        // ownership has transferred to `pending_sso`/
        // `pending_qr_temp_store_key`, which protect the key themselves
        // from now on — leaving it behind in `reserved_temp_store_keys`
        // too would never get cleaned up (Sentry review on #288, MEDIUM: an
        // earlier version of this method only set the flag and relied on
        // `Drop` to skip removal, which meant every successful login leaked
        // an entry into this set for the rest of the process's life).
        self.matrix_state
            .reserved_temp_store_keys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.store_key);
    }
}

impl Drop for ReservedTempStoreGuard<'_> {
    fn drop(&mut self) {
        if !self.defused {
            self.matrix_state
                .reserved_temp_store_keys
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.store_key);
        }
    }
}

impl MatrixState {
    pub(crate) async fn require_client(&self) -> Result<Client, String> {
        self.client
            .lock()
            .await
            .clone()
            .ok_or_else(|| "not logged in".to_string())
    }

    /// Whether `room_id` already has a live `Timeline` cached — a cheap peek
    /// (`LruCache::contains`, which doesn't touch recency order) for callers
    /// that want to tell a cold open (this returns `false`, then
    /// `get_or_create_timeline` does the real work: `Room::timeline()` plus
    /// spawning the listener) apart from a request against an already-open
    /// room (this returns `true`, `get_or_create_timeline` is just a cache
    /// hit) — e.g. `timeline::get_timeline_page` uses this to pick a
    /// distinct Sentry transaction name so cold-open latency and
    /// steady-state pagination latency don't get averaged together under
    /// one metric (Codex review on #289).
    ///
    /// Racing this against a concurrent `get_or_create_timeline` for the
    /// same room can misclassify (a `false` here immediately followed by
    /// another caller creating the entry first) — acceptable for a
    /// best-effort trace label, not something any caller should treat as a
    /// correctness guarantee.
    pub(crate) async fn has_cached_timeline(&self, room_id: &matrix_sdk::ruma::RoomId) -> bool {
        self.timelines.lock().await.contains(room_id)
    }

    /// Returns `room_id`'s live `Timeline` if one is already cached, without
    /// creating one — unlike `get_or_create_timeline`, a miss here is not
    /// followed by `Room::timeline()`/spawning a listener. Used by
    /// `bookmarks::list_bookmarks` to resolve a bookmark's sender/preview
    /// from the already-decrypted in-memory timeline when the room happens
    /// to be open, without paying the cost (or side effect) of opening a
    /// room the caller never asked to open just to read one bookmark's
    /// preview.
    pub(crate) async fn peek_timeline(
        &self,
        room_id: &matrix_sdk::ruma::RoomId,
    ) -> Option<std::sync::Arc<matrix_sdk_ui::Timeline>> {
        self.timelines
            .lock()
            .await
            .peek(room_id)
            .map(|(timeline, _, _)| std::sync::Arc::clone(timeline))
    }

    /// Returns the live `Timeline` for `room_id`, building (and spawning its
    /// `timeline:update`-emitting listener task) on first use if it isn't
    /// already held. Bounded LRU: opening more than [`MAX_LIVE_TIMELINES`]
    /// distinct rooms in a session evicts the least-recently-opened one
    /// rather than growing unbounded.
    ///
    /// `force_live`: if the cached entry for this room is a focused
    /// (`TimelineFocus::Event`) view left over from a Saved Messages jump,
    /// discard it and rebuild a fresh live one instead of returning it as-is.
    /// Review fix history: an earlier version of this self-heal always ran
    /// (round 6), but `get_or_create_timeline` is also what `get_timeline_page`
    /// calls on *every* pagination request, not just a genuine room (re)open
    /// — always forcing broke paging further back while still viewing a
    /// bookmark's focused context (round 7 reverted that). `force_live` lets
    /// the one caller that actually represents "the user is opening this
    /// room" (`get_timeline_page`'s room-open path, keyed off `room?.room_id`
    /// in `useChatTimeline`'s effect — not its separate pagination-loop call
    /// site) opt back into resetting a stale focused view to live, without
    /// affecting pagination within an still-active focused view.
    pub(crate) async fn get_or_create_timeline(
        &self,
        app: &AppHandle,
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
        force_live: bool,
    ) -> Result<std::sync::Arc<matrix_sdk_ui::Timeline>, String> {
        use matrix_sdk_ui::timeline::RoomExt as _;

        // Review fix: a focused entry being force-reset to live used to have
        // its listener merely `.abort()`-ed in place (via `get_mut`, keeping
        // the entry cached) and only *awaited* once displaced by the later
        // `push` below — leaving a residual window where the old listener
        // could still be mid-unwind (not yet fully stopped) while the new
        // one was already spawned and running, both able to emit their own
        // `timeline:update` for this room. Fully awaiting the old listener's
        // shutdown *before* spawning the new one closes that window
        // entirely, at the cost of needing real ownership of its
        // `JoinHandle` (`.await` consumes it, unlike `&self`-taking
        // `.abort()`) — which means genuinely `pop`-ing it out of
        // `timelines`. `transitioning_timelines` is what keeps
        // `is_timeline_open` correct while this room briefly has no entry
        // cached during that pop-to-repush span.
        //
        // Review fix (deadlock): this used to check-and-pop `timelines`
        // and insert into `transitioning_timelines` under one nested
        // critical section (holding `timelines` for the whole block, so
        // `transitioning_timelines` was acquired *while already holding*
        // `timelines`) — the opposite nesting order from `replace_timeline`,
        // which locks `transitioning_timelines` and lets that guard drop
        // before separately locking `timelines`. Two tasks hitting these
        // paths for the same room at the same time could each be holding
        // one lock while waiting on the other. Never holding both locks at
        // once — checking `timelines` first and dropping that guard before
        // touching `transitioning_timelines` at all — removes the nesting
        // entirely, so there's no ordering to invert.
        // Review fix (Sentry, efficiency-only): if another concurrent call
        // (a `replace_timeline` for this same room, e.g. an in-flight
        // Saved Messages jump for a *different* target still resolving)
        // has already marked this room as transitioning, skip this call's
        // own reset-to-live entirely rather than racing it — checking
        // `is_focused` and then popping moments later could otherwise pop
        // and tear down a *freshly-installed* focused timeline that other
        // call just pushed, forcing redundant listener spawn/abort work
        // (the final live timeline this function builds further below ends
        // up correct either way, since that doesn't depend on what was
        // popped here — this is purely about not doing pointless work).
        //
        // Review fix (Codex): a separate `contains()` pre-check followed by
        // an unconditional `insert()` (with its return value discarded)
        // wasn't atomic — another call could win the race and insert
        // between this call's `contains()` and its own `insert()`, leaving
        // `inserted_transition_marker` set to `true` here even though this
        // call didn't actually claim the marker. That caused this call to
        // later *remove* the other call's marker while its own pop-to-
        // repush was still in flight, reopening the `is_timeline_open`
        // false-negative window the marker exists to close. `HashSet::insert`
        // is atomic under the lock and its own return value (`true` only
        // when this call is the one that actually inserted a new entry) is
        // now the sole ownership signal — no separate pre-check needed.
        let mut inserted_transition_marker = false;
        if force_live {
            let is_focused = {
                let timelines = self.timelines.lock().await;
                matches!(timelines.peek(room_id), Some((_, _, true)))
            };
            if is_focused {
                let claimed = self
                    .transitioning_timelines
                    .lock()
                    .await
                    .insert(room_id.to_owned());
                if claimed {
                    inserted_transition_marker = true;
                    let previous = self.timelines.lock().await.pop(room_id);
                    if let Some((_, previous_handle, _)) = previous {
                        previous_handle.abort();
                        let _ = previous_handle.await;
                    }
                }
                // Else: another concurrent transition already owns this
                // room's reset-to-live — skip this call's own pop/abort
                // entirely rather than racing it (see the efficiency note
                // above; the final live timeline built below is correct
                // either way).
            }
        }

        // Review fix (Codex P2): every error return from here on must clear
        // `transitioning_timelines` if this call set it above — otherwise a
        // `client.get_room`/`room.timeline()` failure below would leave the
        // marker set forever, permanently reporting this room as open to
        // `is_timeline_open` even though no listener is cached for it
        // anymore. `Result`/`?` can't run async cleanup on unwind (no async
        // `Drop`), so the two error paths below clear it explicitly before
        // returning.
        //
        // Review fix (Codex P3): every removal below is now gated on
        // `inserted_transition_marker` — this specific call's own flag for
        // whether *it* inserted the marker. Unconditionally removing it
        // (the previous behavior) could delete a marker a *different*,
        // concurrent `get_or_create_timeline`/`replace_timeline` call for
        // this same room id had inserted for its own still-in-progress
        // focused-to-live swap — reopening the same `is_timeline_open`
        // false-negative window this marker exists to close, for that other
        // call's in-flight room-open notification handling.
        {
            let mut timelines = self.timelines.lock().await;
            if let Some((existing, _, existing_is_focused)) = timelines.get(room_id) {
                // Review fix: when this call lost the transition-marker
                // claim above (`claimed == false`), it never popped the old
                // entry itself and has no way to know whether the winning
                // call has popped it yet. Returning a still-focused entry
                // here would hand back the bookmarked view even though the
                // caller explicitly asked for `force_live` — fall through
                // and build a fresh live `Timeline` instead in that case,
                // same as if the pop had already happened.
                if !(force_live && *existing_is_focused) {
                    let existing = std::sync::Arc::clone(existing);
                    drop(timelines);
                    if inserted_transition_marker {
                        self.transitioning_timelines.lock().await.remove(room_id);
                    }
                    return Ok(existing);
                }
            }
        }

        let room = match client.get_room(room_id) {
            Some(room) => room,
            None => {
                if inserted_transition_marker {
                    self.transitioning_timelines.lock().await.remove(room_id);
                }
                return Err(format!("room {room_id} not found"));
            }
        };
        let timeline = match room.timeline().await {
            Ok(timeline) => std::sync::Arc::new(timeline),
            Err(e) => {
                if inserted_transition_marker {
                    self.transitioning_timelines.lock().await.remove(room_id);
                }
                return Err(e.to_string());
            }
        };

        let mut timelines = self.timelines.lock().await;
        // Re-check: another concurrent call may have built and inserted one
        // for this same room while this call was awaiting `room.timeline()`
        // above (lock isn't held across that await) — keep whichever was
        // inserted first rather than running two listener tasks for one room.
        //
        // Review fix: same `force_live` guard as the earlier check above —
        // this second await window gives the same narrow race another
        // chance to surface a still-focused entry the winning call hasn't
        // popped yet.
        if let Some((existing, _, existing_is_focused)) = timelines.get(room_id) {
            if !(force_live && *existing_is_focused) {
                let existing = std::sync::Arc::clone(existing);
                drop(timelines);
                if inserted_transition_marker {
                    self.transitioning_timelines.lock().await.remove(room_id);
                }
                return Ok(existing);
            }
        }

        let handle = timeline::spawn_timeline_listener(
            app.clone(),
            room_id.to_owned(),
            std::sync::Arc::downgrade(&timeline),
            client.clone(),
            client.user_id().map(ToOwned::to_owned),
        );
        // `push` returns the LRU-evicted entry (if any capacity eviction
        // happened) rather than just dropping it — a dropped `JoinHandle`
        // detaches its task instead of stopping it, which would leave that
        // room's listener (and its own `Client` clone) running for up to
        // `LIVENESS_CHECK_INTERVAL` after eviction, the same open-handle
        // hazard `clear_timelines` exists to avoid on logout/relocation.
        let evicted = timelines.push(
            room_id.to_owned(),
            (std::sync::Arc::clone(&timeline), handle, false),
        );
        // Dropped before awaiting the evicted handle below: holding the
        // cache's own lock while awaiting an unrelated task's abort would
        // block every other `get_or_create_timeline`/`is_timeline_open`
        // caller for however long that task takes to unwind, for no reason.
        drop(timelines);
        if inserted_transition_marker {
            self.transitioning_timelines.lock().await.remove(room_id);
        }
        if let Some((_, (_, evicted_handle, _))) = evicted {
            evicted_handle.abort();
            // Genuinely wait for it to stop (see `abort_current_sync_loop`'s
            // identical rationale) — otherwise a caller relying on eviction
            // meaning "quiesced" (e.g. a login about to relocate the store)
            // gets a false guarantee: the task can still be mid-unwind,
            // holding its own `Client` clone, when this returns.
            let _ = evicted_handle.await;
        }

        Ok(timeline)
    }

    /// Swaps this room's cached `Timeline` for `timeline`, spawning a fresh
    /// listener task for it and stopping the previous entry's listener the
    /// same way an LRU eviction does in `get_or_create_timeline`. Used by
    /// `load_timeline_around_event`'s event-focused fallback: once that
    /// builds a `TimelineFocus::Event`-focused `Timeline` (resolved via the
    /// server's `/context` endpoint rather than bounded client-side
    /// backward-pagination), later callers for this room — `get_timeline_page`
    /// included — should see events around that focus, not the room's
    /// unrelated live tail from before the jump.
    ///
    /// Review fix: the previous version spawned the *new* listener before
    /// taking the lock and stopping the *previous* one — leaving a window
    /// where both were alive at once, each emitting its own `timeline:update`
    /// (the old listener still surfacing the room's unrelated live tail, the
    /// new one the event-focused view), which could show up as a flicker on
    /// the frontend since neither is a duplicate the dedup logic there would
    /// catch. Now the previous listener is located, aborted, and awaited
    /// *before* the new one is spawned, so there's no overlap.
    ///
    /// Returns `None` without installing anything if, by the time the
    /// previous listener has fully stopped, the active client is no longer
    /// the same one `client` was captured from (see the review fix below) —
    /// callers should treat that the same as "this jump/replacement no
    /// longer applies", not as success. Also returns `None` if
    /// `expected_event_id` is given and no longer matches this room's
    /// `latest_jump_target` by that same point — a newer jump for this room
    /// superseded this one while the previous listener was still unwinding.
    /// Pass `None` for callers that aren't part of the jump-to-event flow
    /// (none currently are, but this keeps the re-check optional rather than
    /// coupling every caller to that map).
    pub(crate) async fn replace_timeline(
        &self,
        app: &AppHandle,
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
        timeline: std::sync::Arc<matrix_sdk_ui::Timeline>,
        expected_event_id: Option<&matrix_sdk::ruma::EventId>,
    ) -> Option<std::sync::Arc<matrix_sdk_ui::Timeline>> {
        // Review fix: this used to only `.abort()` the previous listener *in
        // place* (via `get_mut`, keeping the entry cached so `is_timeline_open`
        // stayed correct) and defer the actual `.await` of its shutdown until
        // the later `push` displaced it — leaving a residual window where the
        // old listener could still be mid-unwind while the new one was
        // already spawned and running, both able to emit their own
        // `timeline:update` for this room. Genuinely popping the entry,
        // aborting, and fully *awaiting* its shutdown before spawning the new
        // listener closes that window entirely; `transitioning_timelines`
        // (see its own doc comment on `MatrixState`) is what keeps
        // `is_timeline_open` correct while this room briefly has no entry
        // cached during that pop-to-repush span.
        // Review fix: this call's own `HashSet::insert` return value used
        // to be discarded — every early-return and the final success path
        // below unconditionally removed the room's marker regardless of
        // whether *this* call was the one that actually inserted it. If
        // this raced a *different* concurrent transition for the same room
        // (e.g. `get_or_create_timeline`'s own `force_live` reset), that
        // other call's `insert` would return `false` (already present), yet
        // this call could still finish first and remove the marker while
        // the other transition was still mid-flight (popped its old entry,
        // still building the replacement) — reopening the exact
        // `is_timeline_open` false-negative window the marker exists to
        // close, for however long that other call had left to run.
        // `inserted_transition_marker`, gated the same way
        // `get_or_create_timeline` already gates its own removal, means
        // only the call that actually claimed the marker ever clears it.
        let inserted_transition_marker = self
            .transitioning_timelines
            .lock()
            .await
            .insert(room_id.to_owned());

        // Review fix: this used to pop unconditionally, before ever
        // checking `expected_event_id` — so a stale call (already
        // superseded by a newer jump for this room by the time it got
        // here) could pop and abort the *newer* jump's just-installed
        // entry, then fail its own `expected_event_id` re-check further
        // below and return `None` without restoring anything, leaving the
        // room with no cached timeline/listener at all until some later
        // fetch happened to recreate one. Checking here, atomically with
        // the pop (both under the same `self.timelines` guard, so nothing
        // else can install a fresher entry in between), means a stale call
        // never touches whatever's currently cached in the first place.
        let previous = {
            let mut timelines = self.timelines.lock().await;
            if let Some(event_id) = expected_event_id {
                let still_latest = self
                    .latest_jump_target
                    .lock()
                    .await
                    .get(room_id)
                    .is_some_and(|target| target == event_id);
                if !still_latest {
                    drop(timelines);
                    if inserted_transition_marker {
                        self.transitioning_timelines.lock().await.remove(room_id);
                    }
                    return None;
                }
            }
            timelines.pop(room_id)
        };
        if let Some((_, previous_handle, _)) = previous {
            previous_handle.abort();
            let _ = previous_handle.await;
        }

        // Review fix: the caller's own pre-check (comparing the active
        // client against the one it captured, before ever calling this
        // function) only guards the window *before* this call — it says
        // nothing about a logout/account-switch landing during the
        // `previous_handle.await` above, which can take a while (it's a
        // genuine wait for the old listener task to fully unwind, not just
        // an abort signal). `clear_local_session` clears `self.client` and
        // this whole `timelines` cache on logout, but this task is still
        // holding the caller's now-stale `Client` clone and would otherwise
        // go ahead and install a listener built from it into the process-
        // wide, room-id-keyed cache regardless — the same cross-account
        // leak class the pre-check exists to close, just reopened by this
        // function's own internal await. Re-checking here, immediately
        // before installing anything, closes that second window too.
        //
        // Review fix: comparing only `user_id()` doesn't catch signing out
        // and back into the *same* account while this was in flight — a
        // fresh login gets a new `Client`/session (new device id, new sync
        // token, the old session's tokens revoked) but the same user id, so
        // a `user_id()`-only check would pass and still install a listener
        // built from the revoked session. `device_id()` is unique per login
        // session (password/SSO/QR each mint a fresh device), so comparing
        // it instead also catches same-account re-logins, not just
        // cross-account switches.
        //
        // Review fix: checking here and *then* separately re-acquiring
        // `self.timelines` for the `push` below left one more window open —
        // `self.timelines.lock().await` is itself a suspension point, and if
        // it has to wait (e.g. `clear_timelines` racing this call for the
        // same lock, which is exactly what a concurrent logout does), the
        // check above could still be stale by the time this task resumes
        // and actually pushes. Holding `self.timelines`'s guard across both
        // the check and the push closes this atomically: `clear_timelines`
        // needs that same lock to clear the cache, so it can't run between
        // this check and this push once the guard is held.
        let mut timelines = self.timelines.lock().await;
        // Review fix: `device_id()` alone isn't a globally unique session
        // identity — it's only scoped to be unique *per Matrix user*, so a
        // logout of account A followed by a login of a *different* account
        // B could coincidentally mint a device id string equal to one A had
        // used, passing this check for the wrong account. Comparing
        // `user_id()` too closes that (astronomically unlikely, but not
        // impossible) gap.
        let still_active = self.client.lock().await.as_ref().is_some_and(|current| {
            current.user_id() == client.user_id() && current.device_id() == client.device_id()
        });
        if !still_active {
            drop(timelines);
            if inserted_transition_marker {
                self.transitioning_timelines.lock().await.remove(room_id);
            }
            return None;
        }

        // Review fix: the caller's own `still_latest` check (comparing
        // against `latest_jump_target`) only covers the window *before*
        // this call — it says nothing about a *newer* jump for this same
        // room superseding this one during the `previous_handle.await`
        // above, which is a genuine wait for the old listener to fully
        // unwind. If that newer jump's own `load_focused_event_timeline`
        // resolves and calls this function first, this (now-stale) call
        // would still go on to overwrite the cache with its own outdated
        // focused view once it resumes. Re-checking here, atomically with
        // the push below (same `self.timelines` guard already held),
        // closes that window the same way the `still_active` check above
        // does for a concurrent logout.
        if let Some(event_id) = expected_event_id {
            let still_latest = self
                .latest_jump_target
                .lock()
                .await
                .get(room_id)
                .is_some_and(|target| target == event_id);
            if !still_latest {
                drop(timelines);
                if inserted_transition_marker {
                    self.transitioning_timelines.lock().await.remove(room_id);
                }
                return None;
            }
        }

        let handle = timeline::spawn_timeline_listener(
            app.clone(),
            room_id.to_owned(),
            std::sync::Arc::downgrade(&timeline),
            client.clone(),
            client.user_id().map(ToOwned::to_owned),
        );

        // Review fix: `push`'s return value was previously discarded. If
        // another caller (e.g. a concurrent `get_or_create_timeline`)
        // inserted a fresh entry for this same room in the window between
        // the `pop` above and this `push`, that displaced entry's listener
        // handle would otherwise be dropped — detaching, not stopping, its
        // task (same open-handle hazard `get_or_create_timeline`'s own
        // eviction handling exists to avoid), leaving it to keep emitting
        // `timeline:update` against a live tail concurrently with this
        // event-focused view.
        //
        // Marked `is_focused = true`: this entry is a `TimelineFocus::Event`
        // view, not the room's live tail — see `is_timeline_open` and
        // `get_or_create_timeline`'s own doc comments for why that
        // distinction matters (notifications and self-healing back to live).
        let displaced = timelines.push(
            room_id.to_owned(),
            (std::sync::Arc::clone(&timeline), handle, true),
        );
        drop(timelines);
        if inserted_transition_marker {
            self.transitioning_timelines.lock().await.remove(room_id);
        }
        if let Some((_, (_, displaced_handle, _))) = displaced {
            displaced_handle.abort();
            let _ = displaced_handle.await;
        }

        Some(timeline)
    }

    /// Drops every live `Timeline` this session holds — called on
    /// logout/deactivate (see `account::clear_local_session`). Without this,
    /// the cache stays keyed by bare `room_id` across accounts: signing into
    /// a different account in the same process and opening a room with the
    /// same id as one the previous account had open would otherwise be
    /// served that stale `Timeline` (and its listener still emitting for the
    /// old client) before ever consulting the new one.
    /// Whether `room_id` currently has a live `Timeline` held open (i.e. the
    /// user has the room open right now). `sync::notify_unopened_room_messages`
    /// uses this to only handle notifications for rooms *without* one —
    /// `spawn_timeline_listener`'s own `maybe_notify_new_message` already
    /// covers whichever room(s) are open, so this avoids double-notifying
    /// (or double-computing mentions) for a room covered by both paths.
    /// `peek`, not `get`: this must not perturb the LRU's recency ordering as
    /// a side effect of merely checking membership.
    pub(crate) async fn is_timeline_open(&self, room_id: &matrix_sdk::ruma::RoomId) -> bool {
        // Review fix: a focused (`TimelineFocus::Event`) entry left behind
        // by a Saved Messages jump doesn't receive new live sync events the
        // way the room's ordinary live timeline does, so its listener never
        // fires `maybe_notify_new_message` for anything arriving after the
        // jump — only a genuinely live entry means "this room's own listener
        // has it covered, skip the unopened-room notification path here".
        //
        // Also true while the room is mid-swap (`transitioning_timelines`):
        // `replace_timeline`/`get_or_create_timeline`'s `force_live` path
        // briefly has no entry in `timelines` at all while it fully awaits
        // the previous listener's shutdown before spawning the new one (see
        // that field's own doc comment) — without this check, a message
        // arriving in that exact window would be misrouted through
        // `notify_unopened_room_messages`'s unopened-room path even though
        // this room is, from the user's perspective, still very much open.
        if self.transitioning_timelines.lock().await.contains(room_id) {
            return true;
        }
        matches!(
            self.timelines.lock().await.peek(room_id),
            Some((_, _, false))
        )
    }

    /// Records that a local notification is about to be fired for
    /// `event_id`, returning `true` the first time (go ahead and notify) and
    /// `false` if it's already been marked (skip — some other path already
    /// notified, or is about to). See `notified_event_ids`'s doc comment for
    /// why two independent paths can otherwise both reach for the same
    /// event.
    pub(crate) fn mark_notified(&self, event_id: &str) -> bool {
        let mut notified = self
            .notified_event_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if notified.contains(event_id) {
            return false;
        }
        notified.put(event_id.to_string(), ());
        true
    }

    pub(crate) fn forget_notified(&self, event_id: &str) {
        self.notified_event_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop(event_id);
    }

    /// Aborts and *awaits* every live timeline listener before dropping the
    /// cache's own `Arc<Timeline>` references — not just `clear()`, which
    /// would drop this method's own references but leave each listener task
    /// running (and holding its own `Client` clone, hence the store's open
    /// file handles under it) until it next happens to notice its
    /// `Timeline` was evicted, up to `TIMELINE_LIVENESS_CHECK_INTERVAL`
    /// (30s) later. Callers relying on "nothing is touching the old
    /// client/store anymore" once this returns — e.g.
    /// `sync::abort_current_sync_loop`, immediately before a login
    /// supersedes the account's store — need that guarantee now, not up to
    /// 30 seconds from now.
    pub(crate) async fn clear_timelines(&self) {
        let mut timelines = self.timelines.lock().await;
        let mut handles = Vec::new();
        while let Some((_, (_, handle, _))) = timelines.pop_lru() {
            handle.abort();
            handles.push(handle);
        }
        drop(timelines);
        for handle in handles {
            let _ = handle.await;
        }
    }

    /// Clears this module's authoritative pinned-events cache and its
    /// per-room lock map entirely.
    ///
    /// Review fix: `abort_current_sync_loop` already drops the old
    /// `Client` (and its store) before a logout or a same-process
    /// re-login/account-switch installs a new one, but it left
    /// `pinned_event_cache` untouched — a process-wide map keyed only by
    /// room id, with no notion of *which* client/session populated an
    /// entry. A same-process re-login (or account switch) reusing a room
    /// id the previous session had already cached would let the very next
    /// pin/unpin send a full `m.room.pinned_events` replacement built from
    /// the *previous* session's stale list, silently dropping any pins
    /// that changed while that old client was signed out. Called
    /// alongside `clear_timelines` for the same "nothing carries over from
    /// the old client" guarantee.
    pub(crate) async fn clear_pinned_event_cache(&self) {
        self.pinned_event_cache.lock().await.clear();
        self.pinned_event_locks.lock().await.clear();
        // Review fix: see `pinned_event_cache_generation`'s own doc comment
        // — lets `pin_event`/`unpin_event` detect a session change that
        // happened while their homeserver send was still in flight, so
        // they can skip resurrecting a stale entry into the cache this
        // just cleared.
        self.pinned_event_cache_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Lazily initializes (on first use) and returns the shared media cache,
    /// rebuilding its in-memory index from a directory scan the first time
    /// it's created.
    pub(crate) async fn require_media_cache(
        &self,
        app: &AppHandle,
    ) -> Result<&media::MediaCache, String> {
        self.media_cache
            .get_or_try_init(|| async {
                let dir = media::media_dir(app)?;
                let cache = media::MediaCache::new(dir);
                cache.rebuild_index().await?;
                Ok::<_, String>(cache)
            })
            .await
    }

    /// Returns (creating if needed) the lock serializing pin/unpin state
    /// writes for `room_id` — see `pinned_event_locks`'s own doc comment.
    pub(crate) async fn pinned_event_lock(
        &self,
        room_id: &matrix_sdk::ruma::RoomId,
    ) -> std::sync::Arc<Mutex<()>> {
        std::sync::Arc::clone(
            self.pinned_event_locks
                .lock()
                .await
                .entry(room_id.to_owned())
                .or_default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_notified_returns_true_only_the_first_time() {
        let state = MatrixState::default();
        assert!(state.mark_notified("$event:example.org"));
        assert!(!state.mark_notified("$event:example.org"));
    }

    #[test]
    fn mark_notified_tracks_distinct_events_independently() {
        let state = MatrixState::default();
        assert!(state.mark_notified("$a:example.org"));
        assert!(state.mark_notified("$b:example.org"));
        assert!(!state.mark_notified("$a:example.org"));
        assert!(!state.mark_notified("$b:example.org"));
    }

    /// Review fix regression test: a same-process re-login/account-switch
    /// reusing a room id a previous session had already cached must not
    /// see that previous session's stale pinned list — see
    /// `clear_pinned_event_cache`'s own doc comment.
    #[tokio::test]
    async fn clear_pinned_event_cache_empties_the_cache_and_lock_map() {
        let state = MatrixState::default();
        let room_id = matrix_sdk::ruma::room_id!("!room:example.org").to_owned();
        state.pinned_event_cache.lock().await.insert(
            room_id.clone(),
            vec![matrix_sdk::ruma::owned_event_id!("$stale")],
        );
        let _lock = state.pinned_event_lock(&room_id).await;

        let generation_before = state
            .pinned_event_cache_generation
            .load(std::sync::atomic::Ordering::SeqCst);
        state.clear_pinned_event_cache().await;

        assert!(state.pinned_event_cache.lock().await.is_empty());
        assert!(state.pinned_event_locks.lock().await.is_empty());
        // Review fix regression test: `pin_event`/`unpin_event` capture
        // this generation before their homeserver send and skip their own
        // cache write if it's since changed — see the field's own doc
        // comment. Without the bump, a send outliving this clear could
        // still resurrect a stale entry into the freshly-cleared cache.
        assert_eq!(
            state
                .pinned_event_cache_generation
                .load(std::sync::atomic::Ordering::SeqCst),
            generation_before + 1,
        );
    }
}
