pub mod persistence;
pub mod send;
pub mod timeline;
pub mod verification;

use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::api::client::account::register;
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, Dummy};
use matrix_sdk::store::RoomLoadSettings;
use matrix_sdk::utils::UrlOrQuery;
use matrix_sdk::{Client, LoopCtrl};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use ts_rs::TS;

/// The `charm://` deep-link the homeserver's SSO flow redirects back to with
/// a `loginToken` query param, picked up by a dedicated `onOpenUrl`
/// deep-link listener in `LoginScreen.tsx` (separate from the
/// room-link-handling one in `src/lib/deepLink.ts`).
const SSO_REDIRECT_URL: &str = "charm://sso-callback";

/// Holds the active matrix-rust-sdk client for the running session.
/// One `MatrixState` per app instance; per-account multiplexing is a Phase 1 concern.
#[derive(Default)]
pub struct MatrixState {
    client: Mutex<Option<Client>>,
    /// A client that has an SSO login URL in flight but hasn't completed
    /// login yet — set by `start_sso_login`, consumed by
    /// `complete_sso_login`. Built once and carried across the two calls
    /// (rather than rebuilt in `complete_sso_login`) so it keeps whatever
    /// `.well-known` discovery result and homeserver connection
    /// `start_sso_login` already resolved.
    pending_sso_client: Mutex<Option<Client>>,
}

impl MatrixState {
    pub(crate) async fn require_client(&self) -> Result<Client, String> {
        self.client
            .lock()
            .await
            .clone()
            .ok_or_else(|| "not logged in".to_string())
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
/// the URL to open in the system browser. The client is held in
/// [`MatrixState::pending_sso_client`] until [`complete_sso_login`] finishes
/// the flow with the `loginToken` the homeserver redirects back with.
#[tauri::command]
pub async fn start_sso_login(
    app: AppHandle,
    state: State<'_, MatrixState>,
    homeserver_url: String,
) -> Result<String, String> {
    let client = build_client(&app, &homeserver_url).await?;
    let sso_url = get_sso_login_url(&client).await?;

    *state.pending_sso_client.lock().await = Some(client);

    Ok(sso_url)
}

/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/`, same rationale as [`resolve_alias`].
pub async fn get_sso_login_url(client: &Client) -> Result<String, String> {
    client
        .matrix_auth()
        .get_sso_login_url(SSO_REDIRECT_URL, None)
        .await
        .map_err(|e| e.to_string())
}

/// Completes an SSO login started by [`start_sso_login`], given the full
/// `charm://sso-callback?loginToken=...` URL the homeserver redirected the
/// system browser to.
#[tauri::command]
pub async fn complete_sso_login(
    app: AppHandle,
    state: State<'_, MatrixState>,
    callback_url: String,
) -> Result<LoginResponse, String> {
    let client = state
        .pending_sso_client
        .lock()
        .await
        .take()
        .ok_or_else(|| "no SSO login is in progress".to_string())?;

    complete_sso_login_with_callback(&client, &callback_url).await?;

    let session = client
        .matrix_auth()
        .session()
        .ok_or_else(|| "SSO login succeeded but no session was returned".to_string())?;

    persistence::save_session(client.homeserver().as_ref(), &session)?;

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
