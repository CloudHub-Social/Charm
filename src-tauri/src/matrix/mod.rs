pub mod media;
pub mod persistence;
pub mod qr_login;
pub mod send;
pub mod timeline;
pub mod verification;

use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::api::client::account::register;
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, Dummy};
use matrix_sdk::store::RoomLoadSettings;
use matrix_sdk::utils::UrlOrQuery;
use matrix_sdk::{Client, LoopCtrl};
use rand::distr::Alphanumeric;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
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
}

/// Holds the active matrix-rust-sdk client for the running session.
/// One `MatrixState` per app instance; per-account multiplexing is a Phase 1 concern.
#[derive(Default)]
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
    /// Filesystem media cache (`<app_data>/media/`), built once at app
    /// startup and shared across every login/restore — see
    /// `media::MediaCache`. `OnceCell` rather than living inside the client
    /// swap above: the cache directory doesn't depend on which account is
    /// logged in, and outlives any single `Client`.
    pub(crate) media_cache: tokio::sync::OnceCell<media::MediaCache>,
}

impl MatrixState {
    pub(crate) async fn require_client(&self) -> Result<Client, String> {
        self.client
            .lock()
            .await
            .clone()
            .ok_or_else(|| "not logged in".to_string())
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
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomSummary {
    pub room_id: String,
    pub name: Option<String>,
    // u64 serializes to a JS-safe integer here (notification counts are small); emit
    // `number` rather than ts-rs's default `bigint` so the frontend can use it directly.
    #[ts(type = "number")]
    pub unread_count: u64,
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
    let client = build_client(&app, &request.homeserver_url).await?;

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

    // Persist the *resolved* URL (not the raw server-name-or-URL input) so
    // `try_restore_session` doesn't need to re-run discovery on every launch.
    persistence::save_session(client.homeserver().as_ref(), &session)?;
    // Enforces the single-account invariant: only one session kind
    // (password/SSO's MatrixSession vs QR login's OAuthSession) should be
    // present at a time.
    let _ = persistence::clear_oauth_session();

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
    // Password/SSO login (matrix_auth()) and QR login (oauth()) are
    // unrelated session kinds in matrix-sdk, persisted under separate
    // keychain entries — see persistence::SavedOAuthSession. Only one should
    // ever be present at a time for this single-account app, but check both
    // rather than assuming which.
    if let Some(saved) = persistence::load_oauth_session()? {
        return restore_oauth_session(app, state, saved).await;
    }

    let Some(saved) = persistence::load_session()? else {
        return Ok(None);
    };

    let client = build_client(&app, &saved.homeserver_url).await?;

    if client
        .matrix_auth()
        .restore_session(saved.session.clone(), RoomLoadSettings::default())
        .await
        .is_err()
    {
        let _ = persistence::clear_session();
        return Ok(None);
    }

    let response = LoginResponse {
        user_id: saved.session.meta.user_id.to_string(),
        device_id: saved.session.meta.device_id.to_string(),
    };

    *state.client.lock().await = Some(client.clone());
    spawn_sync_loop(app, client);

    Ok(Some(response))
}

async fn restore_oauth_session(
    app: AppHandle,
    state: State<'_, MatrixState>,
    saved: persistence::SavedOAuthSession,
) -> Result<Option<LoginResponse>, String> {
    let homeserver_url = saved.homeserver_url.clone();
    let client = build_client(&app, &homeserver_url).await?;
    let session = saved.into_oauth_session();

    if client
        .oauth()
        .restore_session(session, RoomLoadSettings::default())
        .await
        .is_err()
    {
        let _ = persistence::clear_oauth_session();
        return Ok(None);
    }

    let Some(session_meta) = client.session_meta().cloned() else {
        let _ = persistence::clear_oauth_session();
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
    let _ = persistence::clear_session();

    *state.client.lock().await = Some(client.clone());
    spawn_sync_loop(app, client);

    Ok(Some(response))
}

/// Accepts either a bare server name (`matrix.org`) or a full homeserver URL —
/// `server_name_or_homeserver_url` runs `.well-known/matrix/client` discovery
/// for the former and falls back to treating the input as a URL otherwise.
async fn build_client(app: &AppHandle, homeserver_url: &str) -> Result<Client, String> {
    let store_path = persistence::store_path(app)?;
    let passphrase = persistence::get_or_create_passphrase()?;

    Client::builder()
        .server_name_or_homeserver_url(homeserver_url)
        .sqlite_store(&store_path, Some(&passphrase))
        .build()
        .await
        .map_err(|e| e.to_string())
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
    let client = build_client(&app, &request.homeserver_url).await?;
    register_with_dummy_auth(&client, &request.username, &request.password).await?;

    let session = client
        .matrix_auth()
        .session()
        .ok_or_else(|| "registration succeeded but no session was returned".to_string())?;

    persistence::save_session(client.homeserver().as_ref(), &session)?;
    // Enforces the single-account invariant: only one session kind
    // (password/SSO's MatrixSession vs QR login's OAuthSession) should be
    // present at a time.
    let _ = persistence::clear_oauth_session();

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
    let client = build_client(&app, &homeserver_url).await?;
    let attempt_state = generate_sso_state();
    let sso_url = get_sso_login_url(&client, &attempt_state).await?;

    *state.pending_sso.lock().await = Some(PendingSso {
        client,
        state: attempt_state,
    });

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
pub async fn cancel_sso_login(state: State<'_, MatrixState>) -> Result<(), String> {
    *state.pending_sso.lock().await = None;
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
    let client = pending_sso.take().expect("checked Some above").client;
    drop(pending_sso);

    complete_sso_login_with_callback(&client, &callback_url).await?;

    let session = client
        .matrix_auth()
        .session()
        .ok_or_else(|| "SSO login succeeded but no session was returned".to_string())?;

    persistence::save_session(client.homeserver().as_ref(), &session)?;
    // Enforces the single-account invariant: only one session kind
    // (password/SSO's MatrixSession vs QR login's OAuthSession) should be
    // present at a time.
    let _ = persistence::clear_oauth_session();

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
pub async fn list_rooms(state: State<'_, MatrixState>) -> Result<Vec<RoomSummary>, String> {
    let client = state.require_client().await?;
    Ok(snapshot_rooms(&client))
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

/// Resolves a [`media::MediaHandle`] (opaque, produced by
/// `timeline::events_to_summaries`) to a local cache path, fetching and
/// decrypting on a cache miss. `thumbnail` requests a 256x256 scaled
/// thumbnail instead of the full file — callers pick based on where the
/// media is being rendered (message-list thumbnail vs. lightbox full view).
#[tauri::command]
pub async fn resolve_media(
    app: AppHandle,
    state: State<'_, MatrixState>,
    handle: String,
    thumbnail: bool,
) -> Result<String, String> {
    let client = state.require_client().await?;
    let cache = state.require_media_cache(&app).await?;
    let source = media::handle_to_media_source(&handle)?;

    let kind = if thumbnail {
        media::MediaKind::Thumbnail {
            width: 256,
            height: 256,
        }
    } else {
        media::MediaKind::File
    };

    let path = media::resolve(cache, &client, source, kind).await?;
    Ok(path.to_string_lossy().into_owned())
}

fn snapshot_rooms(client: &Client) -> Vec<RoomSummary> {
    client
        .rooms()
        .into_iter()
        .map(|room| RoomSummary {
            room_id: room.room_id().to_string(),
            name: room.name(),
            unread_count: room.unread_notification_counts().notification_count,
        })
        .collect()
}

fn spawn_sync_loop(app: AppHandle, client: Client) {
    verification::register_verification_handler(app.clone(), &client);

    tokio::spawn(async move {
        let _ = app.emit("sync:state", SyncStateEvent::Syncing);

        // Establish initial sync state before entering the long-running loop below.
        if let Err(e) = client.sync_once(SyncSettings::default()).await {
            let _ = app.emit(
                "sync:state",
                SyncStateEvent::Error {
                    message: e.to_string(),
                },
            );
            return;
        }
        let _ = app.emit("sync:state", SyncStateEvent::Idle);
        let _ = app.emit("room_list:update", snapshot_rooms(&client));

        let result = client
            .sync_with_callback(SyncSettings::default(), |response| {
                let app = app.clone();
                let client = client.clone();
                async move {
                    let _ = app.emit("room_list:update", snapshot_rooms(&client));

                    for (room_id, update) in &response.rooms.joined {
                        let messages = timeline::events_to_summaries(&update.timeline.events);
                        if !messages.is_empty() {
                            let _ = app.emit(
                                "timeline:update",
                                timeline::RoomTimelineUpdate {
                                    room_id: room_id.to_string(),
                                    messages,
                                },
                            );
                        }
                    }

                    LoopCtrl::Continue
                }
            })
            .await;

        if let Err(e) = result {
            let _ = app.emit(
                "sync:state",
                SyncStateEvent::Error {
                    message: e.to_string(),
                },
            );
        }
    });
}
