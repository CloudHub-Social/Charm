//! Authentication and session lifecycle: password login/registration, SSO,
//! and session restore. QR login is its own module (`qr_login`) — its
//! multi-stage device-code flow doesn't fit this file's shape.

use matrix_sdk::encryption::{BackupDownloadStrategy, EncryptionSettings};
use matrix_sdk::ruma::api::client::account::register;
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, Dummy};
use matrix_sdk::store::RoomLoadSettings;
use matrix_sdk::utils::UrlOrQuery;
use matrix_sdk::Client;
use rand::distr::Alphanumeric;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use ts_rs::TS;

use super::{persistence, sync, MatrixState};

/// The `charm://` deep-link the homeserver's SSO flow redirects back to with
/// a `loginToken` query param, picked up by a dedicated `onOpenUrl`
/// deep-link listener in `LoginScreen.tsx` (separate from the
/// room-link-handling one in `src/lib/deepLink.ts`). Each attempt appends
/// its own `state` param (see [`PendingSso`]) so a callback can't be
/// completed against the wrong attempt.
const SSO_REDIRECT_BASE_URL: &str = "charm://sso-callback";

static RESTORE_STORE_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

/// Serializes fresh client restores that open and use the persisted Matrix
/// store before a live app client owns it. App startup and Android's
/// receiver-only push path can otherwise overlap on the same SQLCipher store
/// during the cold-start-to-launch race.
pub(crate) fn restore_store_lock() -> &'static tokio::sync::Mutex<()> {
    RESTORE_STORE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// A client with an SSO login URL in flight but not yet completed, plus the
/// random per-attempt token embedded in that URL's `state` param —
/// `complete_sso_login` checks the callback's `state` against this before
/// exchanging its `loginToken`, so a `charm://sso-callback` deep link
/// belonging to a different (possibly forged, possibly just stale) attempt
/// can't be completed against this one.
pub(crate) struct PendingSso {
    pub(crate) client: Client,
    pub(crate) state: String,
    /// The temp store key `build_client` opened this client's store under —
    /// the account isn't known until the callback completes, so this isn't
    /// an `account_key` yet. `complete_sso_login` relocates it to one on
    /// success; `cancel_sso_login` discards it on cancellation.
    pub(crate) store_key: String,
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
    // `login` is a plain typed command, not a raw `tauri::ipc::Request`, so
    // there's no `sentry-trace` header to continue a frontend trace from
    // (see `observability_trace::traced`'s doc comment). Still gives real
    // server-side duration data in Sentry Performance, which is what
    // motivated this: `POST /api/auth/login` showed a p75 of ~84s in the web
    // build's traces, with nothing on the Tauri side to compare it against.
    crate::observability_trace::traced("login", "matrix.auth", async move {
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

        // Held for the rest of this function: serializes stopping the previous
        // sync loop/client, relocating the store, saving the session, and
        // adopting the new client against any *other* interactive login
        // completing for this same account at the same time — see
        // `MatrixState::login_completion_lock`'s doc comment for why a narrower
        // lock (or none) lets one completion's cleanup clobber another's
        // already-adopted client.
        let _completion_guard = state.login_completion_lock.lock().await;

        // Captured before tearing anything down: if this attempt's relocation
        // fails below, whatever was already working gets restored rather than
        // left logged out over a failure unrelated to that previous session
        // (e.g. a transient keychain error relocating *this* login's store).
        let previous_client = state.client.lock().await.clone();

        // Stop any sync loop already running for this account *before*
        // relocating its store — otherwise a live client from an earlier login
        // (e.g. a double-submitted login button) could still be mid-`/sync` and
        // writing to the directory this is about to rename out from under it.
        sync::abort_current_sync_loop(&app).await;
        if let Err(e) = persistence::relocate_store_and_save_session(
            &app,
            &temp_key,
            &account_key,
            &homeserver_url,
            &session,
        ) {
            // Only resume `previous_client` if relocation's own rollback left
            // the account's on-disk store consistent with it — otherwise doing
            // so would paper over a half-restored store neither this client nor
            // anything else can reliably decrypt. See `RelocationFailure`'s doc
            // comment.
            if e.safe_to_resume_previous {
                if let Some(previous_client) = previous_client {
                    *state.client.lock().await = Some(previous_client.clone());
                    sync::spawn_sync_task(app, previous_client);
                }
            }
            return Err(e.into());
        }

        // With `login_completion_lock` held for the whole sequence, no other
        // completion for this account can run concurrently — so this should
        // always hold. Kept as a cheap defense-in-depth assertion rather than
        // load-bearing synchronization (which is now `login_completion_lock`'s
        // job): if it ever *did* somehow fail, the fallback is the same as
        // before — report the loss rather than a losing `Ok`, since
        // `LoginScreen` treats any `Ok` response as signed-in-and-adopted.
        if !persistence::session_is_current(&account_key, session.meta.device_id.as_str()) {
            // See the identical restore-on-failure step above this check: this
            // is the same "don't leave a working session logged out over this
            // completion's own failure" rationale, just for the later failure
            // point rather than the relocation itself.
            if let Some(previous_client) = previous_client {
                *state.client.lock().await = Some(previous_client.clone());
                sync::spawn_sync_task(app, previous_client);
            }
            return Err(
                "login succeeded but was superseded by a concurrent login for the same account"
                    .to_string(),
            );
        }
        // Enforces the single-account invariant: only one session kind
        // (password/SSO's MatrixSession vs QR login's OAuthSession) should be
        // present at a time.
        let _ = persistence::clear_oauth_session(&account_key);

        let response = LoginResponse {
            user_id: session.meta.user_id.to_string(),
            device_id: session.meta.device_id.to_string(),
        };

        *state.client.lock().await = Some(client.clone());
        sync::spawn_sync_loop(app, client);

        Ok(response)
    })
    .await
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
    // Held for the whole restore attempt: without this, a startup restore
    // building a client against `account_key`'s store could overlap an
    // interactive login relocating that same store — on Windows this can
    // make the relocation's rename fail (this restore's client still has
    // the store open), and either platform could end up publishing a
    // client backed by a store that's since been superseded. See
    // `MatrixState::login_completion_lock`'s doc comment.
    let _completion_guard = state.login_completion_lock.lock().await;
    let _restore_store_guard = restore_store_lock().lock().await;

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
            // Deliberately *not* `continue` here: an OAuth session that
            // exists but didn't yield a live restore isn't proof this
            // account has no restorable session at all — a crash between a
            // password/SSO login's store-swap commit and its follow-up
            // `clear_oauth_session` call can leave a stale OAuth entry
            // sitting alongside a perfectly valid, freshly-committed Matrix
            // session for this same account. Fall through to check that
            // before moving on to the next account.
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
        sync::spawn_sync_loop(app.clone(), client);

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
    sync::spawn_sync_loop(app.clone(), client);

    Ok(Some(response))
}

/// Headlessly builds and restores a client for `account_key` — no
/// `MatrixState` mutation, no sync loop spawned, unlike `try_restore_session`
/// (which drives the interactive app-startup restore and needs both). Used by
/// Spec 11's push-decrypt pipeline (`push::handle_push`), which only needs a
/// client long enough to fetch and decrypt one event.
///
/// Tries both session kinds the same way `try_restore_session`'s per-account
/// loop does (password/SSO's `MatrixSession` vs QR login's `OAuthSession` —
/// see `persistence::SavedOAuthSession`'s doc comment for why they're
/// unrelated types here), returning `None` (not an error) if this account has
/// no saved session or a saved one that no longer restores.
/// Caller must hold `MatrixState::login_completion_lock` for as long as the
/// returned `Client` stays in use, not just for this call — building it
/// against `account_key`'s store only needs protection from a concurrent
/// interactive login relocating that store *while this function runs*; the
/// caller's own subsequent use of the client (fetching/decrypting a room
/// event) is exactly the same open-handle hazard and needs the same lock
/// held across it. This function doesn't acquire the lock itself for that
/// reason — doing so here and releasing it on return would protect the
/// build but not the use, and a non-reentrant `tokio::sync::Mutex` means
/// the caller holding its own guard across this call would deadlock if this
/// function tried to acquire the same lock again.
pub(crate) async fn restore_session_for_push(
    app: &AppHandle,
    account_key: &str,
) -> Result<Option<Client>, String> {
    restore_session_for_push_at(
        &persistence::matrix_store_root_at(&app.path().app_data_dir().map_err(|e| e.to_string())?)?,
        account_key,
    )
    .await
}

/// AppHandle-free counterpart to [`restore_session_for_push`], used by
/// Android's cold-start push receiver where Tauri setup never ran.
pub(crate) async fn restore_session_for_push_at(
    store_root: &std::path::Path,
    account_key: &str,
) -> Result<Option<Client>, String> {
    if let Some(saved) = persistence::load_oauth_session(account_key)? {
        let client =
            build_persisted_client_at(store_root, &saved.homeserver_url, account_key).await?;
        let session = saved.into_oauth_session();
        if client
            .oauth()
            .restore_session(session, RoomLoadSettings::default())
            .await
            .is_ok()
        {
            return Ok(Some(client));
        }
        // Deliberately not returning here: see `try_restore_session`'s
        // identical fall-through for why a stale OAuth entry that fails to
        // restore isn't proof this account has no restorable session —
        // fall through to check the Matrix session too.
    }

    let Some(saved) = persistence::load_session(account_key)? else {
        return Ok(None);
    };
    let client = build_persisted_client_at(store_root, &saved.homeserver_url, account_key).await?;
    if client
        .matrix_auth()
        .restore_session(saved.session, RoomLoadSettings::default())
        .await
        .is_err()
    {
        return Ok(None);
    }
    Ok(Some(client))
}

/// Accepts either a bare server name (`matrix.org`) or a full homeserver URL —
/// `server_name_or_homeserver_url` runs `.well-known/matrix/client` discovery
/// for the former and falls back to treating the input as a URL otherwise.
pub(crate) async fn build_client(
    app: &AppHandle,
    homeserver_url: &str,
    store_key: &str,
) -> Result<Client, String> {
    let store_root =
        persistence::matrix_store_root_at(&app.path().app_data_dir().map_err(|e| e.to_string())?)?;
    build_client_at(&store_root, homeserver_url, store_key).await
}

/// Encryption behavior shared by every live desktop and web client.
///
/// Missing Megolm sessions are fetched from server-side key backup only after
/// decryption fails. This keeps recovery useful without the unbounded all-key
/// download performed by [`BackupDownloadStrategy::OneShot`].
pub fn client_encryption_settings() -> EncryptionSettings {
    EncryptionSettings {
        backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
        ..Default::default()
    }
}

pub(crate) async fn build_client_at(
    store_root: &std::path::Path,
    homeserver_url: &str,
    store_key: &str,
) -> Result<Client, String> {
    let store_path = persistence::store_path_at(store_root, store_key)?;
    let passphrase = persistence::get_or_create_passphrase(store_key)?;

    build_client_with_store_passphrase(homeserver_url, &store_path, &passphrase).await
}

async fn build_persisted_client_at(
    store_root: &std::path::Path,
    homeserver_url: &str,
    store_key: &str,
) -> Result<Client, String> {
    let store_path = persistence::store_path_at(store_root, store_key)?;
    let passphrase = persistence::get_or_create_passphrase(store_key)?;

    build_persisted_client_with_store_passphrase(homeserver_url, &store_path, &passphrase).await
}

pub(crate) async fn build_client_with_store_passphrase(
    homeserver_url: &str,
    store_path: &std::path::Path,
    passphrase: &str,
) -> Result<Client, String> {
    Client::builder()
        .server_name_or_homeserver_url(homeserver_url)
        .with_encryption_settings(client_encryption_settings())
        .sqlite_store(store_path, Some(passphrase))
        .build()
        .await
        .map_err(|e| e.to_string())
}

pub(crate) async fn build_persisted_client_with_store_passphrase(
    homeserver_url: &str,
    store_path: &std::path::Path,
    passphrase: &str,
) -> Result<Client, String> {
    Client::builder()
        .homeserver_url(homeserver_url)
        .with_encryption_settings(client_encryption_settings())
        .sqlite_store(store_path, Some(passphrase))
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
/// `tests/`, same rationale as [`super::resolve_alias`].
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

    // See `login`'s identical guard and its doc comment on
    // `MatrixState::login_completion_lock`.
    let _completion_guard = state.login_completion_lock.lock().await;

    // See `login`'s identical capture-and-restore-on-failure rationale.
    let previous_client = state.client.lock().await.clone();

    // See `login`'s identical step: stop any sync loop already running for
    // this account before its store gets relocated out from under it.
    sync::abort_current_sync_loop(&app).await;
    if let Err(e) = persistence::relocate_store_and_save_session(
        &app,
        &temp_key,
        &account_key,
        &homeserver_url,
        &session,
    ) {
        // See `login`'s identical safe_to_resume_previous check.
        if e.safe_to_resume_previous {
            if let Some(previous_client) = previous_client {
                *state.client.lock().await = Some(previous_client.clone());
                sync::spawn_sync_task(app, previous_client);
            }
        }
        return Err(e.into());
    }

    // See `login`'s identical check and rationale for returning `Err` rather
    // than a losing `Ok` response: with `login_completion_lock` held for the
    // whole sequence this should always hold, kept as defense-in-depth.
    if !persistence::session_is_current(&account_key, session.meta.device_id.as_str()) {
        // See `login`'s identical restore-on-failure step.
        if let Some(previous_client) = previous_client {
            *state.client.lock().await = Some(previous_client.clone());
            sync::spawn_sync_task(app, previous_client);
        }
        return Err(
            "registration succeeded but was superseded by a concurrent login for the same account"
                .to_string(),
        );
    }
    // Enforces the single-account invariant: only one session kind
    // (password/SSO's MatrixSession vs QR login's OAuthSession) should be
    // present at a time.
    let _ = persistence::clear_oauth_session(&account_key);

    let response = LoginResponse {
        user_id: session.meta.user_id.to_string(),
        device_id: session.meta.device_id.to_string(),
    };

    *state.client.lock().await = Some(client.clone());
    sync::spawn_sync_loop(app, client);

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
/// `tests/`, same rationale as [`super::resolve_alias`].
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
/// `tests/`, same rationale as [`super::resolve_alias`].
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

#[cfg(test)]
mod encryption_settings_tests {
    use matrix_sdk::encryption::BackupDownloadStrategy;

    use super::client_encryption_settings;

    #[test]
    fn missing_room_keys_are_downloaded_after_decryption_failure() {
        assert_eq!(
            client_encryption_settings().backup_download_strategy,
            BackupDownloadStrategy::AfterDecryptionFailure
        );
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

    // See `login`'s identical guard and its doc comment on
    // `MatrixState::login_completion_lock`. Safe to acquire here: the
    // `pending_sso` lock taken earlier in this function was already
    // `drop`-ped before this point.
    let _completion_guard = state.login_completion_lock.lock().await;

    // See `login`'s identical capture-and-restore-on-failure rationale.
    let previous_client = state.client.lock().await.clone();

    // See `login`'s identical step: stop any sync loop already running for
    // this account before its store gets relocated out from under it.
    sync::abort_current_sync_loop(&app).await;
    if let Err(e) = persistence::relocate_store_and_save_session(
        &app,
        &pending.store_key,
        &account_key,
        &homeserver_url,
        &session,
    ) {
        // See `login`'s identical safe_to_resume_previous check.
        if e.safe_to_resume_previous {
            if let Some(previous_client) = previous_client {
                *state.client.lock().await = Some(previous_client.clone());
                sync::spawn_sync_task(app, previous_client);
            }
        }
        return Err(e.into());
    }

    // See `login`'s identical check and rationale for returning `Err` rather
    // than a losing `Ok` response: with `login_completion_lock` held for the
    // whole sequence this should always hold, kept as defense-in-depth.
    if !persistence::session_is_current(&account_key, session.meta.device_id.as_str()) {
        // See `login`'s identical restore-on-failure step.
        if let Some(previous_client) = previous_client {
            *state.client.lock().await = Some(previous_client.clone());
            sync::spawn_sync_task(app, previous_client);
        }
        return Err(
            "SSO login succeeded but was superseded by a concurrent login for the same account"
                .to_string(),
        );
    }
    // Enforces the single-account invariant: only one session kind
    // (password/SSO's MatrixSession vs QR login's OAuthSession) should be
    // present at a time.
    let _ = persistence::clear_oauth_session(&account_key);

    let response = LoginResponse {
        user_id: session.meta.user_id.to_string(),
        device_id: session.meta.device_id.to_string(),
    };

    *state.client.lock().await = Some(client.clone());
    sync::spawn_sync_loop(app, client);

    Ok(response)
}

/// Exchanges the `loginToken` in `callback_url` for a real session on
/// `client`, leaving it set on the client (same effect as a successful
/// login).
///
/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/`, same rationale as [`super::resolve_alias`].
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
