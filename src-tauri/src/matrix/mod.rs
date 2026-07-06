pub mod actions;
pub mod commands;
pub mod ephemeral;
pub mod media;
pub mod members;
pub mod persistence;
pub mod presence;
pub mod profiles;
pub mod qr_login;
pub mod rooms;
pub mod send;
pub mod spaces;
pub mod timeline;
pub mod verification;

use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::api::client::account::register;
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, Dummy};
use matrix_sdk::store::RoomLoadSettings;
use matrix_sdk::utils::UrlOrQuery;
use matrix_sdk::Client;
use rand::distr::Alphanumeric;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use ts_rs::TS;

/// The `charm://` deep-link the homeserver's SSO flow redirects back to with
/// a `loginToken` query param, picked up by a dedicated `onOpenUrl`
/// deep-link listener in `LoginScreen.tsx` (separate from the
/// room-link-handling one in `src/lib/deepLink.ts`). Each attempt appends
/// its own `state` param (see [`PendingSso`]) so a callback can't be
/// completed against the wrong attempt.
const SSO_REDIRECT_BASE_URL: &str = "charm://sso-callback";

/// A client with an SSO login URL in flight but not yet completed, plus the
/// random per-attempt token embedded in that URL's `state` param —
/// `complete_sso_login` checks the callback's `state` against this before
/// exchanging its `loginToken`, so a `charm://sso-callback` deep link
/// belonging to a different (possibly forged, possibly just stale) attempt
/// can't be completed against this one.
struct PendingSso {
    client: Client,
    state: String,
    /// The temp store key `build_client` opened this client's store under —
    /// the account isn't known until the callback completes, so this isn't
    /// an `account_key` yet. `complete_sso_login` relocates it to one on
    /// success; `cancel_sso_login` discards it on cancellation.
    store_key: String,
}

/// How many rooms' live `matrix-sdk-ui` `Timeline`s are held open at once
/// (see `MatrixState::get_or_create_timeline`) — bounds memory so visiting
/// many rooms in one session doesn't grow the set of subscribed timelines
/// (and their background listener tasks) without limit. LRU-evicted; the
/// evicted `Arc<Timeline>`'s `Drop` tears down its background tasks once
/// every clone (including any in-flight command still holding one) is gone.
const MAX_LIVE_TIMELINES: usize = 20;

/// Holds the active matrix-rust-sdk client for the running session.
/// One `MatrixState` per app instance; per-account multiplexing (multiple
/// *concurrently active* clients) is a Day-2 concern. Storage itself,
/// however, is already isolated per account on disk/keychain — see
/// `persistence::account_key`.
pub struct MatrixState {
    client: Mutex<Option<Client>>,
    /// Set by `start_sso_login`, consumed by `complete_sso_login`. Built
    /// once and carried across the two calls (rather than rebuilt in
    /// `complete_sso_login`) so it keeps whatever `.well-known` discovery
    /// result and homeserver connection `start_sso_login` already resolved.
    pending_sso: Mutex<Option<PendingSso>>,
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
    /// sync with the last successful `set_presence` call. `spawn_sync_loop`
    /// reads this fresh on every iteration (rather than baking a single
    /// `SyncSettings::default()` — which always reports `Online` — into one
    /// long-lived `sync_with_callback` call) so an explicit `unavailable`/
    /// `offline` choice actually sticks across syncs instead of being
    /// silently reverted to online by the next long-poll.
    pub(crate) sync_presence: std::sync::Mutex<presence::PresenceStateDto>,
    /// Live per-room `matrix-sdk-ui` `Timeline`s, built lazily the first time
    /// a room is opened (`get_timeline_page`) and bounded to
    /// [`MAX_LIVE_TIMELINES`] — see `get_or_create_timeline`.
    timelines: Mutex<
        lru::LruCache<matrix_sdk::ruma::OwnedRoomId, std::sync::Arc<matrix_sdk_ui::Timeline>>,
    >,
}

impl Default for MatrixState {
    fn default() -> Self {
        Self {
            client: Mutex::default(),
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

        if let Some(existing) = self.timelines.lock().await.get(room_id) {
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
        if let Some(existing) = timelines.get(room_id) {
            return Ok(std::sync::Arc::clone(existing));
        }

        timeline::spawn_timeline_listener(
            app.clone(),
            room_id.to_owned(),
            std::sync::Arc::downgrade(&timeline),
            client.clone(),
            client.user_id().map(ToOwned::to_owned),
        );
        timelines.push(room_id.to_owned(), std::sync::Arc::clone(&timeline));

        Ok(timeline)
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

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct LoginRequest {
    /// A server name (e.g. `matrix.org`) or a full homeserver URL — resolved
    /// via `.well-known/matrix/client` discovery in [`build_client`].
    pub homeserver_url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RegisterRequest {
    /// Same flexible server-name-or-URL input as [`LoginRequest::homeserver_url`].
    pub homeserver_url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct DiscoverHomeserverResponse {
    pub homeserver_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct LoginResponse {
    pub user_id: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SyncStateEvent {
    Syncing,
    Idle,
    Error { message: String },
}

/// Flat room summary for the room list. No message preview yet — that needs
/// the timeline/event-cache API, which is Phase 1 timeline-rendering scope,
/// not this first sync-wiring cut.
///
/// `has_unread` is the single authoritative "needs attention" signal (see
/// [`rooms::has_unread`]) — computed once here, in [`snapshot_rooms`]; every
/// UI unread indicator reads this field rather than re-deriving it from
/// `unread_count`/`unread_messages`/`is_marked_unread` itself.
///
/// `list_rooms`/`room_list:update` pre-sort by (section, `manual_order`,
/// name) in [`snapshot_rooms`] — the frontend performs no sorting.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomSummary {
    pub room_id: String,
    pub name: Option<String>,
    // u64 serializes to a JS-safe integer here (notification counts are small); emit
    // `number` rather than ts-rs's default `bigint` so the frontend can use it directly.
    #[ts(type = "number")]
    pub unread_count: u64,
    /// `room.num_unread_messages()` — ambient unread, distinct from
    /// `unread_count` (notifications/mentions).
    #[ts(type = "number")]
    pub unread_messages: u64,
    /// The MSC2867 `m.marked_unread` flag (`room.is_marked_unread()`).
    pub is_marked_unread: bool,
    /// True when the user-defined-or-default notification mode for this
    /// room is `Mute`.
    pub is_muted: bool,
    /// `m.favourite` tag present.
    pub is_favourite: bool,
    /// `m.lowpriority` tag present.
    pub is_low_priority: bool,
    /// `TagInfo.order` for whichever tag currently governs this room's
    /// section — see `rooms::order_tag_name`. `None` sorts last within its
    /// section.
    pub manual_order: Option<f64>,
    /// `room.room_type() == Some(RoomType::Space)`.
    pub is_space: bool,
    /// Space room ids whose `m.space.child` state references this room.
    pub parent_space_ids: Vec<String>,
    /// `room.is_direct()` (DM grouping).
    pub is_direct: bool,
    /// The single "does this room need attention" signal — see
    /// [`rooms::has_unread`]. Every unread indicator in the UI reads this,
    /// not the raw counts above.
    pub has_unread: bool,
    /// The room's own avatar mxc, when `m.room.avatar` is set — otherwise,
    /// for an unnamed direct room, the single peer's avatar (from
    /// `Room::heroes()`). `None` means render the initials fallback; see
    /// [`resolve_room_identity`].
    pub avatar_url: Option<String>,
    /// `avatar_url` resolved to a local thumbnail path via Spec 02's media
    /// cache, or `None` if unresolved (no cache yet, no avatar, or the fetch
    /// failed) — the frontend falls back to initials in that case.
    pub avatar_path: Option<String>,
    /// For a direct room with exactly one other member, that member's user
    /// id — lets the frontend key a presence lookup (`usePresence`) off the
    /// DM peer rather than the room. `None` for group rooms and for direct
    /// rooms matrix-rust-sdk can't resolve a single hero for (e.g. the peer
    /// hasn't been synced yet).
    pub dm_peer_user_id: Option<String>,
}

/// Authenticates against a real homeserver via matrix-rust-sdk, persists the
/// session (SQLCipher-encrypted store on disk, passphrase + session tokens in
/// the OS keychain — never in the same file, never in plaintext) so future
/// launches can skip this and go straight to `try_restore_session`, and kicks
/// off a background sync loop that emits `sync:state` and `room_list:update`
/// events back to the frontend.
#[tauri::command]
pub async fn login(
    app: AppHandle,
    state: State<'_, MatrixState>,
    request: LoginRequest,
) -> Result<LoginResponse, String> {
    // The account's MXID isn't known for certain until login succeeds (the
    // homeserver, not the client, has final say over the resolved server
    // name), so this opens a temp store like SSO/QR and relocates it to the
    // per-account path below — see `persistence::relocate_store`.
    let temp_key = persistence::temp_store_key();
    let client = build_client(&app, &request.homeserver_url, &temp_key).await?;

    client
        .matrix_auth()
        .login_username(&request.username, &request.password)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let session = client
        .matrix_auth()
        .session()
        .ok_or_else(|| "login succeeded but no session was returned".to_string())?;

    let account_key = persistence::account_key(session.meta.user_id.as_str());
    // Persist the *resolved* URL (not the raw server-name-or-URL input) so
    // `try_restore_session` doesn't need to re-run discovery on every launch.
    let homeserver_url = client.homeserver().to_string();
    let client = relocate_or_reuse_matrix_auth_store(
        &app,
        client,
        &temp_key,
        &account_key,
        &homeserver_url,
        &session,
    )
    .await?;

    persistence::save_session(&account_key, &homeserver_url, &session)?;
    // Enforces the single-account invariant: only one session kind
    // (password/SSO's MatrixSession vs QR login's OAuthSession) should be
    // present at a time.
    let _ = persistence::clear_oauth_session(&account_key);

    let response = LoginResponse {
        user_id: session.meta.user_id.to_string(),
        device_id: session.meta.device_id.to_string(),
    };

    *state.client.lock().await = Some(client.clone());
    spawn_sync_loop(app, client);

    Ok(response)
}

/// Called once at app startup, before showing the login screen: if a session
/// was saved by a previous `login`, restores it against the same SQLCipher
/// store and resumes sync — no password re-entry. Returns `None` (not an
/// error) both when there's nothing saved and when a saved session turns out
/// to be dead (e.g. the homeserver revoked the token); in the latter case the
/// stale entry is cleared so future launches don't keep retrying it.
#[tauri::command]
pub async fn try_restore_session(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<Option<LoginResponse>, String> {
    // Which account (if any) has a session worth restoring isn't known
    // up front — iterate every account this install has a store for and
    // restore the first one with a live saved session. Single-active-client
    // for now (Day-2 multi-account UI will change this), so the first match
    // wins.
    //
    // Deliberately no `?` inside this loop: a transient failure for one
    // account (e.g. a momentarily locked keychain, or a homeserver that's
    // unreachable right now) shouldn't abort the whole restore attempt and
    // strand a user who has a perfectly restorable *other* account — log
    // and move on to the next `account_key` instead.
    for account_key in persistence::known_account_keys(&app)? {
        // Password/SSO login (matrix_auth()) and QR login (oauth()) are
        // unrelated session kinds in matrix-sdk, persisted under separate
        // keychain entries — see persistence::SavedOAuthSession. Only one
        // should ever be present at a time per account, but check both
        // rather than assuming which.
        let oauth_session = match persistence::load_oauth_session(&account_key) {
            Ok(session) => session,
            Err(e) => {
                eprintln!("failed to load oauth session for {account_key}: {e}");
                continue;
            }
        };
        if let Some(saved) = oauth_session {
            match restore_oauth_session(&app, &state, &account_key, saved).await {
                Ok(Some(response)) => return Ok(Some(response)),
                Ok(None) => {}
                Err(e) => eprintln!("failed to restore oauth session for {account_key}: {e}"),
            }
            continue;
        }

        let saved = match persistence::load_session(&account_key) {
            Ok(Some(saved)) => saved,
            Ok(None) => continue,
            Err(e) => {
                eprintln!("failed to load session for {account_key}: {e}");
                continue;
            }
        };

        let client = match build_client(&app, &saved.homeserver_url, &account_key).await {
            Ok(client) => client,
            Err(e) => {
                eprintln!("failed to build client for {account_key}: {e}");
                continue;
            }
        };

        if client
            .matrix_auth()
            .restore_session(saved.session.clone(), RoomLoadSettings::default())
            .await
            .is_err()
        {
            let _ = persistence::clear_session(&account_key);
            continue;
        }

        let response = LoginResponse {
            user_id: saved.session.meta.user_id.to_string(),
            device_id: saved.session.meta.device_id.to_string(),
        };

        *state.client.lock().await = Some(client.clone());
        spawn_sync_loop(app.clone(), client);

        return Ok(Some(response));
    }

    Ok(None)
}

async fn restore_oauth_session(
    app: &AppHandle,
    state: &State<'_, MatrixState>,
    account_key: &str,
    saved: persistence::SavedOAuthSession,
) -> Result<Option<LoginResponse>, String> {
    let homeserver_url = saved.homeserver_url.clone();
    let client = build_client(app, &homeserver_url, account_key).await?;
    let session = saved.into_oauth_session();

    if client
        .oauth()
        .restore_session(session, RoomLoadSettings::default())
        .await
        .is_err()
    {
        let _ = persistence::clear_oauth_session(account_key);
        return Ok(None);
    }

    let Some(session_meta) = client.session_meta().cloned() else {
        let _ = persistence::clear_oauth_session(account_key);
        return Ok(None);
    };

    let response = LoginResponse {
        user_id: session_meta.user_id.to_string(),
        device_id: session_meta.device_id.to_string(),
    };

    // Enforces the single-account invariant this function's caller documents:
    // only one session kind should be present at a time. Guards against
    // stale data from before this was enforced at save time (see
    // qr_login::start_qr_login).
    let _ = persistence::clear_session(account_key);

    *state.client.lock().await = Some(client.clone());
    spawn_sync_loop(app.clone(), client);

    Ok(Some(response))
}

/// Accepts either a bare server name (`matrix.org`) or a full homeserver URL —
/// `server_name_or_homeserver_url` runs `.well-known/matrix/client` discovery
/// for the former and falls back to treating the input as a URL otherwise.
async fn build_client(
    app: &AppHandle,
    homeserver_url: &str,
    store_key: &str,
) -> Result<Client, String> {
    let store_path = persistence::store_path(app, store_key)?;
    let passphrase = persistence::get_or_create_passphrase(store_key)?;

    Client::builder()
        .server_name_or_homeserver_url(homeserver_url)
        .sqlite_store(&store_path, Some(&passphrase))
        .build()
        .await
        .map_err(|e| e.to_string())
}

/// Relocates a temp-backed login's store to its per-account path, and — if
/// [`persistence::relocate_store`] reports that account already had a store
/// (a re-login) — swaps `client` out for a fresh one built against the
/// *existing* store with `session` restored onto it.
///
/// This distinction matters: `relocate_store` discards the temp directory
/// outright when the account already has a store (reusing the existing one
/// rather than overwriting it — matrix-rust-sdk binds a store to whichever
/// account first opened it, so relocating on top of a differently-bound
/// existing store would reintroduce the very collision this module fixes).
/// But `client` was already built against that now-deleted temp directory;
/// continuing to use it would mean every write this session makes (sync
/// state, crypto/device data) goes to files that no longer exist on disk
/// once their handles close, silently lost.
///
/// Deliberately branches on `relocate_store`'s *return value*, not a
/// separate pre-check of whether the account store exists: checking that
/// beforehand and then calling `relocate_store` separately would race — a
/// concurrent login for the same account could create the account store in
/// the gap between those two calls, so the pre-check result wouldn't
/// necessarily match what `relocate_store` actually did.
async fn relocate_or_reuse_matrix_auth_store(
    app: &AppHandle,
    client: Client,
    temp_key: &str,
    account_key: &str,
    homeserver_url: &str,
    session: &matrix_sdk::authentication::matrix::MatrixSession,
) -> Result<Client, String> {
    let outcome = persistence::relocate_store(app, temp_key, account_key)?;
    let persistence::RelocateOutcome::Reused(_) = outcome else {
        return Ok(client);
    };

    let existing_client = build_client(app, homeserver_url, account_key).await?;
    existing_client
        .matrix_auth()
        .restore_session(session.clone(), RoomLoadSettings::default())
        .await
        .map_err(|e| e.to_string())?;
    Ok(existing_client)
}

/// Resolves a server name or homeserver URL for live feedback on the
/// login/registration screen, before the user submits. matrix-sdk has no
/// discovery-only API that isn't tied to building a real `Client`, so this
/// builds a throwaway in-memory one (no local store) purely to run discovery.
#[tauri::command]
pub async fn discover_homeserver(input: String) -> Result<DiscoverHomeserverResponse, String> {
    Ok(DiscoverHomeserverResponse {
        homeserver_url: discover(&input).await?,
    })
}

/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/`, same rationale as [`resolve_alias`].
pub async fn discover(input: &str) -> Result<String, String> {
    let client = Client::builder()
        .server_name_or_homeserver_url(input)
        .build()
        .await
        .map_err(|e| e.to_string())?;

    Ok(client.homeserver().to_string())
}

/// Registers a new account and logs it in, mirroring [`login`]'s
/// session-persistence and sync-loop startup.
#[tauri::command]
pub async fn register(
    app: AppHandle,
    state: State<'_, MatrixState>,
    request: RegisterRequest,
) -> Result<LoginResponse, String> {
    // Same rationale as `login`: the account isn't certain until
    // registration succeeds, so this opens a temp store and relocates it.
    let temp_key = persistence::temp_store_key();
    let client = build_client(&app, &request.homeserver_url, &temp_key).await?;
    register_with_dummy_auth(&client, &request.username, &request.password).await?;

    let session = client
        .matrix_auth()
        .session()
        .ok_or_else(|| "registration succeeded but no session was returned".to_string())?;

    let account_key = persistence::account_key(session.meta.user_id.as_str());
    let homeserver_url = client.homeserver().to_string();
    let client = relocate_or_reuse_matrix_auth_store(
        &app,
        client,
        &temp_key,
        &account_key,
        &homeserver_url,
        &session,
    )
    .await?;

    persistence::save_session(&account_key, &homeserver_url, &session)?;
    // Enforces the single-account invariant: only one session kind
    // (password/SSO's MatrixSession vs QR login's OAuthSession) should be
    // present at a time.
    let _ = persistence::clear_oauth_session(&account_key);

    let response = LoginResponse {
        user_id: session.meta.user_id.to_string(),
        device_id: session.meta.device_id.to_string(),
    };

    *state.client.lock().await = Some(client.clone());
    spawn_sync_loop(app, client);

    Ok(response)
}

/// Registers `username`/`password` on `client`'s homeserver, leaving the
/// resulting session set on the client (same effect as a successful login).
///
/// Only the `m.login.dummy` User-Interactive Auth stage is supported — this
/// covers Synapse's default open-registration config (including our local dev
/// homeserver). Homeservers that require CAPTCHA, email verification, terms
/// acceptance, or a registration token return a clear error instead of
/// silently failing; supporting those is follow-up work, not a Phase 1
/// blocker.
///
/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/`, same rationale as [`resolve_alias`].
pub async fn register_with_dummy_auth(
    client: &Client,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let mut register_request = register::v3::Request::new();
    register_request.username = Some(username.to_owned());
    register_request.password = Some(password.to_owned());

    if let Err(e) = client
        .matrix_auth()
        .register(register_request.clone())
        .await
    {
        let uiaa = e.as_uiaa_response().ok_or_else(|| e.to_string())?.clone();

        let supports_dummy_only = uiaa
            .flows
            .iter()
            .any(|flow| flow.stages == [AuthType::Dummy]);
        if !supports_dummy_only {
            return Err(
                "this homeserver requires additional registration steps (CAPTCHA, email \
                 verification, terms acceptance, or a registration token) that Charm doesn't \
                 support yet"
                    .to_string(),
            );
        }

        let mut dummy = Dummy::new();
        dummy.session = uiaa.session;
        register_request.auth = Some(AuthData::Dummy(dummy));
        client
            .matrix_auth()
            .register(register_request)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Starts an SSO login: builds a client against `homeserver_url` and returns
/// the URL to open in the system browser. The client and a fresh random
/// `state` token are held in [`MatrixState::pending_sso`] until
/// [`complete_sso_login`] finishes the flow with the `loginToken` (and
/// matching `state`) the homeserver redirects back with.
#[tauri::command]
pub async fn start_sso_login(
    app: AppHandle,
    state: State<'_, MatrixState>,
    homeserver_url: String,
) -> Result<String, String> {
    // The account isn't known until the browser redirects back with a
    // `loginToken` — open a temp store now and relocate it in
    // `complete_sso_login` once the MXID is known.
    let store_key = persistence::temp_store_key();
    let client = build_client(&app, &homeserver_url, &store_key).await?;
    let attempt_state = generate_sso_state();
    let sso_url = get_sso_login_url(&client, &attempt_state).await?;

    let previous = state.pending_sso.lock().await.replace(PendingSso {
        client,
        state: attempt_state,
        store_key,
    });
    // A double-start (e.g. a double click) would otherwise overwrite the
    // previous attempt's `PendingSso` without ever discarding its temp
    // store/passphrase — same leak `cancel_sso_login` guards against, just
    // via a different trigger (a new attempt instead of an explicit
    // cancel).
    if let Some(previous) = previous {
        let _ = persistence::discard_temp_login_store(&app, &previous.store_key);
    }

    Ok(sso_url)
}

fn generate_sso_state() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// Discards a client left pending by [`start_sso_login`] if the user cancels
/// (or abandons) the flow before a `charm://sso-callback` ever arrives —
/// otherwise it just sits in [`MatrixState::pending_sso`], holding its
/// SQLite connection and HTTP pool open, until either a new SSO attempt
/// overwrites it or the app closes. A no-op if there's nothing pending.
#[tauri::command]
pub async fn cancel_sso_login(app: AppHandle, state: State<'_, MatrixState>) -> Result<(), String> {
    if let Some(pending) = state.pending_sso.lock().await.take() {
        let _ = persistence::discard_temp_login_store(&app, &pending.store_key);
    }
    Ok(())
}

/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/`, same rationale as [`resolve_alias`].
pub async fn get_sso_login_url(client: &Client, attempt_state: &str) -> Result<String, String> {
    let redirect_url = format!("{SSO_REDIRECT_BASE_URL}?state={attempt_state}");
    client
        .matrix_auth()
        .get_sso_login_url(&redirect_url, None)
        .await
        .map_err(|e| e.to_string())
}

/// Pulls the `state` query param out of a `charm://sso-callback?...` URL, so
/// [`complete_sso_login`] can check it against the attempt [`start_sso_login`]
/// recorded. Pure and Tauri-context-free by design — see the tests below —
/// unlike most of this module, which needs a real homeserver to test
/// meaningfully.
fn extract_sso_callback_state(callback_url: &str) -> Option<String> {
    let url = url::Url::parse(callback_url).ok()?;
    url.query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
}

#[cfg(test)]
mod sso_state_tests {
    use super::extract_sso_callback_state;

    #[test]
    fn extracts_the_state_param() {
        assert_eq!(
            extract_sso_callback_state("charm://sso-callback?state=abc123&loginToken=xyz"),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn returns_none_when_state_is_missing() {
        assert_eq!(
            extract_sso_callback_state("charm://sso-callback?loginToken=xyz"),
            None
        );
    }

    #[test]
    fn returns_none_for_a_malformed_url() {
        assert_eq!(extract_sso_callback_state("not a url at all"), None);
    }
}

/// Completes an SSO login started by [`start_sso_login`], given the full
/// `charm://sso-callback?state=...&loginToken=...` URL the homeserver
/// redirected the system browser to. Rejects (without consuming the pending
/// client — a genuine callback may still be on its way) if `state` doesn't
/// match the attempt [`start_sso_login`] recorded, so a forged or stale
/// deep link can't complete a real attempt.
#[tauri::command]
pub async fn complete_sso_login(
    app: AppHandle,
    state: State<'_, MatrixState>,
    callback_url: String,
) -> Result<LoginResponse, String> {
    let callback_state = extract_sso_callback_state(&callback_url)
        .ok_or_else(|| "SSO callback is missing its state parameter".to_string())?;

    let mut pending_sso = state.pending_sso.lock().await;
    let matches_pending = pending_sso
        .as_ref()
        .is_some_and(|pending| pending.state == callback_state);
    if !matches_pending {
        return Err("SSO callback does not match the pending login attempt".to_string());
    }
    let pending = pending_sso.take().expect("checked Some above");
    drop(pending_sso);
    let client = pending.client;

    if let Err(e) = complete_sso_login_with_callback(&client, &callback_url).await {
        // The account was never learned, so this temp store would
        // otherwise sit on disk (and in the keychain) until the next
        // startup sweep — clean it up now instead, same as a cancelled
        // attempt.
        let _ = persistence::discard_temp_login_store(&app, &pending.store_key);
        return Err(e);
    }

    let session = client
        .matrix_auth()
        .session()
        .ok_or_else(|| "SSO login succeeded but no session was returned".to_string())?;

    let account_key = persistence::account_key(session.meta.user_id.as_str());
    let homeserver_url = client.homeserver().to_string();
    let client = relocate_or_reuse_matrix_auth_store(
        &app,
        client,
        &pending.store_key,
        &account_key,
        &homeserver_url,
        &session,
    )
    .await?;

    persistence::save_session(&account_key, &homeserver_url, &session)?;
    // Enforces the single-account invariant: only one session kind
    // (password/SSO's MatrixSession vs QR login's OAuthSession) should be
    // present at a time.
    let _ = persistence::clear_oauth_session(&account_key);

    let response = LoginResponse {
        user_id: session.meta.user_id.to_string(),
        device_id: session.meta.device_id.to_string(),
    };

    *state.client.lock().await = Some(client.clone());
    spawn_sync_loop(app, client);

    Ok(response)
}

/// Exchanges the `loginToken` in `callback_url` for a real session on
/// `client`, leaving it set on the client (same effect as a successful
/// login).
///
/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/`, same rationale as [`resolve_alias`].
pub async fn complete_sso_login_with_callback(
    client: &Client,
    callback_url: &str,
) -> Result<(), String> {
    let url = url::Url::parse(callback_url).map_err(|e| e.to_string())?;
    client
        .matrix_auth()
        .login_with_sso_callback(UrlOrQuery::Url(url))
        .map_err(|e| e.to_string())?
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Reads the current room list out of the client's in-memory store —
/// no network round-trip, just whatever the last sync populated.
#[tauri::command]
pub async fn list_rooms(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<Vec<RoomSummary>, String> {
    let client = state.require_client().await?;
    let media_cache = state.require_media_cache(&app).await.ok();
    Ok(snapshot_rooms(&client, media_cache).await)
}

/// Resolves a room alias (e.g. `#general:localhost`) to its room id, so
/// `matrix.to` alias links can be matched against `RoomSummary.room_id`. This
/// does hit the network — aliases aren't part of the local sync state.
#[tauri::command]
pub async fn resolve_room_alias(
    state: State<'_, MatrixState>,
    alias: String,
) -> Result<String, String> {
    let client = state.require_client().await?;
    resolve_alias(&client, &alias).await
}

/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/alias_resolution.rs` rather than the `--lib` unit-test target CI runs
/// without a local Synapse available.
pub async fn resolve_alias(client: &Client, alias: &str) -> Result<String, String> {
    let room_alias = matrix_sdk::ruma::RoomAliasId::parse(alias).map_err(|e| e.to_string())?;
    let response = client
        .resolve_room_alias(&room_alias)
        .await
        .map_err(|e| e.to_string())?;
    Ok(response.room_id.to_string())
}

/// Resolves the media attached to `event_id` (an image/video/audio/file
/// `m.room.message`) to a local cache path, fetching and decrypting on a
/// cache miss. `thumbnail` requests a 256x256 scaled thumbnail instead of the
/// full file — callers pick based on where the media is being rendered
/// (message-list thumbnail vs. lightbox full view).
///
/// No opaque handle crosses IPC: the frontend passes back the plain
/// `(room_id, event_id)` it already has from `RoomMessageSummary`, and this
/// command re-derives the real `MediaSource` — including, for encrypted
/// media, the `EncryptedFile`'s AES key — by re-fetching the event
/// server-side. The key never leaves this function.
#[tauri::command]
pub async fn resolve_media(
    app: AppHandle,
    state: State<'_, MatrixState>,
    room_id: String,
    event_id: String,
    thumbnail: bool,
) -> Result<String, String> {
    let client = state.require_client().await?;
    let cache = state.require_media_cache(&app).await?;

    let parsed_room_id = matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;
    let parsed_event_id = matrix_sdk::ruma::EventId::parse(&event_id).map_err(|e| e.to_string())?;

    let event = room
        .event(&parsed_event_id, None)
        .await
        .map_err(|e| e.to_string())?;
    let raw = event.kind.raw();
    let deserialized: matrix_sdk::ruma::events::AnySyncTimelineEvent =
        raw.deserialize().map_err(|e| e.to_string())?;
    let matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
        matrix_sdk::ruma::events::AnySyncMessageLikeEvent::RoomMessage(msg),
    ) = deserialized
    else {
        return Err(format!("event {event_id} is not an m.room.message"));
    };
    let original = msg
        .as_original()
        .ok_or_else(|| format!("event {event_id} has been redacted"))?;

    let (source, thumbnail_source) = match &original.content.msgtype {
        matrix_sdk::ruma::events::room::message::MessageType::Image(image) => (
            image.source.clone(),
            image.info.as_ref().and_then(|i| i.thumbnail_source.clone()),
        ),
        matrix_sdk::ruma::events::room::message::MessageType::Video(video) => (
            video.source.clone(),
            video.info.as_ref().and_then(|i| i.thumbnail_source.clone()),
        ),
        matrix_sdk::ruma::events::room::message::MessageType::Audio(audio) => {
            (audio.source.clone(), None)
        }
        matrix_sdk::ruma::events::room::message::MessageType::File(file) => {
            (file.source.clone(), None)
        }
        _ => return Err(format!("event {event_id} has no media")),
    };

    let (resolved_source, kind) = if thumbnail {
        match thumbnail_source {
            Some(thumb_source) => (
                thumb_source,
                media::MediaKind::Thumbnail {
                    width: 256,
                    height: 256,
                },
            ),
            // No dedicated thumbnail: falling back to the full-size source
            // is only valid to request as a server-side *thumbnail* when
            // that source is `Plain` — homeservers cannot generate
            // thumbnails of `Encrypted` content (they can't decrypt it), so
            // a `MediaFormat::Thumbnail` request against an encrypted
            // source always fails server-side. Fetch (and decrypt) the
            // full file instead; the frontend renders it at the
            // thumbnail's display size regardless of the underlying pixel
            // dimensions.
            None if matches!(
                source,
                matrix_sdk::ruma::events::room::MediaSource::Encrypted(_)
            ) =>
            {
                (source, media::MediaKind::File)
            }
            None => (
                source,
                media::MediaKind::Thumbnail {
                    width: 256,
                    height: 256,
                },
            ),
        }
    } else {
        (source, media::MediaKind::File)
    };

    let path = media::resolve(cache, &client, resolved_source, kind).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// Builds a room-id -> parent-space-ids map by reading every space room's
/// `m.space.child` state — the reciprocal `m.space.parent` on the child is
/// unreliable (rooms aren't required to set it, and it can claim a parent
/// that never actually listed them), so parenthood here is defined by the
/// space's own child list, matching the client-side "which space's children
/// include this room" semantics `RoomList.tsx` groups by.
async fn parent_space_ids(client: &Client) -> std::collections::HashMap<String, Vec<String>> {
    use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;

    let mut parents: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for room in client.rooms() {
        if !room.is_space() {
            continue;
        }
        let space_id = room.room_id().to_string();
        let Ok(child_events) = room
            .get_state_events_static::<SpaceChildEventContent>()
            .await
        else {
            continue;
        };
        for raw_event in child_events {
            let Ok(event) = raw_event.deserialize() else {
                continue;
            };
            parents
                .entry(event.state_key().to_string())
                .or_default()
                .push(space_id.clone());
        }
    }
    parents
}

/// Sort key for the room list: section (Favourite -> Rooms -> Low priority),
/// then `manual_order` ascending (`None` last), then alphabetical by
/// display name — see Spec 06 "Ordering strategy". Computed once here so
/// `RoomList.tsx` performs no sorting of its own.
fn section_rank(is_favourite: bool, is_low_priority: bool) -> u8 {
    if is_favourite {
        0
    } else if is_low_priority {
        2
    } else {
        1
    }
}

/// A direct room's display identity beyond its own state: which hero (the
/// other member) to show when the room has no name/avatar of its own, and
/// that peer's resolved display name/avatar — see [`resolve_room_identity`].
struct RoomIdentity {
    name: Option<String>,
    avatar_url: Option<String>,
    avatar_path: Option<String>,
    dm_peer_user_id: Option<String>,
}

/// Resolves a room's display name and avatar, falling back to the single
/// other member's identity for an unnamed direct room — `Room::heroes()` is
/// already the same synced, cached data `Room::display_name()`'s
/// spec-mandated algorithm uses for exactly this case, so this needs no
/// separate member-profile fetch (see `profiles.rs`'s module doc comment for
/// why a bespoke member cache would be redundant here).
async fn resolve_room_identity(
    client: &Client,
    media_cache: Option<&media::MediaCache>,
    room: &matrix_sdk::Room,
    is_direct: bool,
) -> RoomIdentity {
    let raw_name = room.name();
    let raw_avatar_url = room.avatar_url();

    let dm_peer = is_direct
        .then(|| room.heroes())
        .and_then(|heroes| heroes.into_iter().next());

    let name = raw_name.or_else(|| {
        dm_peer.as_ref().map(|hero| {
            hero.display_name
                .clone()
                .unwrap_or_else(|| hero.user_id.to_string())
        })
    });

    let avatar_url = raw_avatar_url.map(|url| url.to_string()).or_else(|| {
        dm_peer
            .as_ref()
            .and_then(|hero| hero.avatar_url.clone())
            .map(|url| url.to_string())
    });

    let avatar_path = match &avatar_url {
        Some(mxc) => profiles::resolve_avatar_path(client, media_cache, mxc).await,
        None => None,
    };

    RoomIdentity {
        name,
        avatar_url,
        avatar_path,
        dm_peer_user_id: dm_peer.map(|hero| hero.user_id.to_string()),
    }
}

/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/`, same rationale as [`resolve_alias`]/[`discover`].
pub async fn snapshot_rooms(
    client: &Client,
    media_cache: Option<&media::MediaCache>,
) -> Vec<RoomSummary> {
    let parents = parent_space_ids(client).await;

    let mut summaries = Vec::new();
    for room in client.rooms() {
        let room_id = room.room_id().to_string();
        let unread_count = room.unread_notification_counts().notification_count;
        let unread_messages = room.num_unread_messages();
        let is_marked_unread = room.is_marked_unread();
        let is_favourite = room.is_favourite();
        let is_low_priority = room.is_low_priority();
        let is_muted = matches!(
            room.notification_mode().await,
            Some(matrix_sdk::notification_settings::RoomNotificationMode::Mute)
        );
        let manual_order = room.tags().await.ok().flatten().and_then(|tags| {
            let tag = rooms::order_tag_name(is_favourite, is_low_priority);
            tags.get(&tag).and_then(|info| info.order)
        });
        let is_space = room.is_space();
        let is_direct = room.is_direct().await.unwrap_or(false);
        let has_unread =
            rooms::has_unread(is_marked_unread, is_muted, unread_messages, unread_count);
        let identity = resolve_room_identity(client, media_cache, &room, is_direct).await;

        summaries.push((
            section_rank(is_favourite, is_low_priority),
            manual_order,
            identity.name.clone().unwrap_or_default(),
            RoomSummary {
                room_id: room_id.clone(),
                name: identity.name,
                unread_count,
                unread_messages,
                is_marked_unread,
                is_muted,
                is_favourite,
                is_low_priority,
                manual_order,
                is_space,
                parent_space_ids: parents.get(&room_id).cloned().unwrap_or_default(),
                is_direct,
                has_unread,
                avatar_url: identity.avatar_url,
                avatar_path: identity.avatar_path,
                dm_peer_user_id: identity.dm_peer_user_id,
            },
        ));
    }

    summaries.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| match (a.1, b.1) {
                (Some(a_order), Some(b_order)) => a_order.total_cmp(&b_order),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.2.cmp(&b.2))
    });

    summaries
        .into_iter()
        .map(|(_, _, _, summary)| summary)
        .collect()
}

// Spec 14 removed `spawn_send_queue_listener` (and the `send_queue:update`
// event/`SendQueueUpdateEvent` DTO it fed): a room's live `matrix-sdk-ui`
// `Timeline` now surfaces the same pending -> sent -> error transitions as
// per-item `send_state` on the `RoomMessageSummary`s it emits via
// `timeline:update` (see `timeline::spawn_timeline_listener`), so a second,
// room-list-wide event carrying the identical information was redundant for
// the message list this event only ever fed. If a future global "outbox" UI
// needs cross-room send-queue status independent of any single room's
// `Timeline` being open, that's a new, narrower listener to add back — not a
// reason to keep this one around unused in the meantime.

/// Emits `receipts:update`/`typing:update` for every joined room in one sync
/// response. Shared by the initial `sync_once` (whose response can already
/// carry ephemeral events — e.g. receipts left over from a prior session —
/// and would otherwise be silently dropped) and every iteration of the
/// long-running sync loop.
///
/// Message-timeline updates (`timeline:update`) are no longer driven from
/// here as of Spec 14: each open room's live `matrix-sdk-ui` `Timeline` (see
/// `MatrixState::get_or_create_timeline`) subscribes to its own diff stream
/// and emits `timeline:update` itself (`timeline::spawn_timeline_listener`),
/// independent of the raw per-sync-batch event list — which is what fixes a
/// relation (edit/reaction/redaction) targeting an already-loaded-but-out-of-
/// batch message being silently dropped instead of updating it in place.
fn emit_room_updates(app: &AppHandle, client: &Client, response: &matrix_sdk::sync::SyncResponse) {
    let own_user_id = client.user_id();
    for (room_id, update) in &response.rooms.joined {
        let mut receipts = Vec::new();
        for raw_event in &update.ephemeral {
            let Ok(event) = raw_event.deserialize() else {
                continue;
            };
            match event {
                matrix_sdk::ruma::events::AnySyncEphemeralRoomEvent::Receipt(receipt_event) => {
                    receipts.extend(ephemeral::receipt_content_to_updates(
                        &receipt_event.content,
                    ));
                }
                matrix_sdk::ruma::events::AnySyncEphemeralRoomEvent::Typing(typing_event) => {
                    let user_ids =
                        ephemeral::typing_content_to_user_ids(&typing_event.content, own_user_id);
                    let _ = app.emit(
                        "typing:update",
                        ephemeral::TypingUpdate {
                            room_id: room_id.to_string(),
                            user_ids,
                        },
                    );
                }
                _ => {}
            }
        }
        if !receipts.is_empty() {
            let _ = app.emit(
                "receipts:update",
                ephemeral::ReceiptUpdate {
                    room_id: room_id.to_string(),
                    receipts,
                },
            );
        }
    }
}

fn spawn_sync_loop(app: AppHandle, client: Client) {
    verification::register_verification_handler(app.clone(), &client);
    presence::register_presence_handler(app.clone(), &client);
    profiles::register_self_profile_handler(app.clone(), &client);

    // Best-effort: some homeservers disable presence entirely, and a failure
    // here shouldn't ever block or fail login/session-restore.
    {
        let client = client.clone();
        tokio::spawn(async move {
            let _ = presence::set_presence_online(&client).await;
        });
    }

    tokio::spawn(async move {
        let _ = app.emit("sync:state", SyncStateEvent::Syncing);

        // Establish initial sync state before entering the long-running loop below.
        let initial_response = match client.sync_once(SyncSettings::default()).await {
            Ok(response) => response,
            Err(e) => {
                let _ = app.emit(
                    "sync:state",
                    SyncStateEvent::Error {
                        message: e.to_string(),
                    },
                );
                return;
            }
        };
        let _ = app.emit("sync:state", SyncStateEvent::Idle);
        {
            let state = app.state::<MatrixState>();
            let media_cache = state.require_media_cache(&app).await.ok();
            let _ = app.emit(
                "room_list:update",
                snapshot_rooms(&client, media_cache).await,
            );
        }
        emit_room_updates(&app, &client, &initial_response);

        // A manual loop, not `sync_with_callback` — that method only honors
        // the `SyncSettings` passed to its *first* call for the whole
        // lifetime of the loop (only `timeout` is adjusted internally after
        // that), so a presence change made mid-session via `set_presence`
        // would otherwise be silently reverted to `Online` on the very next
        // long-poll. `SyncToken::ReusePrevious` (the default) means each
        // `sync_once` still picks up from the client's stored sync token, so
        // this preserves the exact continuation behavior `sync_with_callback`
        // provided — including, for parity, that it does *not* retry a
        // `sync_once` failure at the application level either (it has no
        // callback path for errors; see `Client::sync_with_result_callback`,
        // which just propagates the first `Err` and stops). But relying on
        // that parity alone means a single transient network blip kills sync
        // for the rest of the session, so this loop adds its own bounded
        // retry with backoff on top: consecutive failures back off up to 30s
        // and only give up (matching the old terminal behavior) after
        // `MAX_CONSECUTIVE_SYNC_FAILURES` in a row.
        const MAX_CONSECUTIVE_SYNC_FAILURES: u32 = 10;
        let mut consecutive_failures: u32 = 0;
        loop {
            let presence = *app.state::<MatrixState>().sync_presence.lock().unwrap();
            let settings = SyncSettings::default().set_presence(presence.into());
            match client.sync_once(settings).await {
                Ok(response) => {
                    consecutive_failures = 0;
                    let state = app.state::<MatrixState>();
                    let media_cache = state.require_media_cache(&app).await.ok();
                    let _ = app.emit(
                        "room_list:update",
                        snapshot_rooms(&client, media_cache).await,
                    );
                    emit_room_updates(&app, &client, &response);
                }
                Err(e) => {
                    consecutive_failures += 1;
                    if consecutive_failures >= MAX_CONSECUTIVE_SYNC_FAILURES {
                        let _ = app.emit(
                            "sync:state",
                            SyncStateEvent::Error {
                                message: e.to_string(),
                            },
                        );
                        break;
                    }
                    // Exponential backoff (1s, 2s, 4s, ... capped at 30s) before
                    // retrying, rather than hammering a struggling homeserver.
                    let backoff_secs = 1u64 << (consecutive_failures - 1).min(4);
                    tokio::time::sleep(std::time::Duration::from_secs(backoff_secs.min(30))).await;
                }
            }
        }
    });
}
