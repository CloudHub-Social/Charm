pub mod account;
pub mod account_data;
pub mod actions;
pub mod auth;
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

/// A live per-room `Timeline` paired with its listener task's `JoinHandle` —
/// see `MatrixState::timelines`'s doc comment for why the handle is kept
/// alongside the `Arc`.
type TimelineEntry = (
    std::sync::Arc<matrix_sdk_ui::Timeline>,
    tokio::task::JoinHandle<()>,
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
    pub(crate) dnd: std::sync::Mutex<dnd::DndState>,
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
            media_cache: tokio::sync::OnceCell::default(),
            sync_presence: std::sync::Mutex::default(),
            timelines: Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(MAX_LIVE_TIMELINES)
                    .expect("MAX_LIVE_TIMELINES is a nonzero constant"),
            )),
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

    /// Returns the live `Timeline` for `room_id`, building (and spawning its
    /// `timeline:update`-emitting listener task) on first use if it isn't
    /// already held. Bounded LRU: opening more than [`MAX_LIVE_TIMELINES`]
    /// distinct rooms in a session evicts the least-recently-opened one
    /// rather than growing unbounded.
    pub(crate) async fn get_or_create_timeline(
        &self,
        app: &AppHandle,
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
    ) -> Result<std::sync::Arc<matrix_sdk_ui::Timeline>, String> {
        use matrix_sdk_ui::timeline::RoomExt as _;

        if let Some((existing, _)) = self.timelines.lock().await.get(room_id) {
            return Ok(std::sync::Arc::clone(existing));
        }

        let room = client
            .get_room(room_id)
            .ok_or_else(|| format!("room {room_id} not found"))?;
        let timeline = std::sync::Arc::new(room.timeline().await.map_err(|e| e.to_string())?);

        let mut timelines = self.timelines.lock().await;
        // Re-check: another concurrent call may have built and inserted one
        // for this same room while this call was awaiting `room.timeline()`
        // above (lock isn't held across that await) — keep whichever was
        // inserted first rather than running two listener tasks for one room.
        if let Some((existing, _)) = timelines.get(room_id) {
            return Ok(std::sync::Arc::clone(existing));
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
            (std::sync::Arc::clone(&timeline), handle),
        );
        // Dropped before awaiting the evicted handle below: holding the
        // cache's own lock while awaiting an unrelated task's abort would
        // block every other `get_or_create_timeline`/`is_timeline_open`
        // caller for however long that task takes to unwind, for no reason.
        drop(timelines);
        if let Some((_, (_, evicted_handle))) = evicted {
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
        self.timelines.lock().await.peek(room_id).is_some()
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
        while let Some((_, (_, handle))) = timelines.pop_lru() {
            handle.abort();
            handles.push(handle);
        }
        drop(timelines);
        for handle in handles {
            let _ = handle.await;
        }
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
}
