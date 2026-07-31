//! Authentication and session lifecycle: password login/registration, SSO,
//! and session restore. QR login is its own module (`qr_login`) — its
//! multi-stage device-code flow doesn't fit this file's shape.

use matrix_sdk::config::RequestConfig;
use matrix_sdk::encryption::{BackupDownloadStrategy, EncryptionSettings};
use matrix_sdk::ruma::api::client::account::{
    change_password, register, request_password_change_token_via_email,
    request_registration_token_via_email,
};
use matrix_sdk::ruma::api::client::session::get_login_types::v3::LoginType;
use matrix_sdk::ruma::api::client::uiaa::{
    AuthData, AuthType, Dummy, EmailIdentity, LoginTermsParams, Terms, ThirdpartyIdCredentials,
    UiaaInfo,
};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::{ClientSecret, UInt};
use matrix_sdk::store::RoomLoadSettings;
use matrix_sdk::utils::UrlOrQuery;
use matrix_sdk::Client;
use rand::distr::Alphanumeric;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use std::hash::{BuildHasher, Hasher};
use tauri::{AppHandle, Manager, State};
use ts_rs::TS;

use super::{persistence, sync, MatrixState, ReservedTempStoreGuard};

/// The `charm://` deep-link the homeserver's SSO flow redirects back to with
/// a `loginToken` query param, picked up by a dedicated `onOpenUrl`
/// deep-link listener in `LoginScreen.tsx` (separate from the
/// room-link-handling one in `src/lib/deepLink.ts`). Each attempt appends
/// its own `state` param (see [`PendingSso`]) so a callback can't be
/// completed against the wrong attempt.
const SSO_REDIRECT_BASE_URL: &str = "charm://sso-callback";

static RESTORE_STORE_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
static AUTH_MAIL_ADDRESS_HASHER: std::sync::OnceLock<std::collections::hash_map::RandomState> =
    std::sync::OnceLock::new();

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

#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RegisterRequest {
    /// Same flexible server-name-or-URL input as [`LoginRequest::homeserver_url`].
    pub homeserver_url: String,
    pub username: String,
    pub password: String,
}

const REGISTRATION_ATTEMPT_TTL: std::time::Duration = std::time::Duration::from_secs(20 * 60);
const REGISTRATION_EMAIL_RESEND_DELAY: std::time::Duration = std::time::Duration::from_secs(30);
const REGISTRATION_EMAIL_MAX_SEND_ATTEMPTS: u32 = 3;
const PASSWORD_RESET_ATTEMPT_TTL: std::time::Duration = std::time::Duration::from_secs(20 * 60);
const AUTH_MAIL_QUOTA_WINDOW: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const AUTH_MAILS_PER_ADDRESS: usize = 3;
const AUTH_MAILS_PER_PROCESS: usize = 12;
const AUTH_NETWORK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

pub(crate) struct PendingRegistration {
    pub(crate) client: Client,
    pub(crate) store_key: String,
    request: RegisterRequest,
    attempt_id: String,
    uiaa: UiaaInfo,
    email_validation: Option<PendingRegistrationEmail>,
    email_client_secret: Option<matrix_sdk::ruma::OwnedClientSecret>,
    email_address_key: Option<String>,
    email_send_attempt: u32,
    email_retry_not_before: Option<std::time::Instant>,
    created_at: std::time::Instant,
}

struct PendingRegistrationEmail {
    client_secret: matrix_sdk::ruma::OwnedClientSecret,
    sid: matrix_sdk::ruma::OwnedSessionId,
    submit_url: Option<url::Url>,
    homeserver: url::Url,
    submitted: bool,
}

pub(crate) struct PendingPasswordReset {
    client: Client,
    client_secret: matrix_sdk::ruma::OwnedClientSecret,
    sid: matrix_sdk::ruma::OwnedSessionId,
    submit_url: Option<url::Url>,
    token_submitted: bool,
    attempt_id: String,
    created_at: std::time::Instant,
}

#[derive(Default)]
pub(crate) struct AuthMailQuota {
    by_address: std::collections::HashMap<String, Vec<std::time::Instant>>,
    all: Vec<std::time::Instant>,
    upstream_retry_until_by_homeserver: std::collections::HashMap<String, std::time::Instant>,
}

#[derive(Clone)]
struct AuthMailQuotaReservation {
    address_digest: String,
    at: std::time::Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RegistrationFlow {
    pub stages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RegistrationPolicy {
    pub id: String,
    pub version: String,
    pub language: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RegistrationStep {
    Challenge {
        attempt_id: String,
        completed: Vec<String>,
        flows: Vec<RegistrationFlow>,
        next_stage: String,
        fallback_url: String,
        policies: Vec<RegistrationPolicy>,
    },
    Complete {
        session: LoginResponse,
    },
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RegistrationAuthResponse {
    AcceptTerms,
    CompleteDummy,
    CompleteEmail { token: Option<String> },
    AcknowledgeFallback { stage: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RegistrationEmailChallenge {
    pub requires_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct LoginIdentityProvider {
    pub id: String,
    pub name: String,
    pub brand: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct LoginFlowSummary {
    pub password: bool,
    pub token: bool,
    pub sso: bool,
    pub identity_providers: Vec<LoginIdentityProvider>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct PasswordResetChallenge {
    pub attempt_id: String,
    pub requires_token: bool,
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
        // Held for this whole closure, not just around `relocate_store_and_
        // save_session` further down (Codex review on #288, P1): the startup
        // orphan-temp-store sweep (`lib.rs`'s `.setup()`) now runs as a
        // spawned background task rather than blocking window creation, so
        // it can still be mid-`sweep_orphan_temp_stores` when this command's
        // temp store gets created below — without serializing against it for
        // the *entire* window this store exists unprotected (creation
        // through relocation), the sweep's single-pass `read_dir` could
        // still observe and delete this login's brand-new `tmp-*` directory
        // sometime after creation but before it's relocated to a permanent
        // account-key path, since the sweep has no way to distinguish
        // "orphaned by a crash" from "a login in progress right now." The
        // previous synchronous-setup path couldn't race a UI-initiated login
        // by construction (the window wasn't interactive yet); this restores
        // that same guarantee for the async path.
        cancel_pending_registration_for_superseding_auth(&app, &state).await;
        let _restore_store_guard = restore_store_lock().lock().await;

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
    // Must happen *before* taking `restore_store_lock` below, not after:
    // the background startup sweep takes that same lock for its own
    // duration, so waiting on the sweep while already holding it would
    // deadlock the two against each other. Bounded — see
    // `wait_for_startup_sweep`'s doc comment (Codex review on #288, P1):
    // `known_account_keys` below skips a not-yet-recovered stale-backup
    // directory entirely, so this restore could otherwise run ahead of the
    // sweep's recovery pass and wrongly treat a perfectly restorable
    // account as having no store at all. 30s, not a tighter bound: the
    // frontend calls this exactly once at startup (`App.tsx`), with no
    // retry if it times out — a slow disk or an install with many
    // stranded temp stores taking longer than a short bound would
    // otherwise show a real, restorable session as logged out (Codex
    // review on #288, P2). The bound exists only to protect against the
    // sweep task panicking outright (its only other way to never signal
    // completion), not to cap ordinary slowness.
    persistence::wait_for_startup_sweep(std::time::Duration::from_secs(30)).await;

    // Held for the whole restore attempt: without this, a startup restore
    // building a client against `account_key`'s store could overlap an
    // interactive login relocating that same store — on Windows this can
    // make the relocation's rename fail (this restore's client still has
    // the store open), and either platform could end up publishing a
    // client backed by a store that's since been superseded. See
    // `MatrixState::login_completion_lock`'s doc comment.
    //
    // Acquired in this order — `restore_store_lock` before
    // `login_completion_lock` — to match `login`/`register`/`handle_push`:
    // `login`/`register` hold `restore_store_lock` from before the
    // account's MXID is even known through the whole homeserver round trip,
    // only taking `login_completion_lock` afterward. Taking these two in
    // the reverse order here would be the identical ABBA deadlock already
    // fixed between `login`/`register` and `handle_push` (Codex review on
    // #288, P1) — a login in flight holding `restore_store_lock` while
    // waiting on `login_completion_lock`, racing this restore holding
    // `login_completion_lock` while waiting on `restore_store_lock`.
    let _restore_store_guard = restore_store_lock().lock().await;
    let _completion_guard = state.login_completion_lock.lock().await;

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
    let homeserver_url = tokio::time::timeout(AUTH_NETWORK_TIMEOUT, discover(&input))
        .await
        .map_err(|_| "homeserver discovery timed out".to_string())??;
    Ok(DiscoverHomeserverResponse { homeserver_url })
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
    // Same rationale as `login`'s identical guard (Codex review on #288,
    // P1): held for this whole function so the startup orphan-temp-store
    // sweep can't delete this registration's temp store out from under it
    // between creation and relocation.
    cancel_pending_registration_for_superseding_auth(&app, &state).await;
    let _restore_store_guard = restore_store_lock().lock().await;

    // Same rationale as `login`: the account isn't certain until
    // registration succeeds, so this opens a temp store and relocates it.
    let temp_key = persistence::temp_store_key();
    let client = build_client(&app, &request.homeserver_url, &temp_key).await?;
    register_with_dummy_auth(&client, &request.username, &request.password).await?;

    finish_registration(app, &state, client, temp_key, None, None, None).await
}

async fn finish_registration(
    app: AppHandle,
    state: &MatrixState,
    client: Client,
    temp_key: String,
    attempt_id: Option<&str>,
    cancellation: Option<&tokio_util::sync::CancellationToken>,
    deadline: Option<tokio::time::Instant>,
) -> Result<LoginResponse, String> {
    let session = client
        .matrix_auth()
        .session()
        .ok_or_else(|| "registration succeeded but no session was returned".to_string())?;
    let account_key = persistence::account_key(session.meta.user_id.as_str());
    let homeserver_url = client.homeserver().to_string();

    // See `login`'s identical guard and its doc comment on
    // `MatrixState::login_completion_lock`.
    let _completion_guard = match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, state.login_completion_lock.lock())
            .await
            .map_err(|_| "authentication setup timed out".to_string())?,
        None => state.login_completion_lock.lock().await,
    };
    if cancellation.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
        return Err("registration cancelled".to_string());
    }

    // See `login`'s identical capture-and-restore-on-failure rationale.
    let previous_client = state.client.lock().await.clone();

    // See `login`'s identical step: stop any sync loop already running for
    // this account before its store gets relocated out from under it.
    sync::abort_current_sync_loop(&app).await;
    if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
        drop(client);
        let _ = persistence::discard_temp_login_store(&app, &temp_key);
        return Err("authentication setup timed out".to_string());
    }
    let _finalizing = FinalizingRegistrationGuard::new(state, account_key.clone());
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
    if cancellation.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
        // Relocation has already made this session durable. A cancellation
        // response is only truthful if we also remove that durable session;
        // otherwise startup can restore an account the user explicitly
        // cancelled. Retry once for transient keychain failures and surface
        // any remaining cleanup failure instead of silently claiming success.
        if let Some(previous_client) = previous_client {
            *state.client.lock().await = Some(previous_client.clone());
            sync::spawn_sync_task(app.clone(), previous_client);
        }
        drop(client);
        return clear_cancelled_registration_session(&app, &account_key);
    }
    if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
        if let Some(previous_client) = previous_client {
            *state.client.lock().await = Some(previous_client.clone());
            sync::spawn_sync_task(app.clone(), previous_client);
        }
        drop(client);
        clear_cancelled_registration_session(&app, &account_key)?;
        return Err("authentication setup timed out".to_string());
    }

    // See `login`'s identical check and rationale for returning `Err` rather
    // than a losing `Ok` response: with `login_completion_lock` held for the
    // whole sequence this should always hold, kept as defense-in-depth.
    if !persistence::session_is_current(&account_key, session.meta.device_id.as_str()) {
        // See `login`'s identical restore-on-failure step.
        if let Some(previous_client) = previous_client {
            *state.client.lock().await = Some(previous_client.clone());
            sync::spawn_sync_task(app.clone(), previous_client);
        }
        // The temp store has already been relocated by this point. The
        // completion lock prevents another interactive login from installing
        // a replacement store concurrently, so leaving this unadopted store
        // behind would strand both the directory and its keychain entry.
        drop(client);
        persistence::discard_cancelled_account_session(&app, &account_key).map_err(|error| {
            format!(
                "registration was superseded, but its relocated store could not be removed: {error}"
            )
        })?;
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

    let mut client_slot = state.client.lock().await;
    if let Some(cancellation) = cancellation {
        let completion_won = {
            let mut cancellation_slot = state
                .pending_registration_cancel
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let is_current = cancellation_slot
                .as_ref()
                .is_some_and(|(current_id, current)| {
                    attempt_id.is_some_and(|attempt_id| current_id == attempt_id)
                        && !current.is_cancelled()
                        && !cancellation.is_cancelled()
                });
            if is_current {
                cancellation_slot.take();
            }
            is_current
        };
        if !completion_won {
            drop(client_slot);
            if let Some(previous_client) = previous_client {
                *state.client.lock().await = Some(previous_client.clone());
                sync::spawn_sync_task(app.clone(), previous_client);
            }
            drop(client);
            return clear_cancelled_registration_session(&app, &account_key);
        }
        // This is the completion/cancellation linearization point. A cancel
        // that acquired the slot first wins above; after this removal the
        // authenticated client is committed while its slot remains locked,
        // so completion wins.
    }
    *client_slot = Some(client.clone());
    drop(client_slot);
    sync::spawn_sync_loop(app, client);

    Ok(response)
}

fn clear_cancelled_registration_session(
    app: &AppHandle,
    account_key: &str,
) -> Result<LoginResponse, String> {
    let cleanup = match persistence::discard_cancelled_account_session(app, account_key) {
        Ok(()) => Ok(()),
        Err(_) => persistence::discard_cancelled_account_session(app, account_key),
    };
    if let Err(error) = cleanup {
        return Err(format!(
            "registration cancelled, but its durable state could not be removed: {error}"
        ));
    }
    Err("registration cancelled".to_string())
}

/// Starts a registration UIA attempt without exposing its client, credentials,
/// or encrypted temporary-store key across IPC.
#[tauri::command]
pub async fn begin_registration(
    app: AppHandle,
    state: State<'_, MatrixState>,
    request: RegisterRequest,
) -> Result<RegistrationStep, String> {
    ensure_registration_feature_enabled(&app)?;
    cancel_pending_registration_for_superseding_auth(&app, &state).await;
    let _restore_store_guard = restore_store_lock().lock().await;
    let attempt_id = generate_attempt_id();
    let started_at = std::time::Instant::now();
    let cancellation = tokio_util::sync::CancellationToken::new();
    state
        .pending_registration_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .replace((attempt_id.clone(), cancellation.clone()));
    spawn_registration_expiry(app.clone(), attempt_id.clone(), cancellation.clone());

    let store_key = persistence::temp_store_key();
    let reservation = ReservedTempStoreGuard::new(&state, store_key.clone());
    let client = tokio::select! {
        result = build_client(&app, &request.homeserver_url, &store_key) => {
            match result {
                Ok(client) => client,
                Err(error) => {
                    clear_registration_cancellation(&state, &attempt_id);
                    let _ = persistence::discard_temp_login_store(&app, &store_key);
                    return Err(error);
                }
            }
        }
        () = cancellation.cancelled() => {
            clear_registration_cancellation(&state, &attempt_id);
            let _ = persistence::discard_temp_login_store(&app, &store_key);
            return Err("registration cancelled".to_string());
        }
    };
    let register_request = registration_request(&request, None);

    let matrix_auth = client.matrix_auth();
    let registration_result = tokio::select! {
        result = matrix_auth.register(register_request) => result,
        () = cancellation.cancelled() => {
            drop(client);
            clear_registration_cancellation(&state, &attempt_id);
            let _ = persistence::discard_temp_login_store(&app, &store_key);
            return Err("registration cancelled".to_string());
        }
    };

    match registration_result {
        Ok(_) => {
            let cleanup_key = store_key.clone();
            match finish_registration(
                app.clone(),
                &state,
                client,
                store_key,
                Some(&attempt_id),
                Some(&cancellation),
                None,
            )
            .await
            {
                Ok(session) => {
                    clear_registration_cancellation(&state, &attempt_id);
                    Ok(RegistrationStep::Complete { session })
                }
                Err(error) => {
                    clear_registration_cancellation(&state, &attempt_id);
                    let _ = persistence::discard_temp_login_store(&app, &cleanup_key);
                    Err(error)
                }
            }
        }
        Err(error) => {
            let Some(uiaa) = error.as_uiaa_response().cloned() else {
                drop(client);
                clear_registration_cancellation(&state, &attempt_id);
                let _ = persistence::discard_temp_login_store(&app, &store_key);
                return Err(safe_registration_error(&error));
            };
            let step = match registration_challenge(&attempt_id, &client, &uiaa) {
                Ok(step) => step,
                Err(error) => {
                    drop(client);
                    clear_registration_cancellation(&state, &attempt_id);
                    let _ = persistence::discard_temp_login_store(&app, &store_key);
                    return Err(error);
                }
            };
            let pending = PendingRegistration {
                client,
                store_key,
                request,
                attempt_id: attempt_id.clone(),
                uiaa,
                email_validation: None,
                email_client_secret: None,
                email_address_key: None,
                email_send_attempt: 0,
                email_retry_not_before: None,
                created_at: started_at,
            };
            if !restore_or_discard_pending_registration(
                &app,
                &state,
                &attempt_id,
                &cancellation,
                pending,
            )
            .await
            {
                return Err("registration cancelled".to_string());
            }
            reservation.defuse();
            Ok(step)
        }
    }
}

/// Starts the email-validation sub-flow for the active registration attempt.
/// The homeserver `sid` and client secret remain backend-owned; the frontend
/// only learns whether it must prompt for a token.
#[tauri::command]
pub async fn request_registration_email(
    app: AppHandle,
    state: State<'_, MatrixState>,
    attempt_id: String,
    email: String,
) -> Result<RegistrationEmailChallenge, String> {
    if let Err(error) = ensure_registration_feature_enabled(&app) {
        let cancellation = state
            .pending_registration_cancel
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|(current_id, _)| current_id == &attempt_id)
            .map(|(_, cancellation)| cancellation.clone());
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
            clear_registration_cancellation(&state, &attempt_id);
        }
        let mut guard = state.pending_registration.lock().await;
        let discarded = if guard
            .as_ref()
            .is_some_and(|pending| pending.attempt_id == attempt_id)
        {
            guard.take()
        } else {
            None
        };
        drop(guard);
        if let Some(discarded) = discarded {
            discard_pending_registration(&app, discarded);
        }
        return Err(error);
    }
    let cancellation = state
        .pending_registration_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .filter(|(current_id, _)| current_id == &attempt_id)
        .map(|(_, cancellation)| cancellation.clone())
        .ok_or_else(|| "registration attempt is no longer current".to_string())?;
    let mut guard = state.pending_registration.lock().await;
    let Some(current) = guard.as_ref() else {
        return Err("no registration is in progress".to_string());
    };
    if current.attempt_id != attempt_id {
        return Err("registration attempt is no longer current".to_string());
    }
    if current.created_at.elapsed() > REGISTRATION_ATTEMPT_TTL {
        let expired = guard.take().expect("pending attempt checked above");
        drop(guard);
        cancellation.cancel();
        clear_registration_cancellation(&state, &attempt_id);
        discard_pending_registration(&app, expired);
        return Err("registration attempt expired; start again".to_string());
    }
    if next_registration_stage(&current.uiaa)? != AuthType::EmailIdentity.as_str() {
        return Err("registration email is not the current authentication stage".to_string());
    }
    let reservation = ReservedTempStoreGuard::new(&state, current.store_key.clone());
    let mut pending = guard.take().expect("pending attempt checked above");
    drop(guard);

    let delivery_email = email.trim().to_owned();
    let Some((local_part, domain)) = delivery_email.rsplit_once('@') else {
        if !restore_or_discard_pending_registration(
            &app,
            &state,
            &attempt_id,
            &cancellation,
            pending,
        )
        .await
        {
            return Err("registration cancelled".to_string());
        }
        reservation.defuse();
        return Err("enter an email address".to_string());
    };
    if local_part.is_empty() || domain.is_empty() {
        if !restore_or_discard_pending_registration(
            &app,
            &state,
            &attempt_id,
            &cancellation,
            pending,
        )
        .await
        {
            return Err("registration cancelled".to_string());
        }
        reservation.defuse();
        return Err("enter an email address".to_string());
    }
    let address_key = format!("{local_part}@{}", domain.to_lowercase());
    if let Some(previous_address) = &pending.email_address_key {
        if previous_address != &address_key {
            if !restore_or_discard_pending_registration(
                &app,
                &state,
                &attempt_id,
                &cancellation,
                pending,
            )
            .await
            {
                return Err("registration cancelled".to_string());
            }
            reservation.defuse();
            return Err(
                "cancel this registration and start again to use a different email address"
                    .to_string(),
            );
        }
    }
    if pending.email_send_attempt >= REGISTRATION_EMAIL_MAX_SEND_ATTEMPTS {
        if !restore_or_discard_pending_registration(
            &app,
            &state,
            &attempt_id,
            &cancellation,
            pending,
        )
        .await
        {
            return Err("registration cancelled".to_string());
        }
        reservation.defuse();
        return Err("registration email resend limit reached; start again".to_string());
    }
    if pending
        .email_retry_not_before
        .is_some_and(|retry_at| std::time::Instant::now() < retry_at)
    {
        if !restore_or_discard_pending_registration(
            &app,
            &state,
            &attempt_id,
            &cancellation,
            pending,
        )
        .await
        {
            return Err("registration cancelled".to_string());
        }
        reservation.defuse();
        return Err("wait before requesting another registration email".to_string());
    }
    let client_secret = pending
        .email_client_secret
        .get_or_insert_with(ClientSecret::new)
        .clone();
    let homeserver_scope = pending.client.homeserver().origin().ascii_serialization();
    let quota_reservation =
        match check_auth_mail_quota(&state, &address_key, &homeserver_scope).await {
            Ok(reservation) => reservation,
            Err(error) => {
                if !restore_or_discard_pending_registration(
                    &app,
                    &state,
                    &attempt_id,
                    &cancellation,
                    pending,
                )
                .await
                {
                    return Err("registration cancelled".to_string());
                }
                reservation.defuse();
                return Err(error);
            }
        };
    if cancellation.is_cancelled() {
        refund_auth_mail_quota(&state, quota_reservation).await;
        discard_pending_registration(&app, pending);
        clear_registration_cancellation(&state, &attempt_id);
        return Err("registration cancelled".to_string());
    }
    let send_attempt = pending.email_send_attempt + 1;
    let request = request_registration_token_via_email::v3::Request::new(
        client_secret.clone(),
        delivery_email.clone(),
        UInt::new_saturating(send_attempt.into()),
    );
    let response = tokio::select! {
        result = pending.client.send(request) => result,
        () = cancellation.cancelled() => {
            refund_auth_mail_quota(&state, quota_reservation.clone()).await;
            discard_pending_registration(&app, pending);
            clear_registration_cancellation(&state, &attempt_id);
            return Err("registration cancelled".to_string());
        }
    };
    let response = match response {
        Ok(response) => response,
        Err(_) => {
            refund_auth_mail_quota(&state, quota_reservation).await;
            match restore_pending_registration_if_current(
                &state,
                &attempt_id,
                &cancellation,
                pending,
            )
            .await
            {
                Ok(()) => {
                    reservation.defuse();
                    return Err("could not send registration verification email".to_string());
                }
                Err(pending) => {
                    discard_pending_registration(&app, pending);
                    clear_registration_cancellation(&state, &attempt_id);
                    return Err("registration cancelled".to_string());
                }
            }
        }
    };
    if cancellation.is_cancelled() {
        discard_pending_registration(&app, pending);
        clear_registration_cancellation(&state, &attempt_id);
        return Err("registration cancelled".to_string());
    }
    pending.email_address_key = Some(address_key);
    pending.email_send_attempt = send_attempt;
    pending.email_retry_not_before =
        Some(std::time::Instant::now() + REGISTRATION_EMAIL_RESEND_DELAY);
    let submit_url = match sanitize_email_submit_url(
        &pending.client.homeserver(),
        response.submit_url.as_deref(),
        "registration",
    ) {
        Ok(url) => url,
        Err(error) => {
            match restore_pending_registration_if_current(
                &state,
                &attempt_id,
                &cancellation,
                pending,
            )
            .await
            {
                Ok(()) => {
                    reservation.defuse();
                    return Err(error);
                }
                Err(pending) => {
                    discard_pending_registration(&app, pending);
                    clear_registration_cancellation(&state, &attempt_id);
                    return Err("registration cancelled".to_string());
                }
            }
        }
    };
    let requires_token = submit_url.is_some();
    pending.email_validation = Some(PendingRegistrationEmail {
        client_secret,
        sid: response.sid,
        submit_url,
        homeserver: pending.client.homeserver(),
        submitted: false,
    });
    if let Err(pending) =
        restore_pending_registration_if_current(&state, &attempt_id, &cancellation, pending).await
    {
        discard_pending_registration(&app, pending);
        clear_registration_cancellation(&state, &attempt_id);
        return Err("registration cancelled".to_string());
    }
    reservation.defuse();
    Ok(RegistrationEmailChallenge { requires_token })
}

async fn restore_pending_registration_if_current(
    state: &MatrixState,
    attempt_id: &str,
    cancellation: &tokio_util::sync::CancellationToken,
    pending: PendingRegistration,
) -> Result<(), PendingRegistration> {
    if cancellation.is_cancelled() || !registration_cancellation_is_current(state, attempt_id) {
        return Err(pending);
    }
    let mut guard = state.pending_registration.lock().await;
    if guard.is_some()
        || cancellation.is_cancelled()
        || !registration_cancellation_is_current(state, attempt_id)
    {
        return Err(pending);
    }
    *guard = Some(pending);
    Ok(())
}

async fn restore_or_discard_pending_registration(
    app: &AppHandle,
    state: &MatrixState,
    attempt_id: &str,
    cancellation: &tokio_util::sync::CancellationToken,
    pending: PendingRegistration,
) -> bool {
    match restore_pending_registration_if_current(state, attempt_id, cancellation, pending).await {
        Ok(()) => true,
        Err(pending) => {
            discard_pending_registration(app, pending);
            clear_registration_cancellation(state, attempt_id);
            false
        }
    }
}

fn registration_cancellation_is_current(state: &MatrixState, attempt_id: &str) -> bool {
    state
        .pending_registration_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .is_some_and(|(current_id, _)| current_id == attempt_id)
}

/// Continues exactly the active registration attempt and Matrix UIA session.
/// The supplied response must match the next stage selected from the latest
/// homeserver-advertised flow.
#[tauri::command]
pub async fn continue_registration(
    app: AppHandle,
    state: State<'_, MatrixState>,
    attempt_id: String,
    response: RegistrationAuthResponse,
) -> Result<RegistrationStep, String> {
    if let Err(error) = ensure_registration_feature_enabled(&app) {
        cancel_pending_registration_for_superseding_auth(&app, &state).await;
        return Err(error);
    }
    let cancellation = state
        .pending_registration_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .filter(|(current_id, _)| current_id == &attempt_id)
        .map(|(_, cancellation)| cancellation.clone())
        .ok_or_else(|| "registration attempt is no longer current".to_string())?;
    // Cancellation must remain responsive while another login/restore owns
    // this process-wide store lock.
    let _restore_store_guard = tokio::select! {
        guard = restore_store_lock().lock() => guard,
        () = cancellation.cancelled() => {
            return Err("registration cancelled".to_string());
        }
    };
    let mut pending_guard = state.pending_registration.lock().await;
    let Some(current) = pending_guard.as_ref() else {
        return Err("no registration is in progress".to_string());
    };
    if current.attempt_id != attempt_id {
        return Err("registration attempt is no longer current".to_string());
    }
    if current.created_at.elapsed() > REGISTRATION_ATTEMPT_TTL {
        let expired = pending_guard.take().expect("pending attempt checked above");
        drop(pending_guard);
        cancellation.cancel();
        clear_registration_cancellation(&state, &attempt_id);
        discard_pending_registration(&app, expired);
        return Err("registration attempt expired; start again".to_string());
    }

    let expected_stage = next_registration_stage(&current.uiaa)?;
    let reservation = ReservedTempStoreGuard::new(&state, current.store_key.clone());
    let mut pending = pending_guard.take().expect("pending attempt checked above");
    drop(pending_guard);

    let auth_result = tokio::select! {
        result = registration_auth_data(
            response,
            &expected_stage,
            &pending.uiaa,
            pending.email_validation.as_mut(),
        ) => result,
        () = cancellation.cancelled() => {
            discard_pending_registration(&app, pending);
            clear_registration_cancellation(&state, &attempt_id);
            return Err("registration cancelled".to_string());
        }
    };
    let auth = match auth_result {
        Ok(auth) => auth,
        Err(error) => {
            return match restore_pending_registration_if_current(
                &state,
                &attempt_id,
                &cancellation,
                pending,
            )
            .await
            {
                Ok(()) => {
                    reservation.defuse();
                    Err(error)
                }
                Err(pending) => {
                    discard_pending_registration(&app, pending);
                    clear_registration_cancellation(&state, &attempt_id);
                    Err("registration cancelled".to_string())
                }
            };
        }
    };
    let request = registration_request(&pending.request, Some(auth));
    let registration_result = tokio::select! {
        result = async { pending.client.matrix_auth().register(request).await } => result,
        () = cancellation.cancelled() => {
            discard_pending_registration(&app, pending);
            clear_registration_cancellation(&state, &attempt_id);
            return Err("registration cancelled".to_string());
        }
    };
    if cancellation.is_cancelled() || !registration_cancellation_is_current(&state, &attempt_id) {
        discard_pending_registration(&app, pending);
        clear_registration_cancellation(&state, &attempt_id);
        return Err("registration cancelled".to_string());
    }
    match registration_result {
        Ok(_) => {
            let cleanup_key = pending.store_key.clone();
            match finish_registration(
                app.clone(),
                &state,
                pending.client,
                pending.store_key,
                Some(&attempt_id),
                Some(&cancellation),
                None,
            )
            .await
            {
                Ok(session) => {
                    clear_registration_cancellation(&state, &attempt_id);
                    Ok(RegistrationStep::Complete { session })
                }
                Err(error) => {
                    clear_registration_cancellation(&state, &attempt_id);
                    let _ = persistence::discard_temp_login_store(&app, &cleanup_key);
                    Err(error)
                }
            }
        }
        Err(error) => {
            if let Some(uiaa) = error.as_uiaa_response().cloned() {
                pending.uiaa = uiaa;
                if !matches!(
                    next_registration_stage(&pending.uiaa).as_deref(),
                    Ok(stage) if stage == AuthType::EmailIdentity.as_str()
                ) {
                    pending.email_validation = None;
                }
                let step = match registration_challenge(
                    &pending.attempt_id,
                    &pending.client,
                    &pending.uiaa,
                ) {
                    Ok(step) => step,
                    Err(error) => {
                        discard_pending_registration(&app, pending);
                        clear_registration_cancellation(&state, &attempt_id);
                        return Err(error);
                    }
                };
                match restore_pending_registration_if_current(
                    &state,
                    &attempt_id,
                    &cancellation,
                    pending,
                )
                .await
                {
                    Ok(()) => {
                        reservation.defuse();
                        Ok(step)
                    }
                    Err(pending) => {
                        discard_pending_registration(&app, pending);
                        clear_registration_cancellation(&state, &attempt_id);
                        Err("registration cancelled".to_string())
                    }
                }
            } else {
                let message = safe_registration_error(&error);
                if registration_error_allows_retry(&error) {
                    match restore_pending_registration_if_current(
                        &state,
                        &attempt_id,
                        &cancellation,
                        pending,
                    )
                    .await
                    {
                        Ok(()) => reservation.defuse(),
                        Err(pending) => {
                            discard_pending_registration(&app, pending);
                            clear_registration_cancellation(&state, &attempt_id);
                            return Err("registration cancelled".to_string());
                        }
                    }
                } else {
                    discard_pending_registration(&app, pending);
                    clear_registration_cancellation(&state, &attempt_id);
                    return Err(format!("registration ended: {message}"));
                }
                Err(message)
            }
        }
    }
}

#[tauri::command]
pub async fn cancel_registration(
    app: AppHandle,
    state: State<'_, MatrixState>,
    attempt_id: String,
) -> Result<(), String> {
    let cancellation = {
        let guard = state
            .pending_registration_cancel
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match guard.as_ref() {
            Some((current_id, cancellation)) if current_id == &attempt_id => {
                Some(cancellation.clone())
            }
            Some(_) => return Err("registration attempt is no longer current".to_string()),
            None => None,
        }
    };
    let Some(cancellation) = cancellation else {
        if state.pending_registration.lock().await.is_none() {
            return Ok(());
        }
        return Err("registration attempt is no longer current".to_string());
    };
    cancellation.cancel();
    clear_registration_cancellation(&state, &attempt_id);

    let mut guard = state.pending_registration.lock().await;
    let Some(current) = guard.as_ref() else {
        return Ok(());
    };
    if current.attempt_id != attempt_id {
        return Err("registration attempt is no longer current".to_string());
    }
    let pending = guard.take().expect("pending attempt checked above");
    drop(guard);
    discard_pending_registration(&app, pending);
    Ok(())
}

#[tauri::command]
pub async fn request_password_reset(
    app: AppHandle,
    state: State<'_, MatrixState>,
    homeserver_url: String,
    email: String,
) -> Result<PasswordResetChallenge, String> {
    ensure_registration_feature_enabled(&app)?;
    let delivery_email = email.trim().to_owned();
    let started_at = std::time::Instant::now();
    let deadline = tokio::time::Instant::from_std(started_at + PASSWORD_RESET_ATTEMPT_TTL);
    state.pending_password_reset.lock().await.take();
    let attempt_id = generate_attempt_id();
    let cancellation = tokio_util::sync::CancellationToken::new();
    let previous_cancellation = state
        .pending_password_reset_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .replace((attempt_id.clone(), cancellation.clone()));
    if let Some((_, cancellation)) = previous_cancellation {
        cancellation.cancel();
    }
    let client = tokio::select! {
        result = Client::builder()
            .server_name_or_homeserver_url(&homeserver_url)
            .build() => result.map_err(|_| "could not start password reset".to_string()),
        () = cancellation.cancelled() => {
            Err("password reset attempt was superseded".to_string())
        },
        () = tokio::time::sleep_until(deadline) => {
            Err("password reset attempt expired; start again".to_string())
        }
    }?;
    let homeserver_scope = client.homeserver().origin().ascii_serialization();
    let quota_reservation =
        check_auth_mail_quota(&state, &delivery_email, &homeserver_scope).await?;
    let client_secret = ClientSecret::new();
    let request = request_password_change_token_via_email::v3::Request::new(
        client_secret.clone(),
        delivery_email,
        UInt::new_saturating(1),
    );
    let response = tokio::select! {
        result = client.send(request) => result,
        () = cancellation.cancelled() => {
            refund_auth_mail_quota(&state, quota_reservation.clone()).await;
            clear_password_reset_cancellation(&state, &attempt_id);
            return Err("password reset attempt was superseded".to_string());
        },
        () = tokio::time::sleep_until(deadline) => {
            refund_auth_mail_quota(&state, quota_reservation.clone()).await;
            clear_password_reset_cancellation(&state, &attempt_id);
            return Err("password reset attempt expired; start again".to_string());
        }
    };
    let (sid, submit_url, requires_token) = match response {
        Ok(response) => {
            let submit_url = sanitize_password_reset_submit_url(
                &client.homeserver(),
                response.submit_url.as_deref(),
            );
            match submit_url {
                Ok(submit_url) => {
                    let requires_token = submit_url.is_some();
                    (response.sid, submit_url, requires_token)
                }
                Err(_) => synthetic_password_reset_challenge()?,
            }
        }
        Err(error) => {
            if error.client_api_error_kind().is_none() {
                refund_auth_mail_quota(&state, quota_reservation).await;
            }
            retain_password_reset_retry_after(&state, &homeserver_scope, &error).await;
            // Matrix deliberately permits homeservers to reject an unknown
            // address here. Retain a synthetic pending validation session so
            // confirmation also behaves like a real but unverified attempt;
            // otherwise the missing pending entry becomes an account oracle.
            synthetic_password_reset_challenge()?
        }
    };
    if cancellation.is_cancelled() || !password_reset_cancellation_is_current(&state, &attempt_id) {
        return Err("password reset attempt was superseded".to_string());
    }
    let pending = PendingPasswordReset {
        client,
        client_secret,
        sid,
        submit_url,
        token_submitted: false,
        attempt_id: attempt_id.clone(),
        created_at: started_at,
    };
    let mut pending_guard = state.pending_password_reset.lock().await;
    if cancellation.is_cancelled()
        || !password_reset_cancellation_is_current(&state, &attempt_id)
        || pending_guard.is_some()
    {
        return Err("password reset attempt was superseded".to_string());
    }
    pending_guard.replace(pending);
    drop(pending_guard);
    spawn_password_reset_expiry(app, attempt_id.clone(), started_at);
    Ok(PasswordResetChallenge {
        attempt_id,
        requires_token,
    })
}

async fn check_auth_mail_quota(
    state: &MatrixState,
    address: &str,
    homeserver_scope: &str,
) -> Result<AuthMailQuotaReservation, String> {
    let now = std::time::Instant::now();
    let cutoff = now.checked_sub(AUTH_MAIL_QUOTA_WINDOW);
    let mut hasher = AUTH_MAIL_ADDRESS_HASHER
        .get_or_init(std::collections::hash_map::RandomState::new)
        .build_hasher();
    hasher.write(address.to_lowercase().as_bytes());
    let digest = format!("{:016x}", hasher.finish());
    let mut quota = state.auth_mail_quota.lock().await;
    if quota
        .upstream_retry_until_by_homeserver
        .get(homeserver_scope)
        .is_some_and(|retry_until| *retry_until > now)
    {
        return Err("too many recovery emails; try again later".to_string());
    }
    quota
        .upstream_retry_until_by_homeserver
        .retain(|_, retry_until| *retry_until > now);
    quota
        .all
        .retain(|at| cutoff.is_none_or(|cutoff| *at >= cutoff));
    quota.by_address.retain(|_, attempts| {
        attempts.retain(|at| cutoff.is_none_or(|cutoff| *at >= cutoff));
        !attempts.is_empty()
    });
    if quota.all.len() >= AUTH_MAILS_PER_PROCESS
        || quota
            .by_address
            .get(&digest)
            .is_some_and(|attempts| attempts.len() >= AUTH_MAILS_PER_ADDRESS)
    {
        return Err("too many authentication emails; try again later".to_string());
    }
    quota.all.push(now);
    quota
        .by_address
        .entry(digest.clone())
        .or_default()
        .push(now);
    Ok(AuthMailQuotaReservation {
        address_digest: digest,
        at: now,
    })
}

async fn refund_auth_mail_quota(state: &MatrixState, reservation: AuthMailQuotaReservation) {
    let mut quota = state.auth_mail_quota.lock().await;
    if let Some(index) = quota.all.iter().rposition(|at| *at == reservation.at) {
        quota.all.remove(index);
    }
    let remove_address =
        if let Some(attempts) = quota.by_address.get_mut(&reservation.address_digest) {
            if let Some(index) = attempts.iter().rposition(|at| *at == reservation.at) {
                attempts.remove(index);
            }
            attempts.is_empty()
        } else {
            false
        };
    if remove_address {
        quota.by_address.remove(&reservation.address_digest);
    }
}

fn synthetic_password_reset_challenge(
) -> Result<(matrix_sdk::ruma::OwnedSessionId, Option<url::Url>, bool), String> {
    let sid = serde_json::from_value(serde_json::json!(generate_attempt_id()))
        .map_err(|_| "could not start password reset".to_string())?;
    Ok((sid, None, false))
}

async fn retain_password_reset_retry_after(
    state: &MatrixState,
    homeserver_scope: &str,
    error: &matrix_sdk::HttpError,
) {
    use matrix_sdk::ruma::api::error::RetryAfter;

    let Some(ErrorKind::LimitExceeded(data)) = error.client_api_error_kind() else {
        return;
    };
    let Some(retry_after) = data.retry_after else {
        return;
    };
    let delay = match retry_after {
        RetryAfter::Delay(delay) => delay,
        RetryAfter::DateTime(deadline) => deadline
            .duration_since(std::time::SystemTime::now())
            .unwrap_or_default(),
    };
    let retry_until = std::time::Instant::now() + delay;
    let mut quota = state.auth_mail_quota.lock().await;
    quota
        .upstream_retry_until_by_homeserver
        .entry(homeserver_scope.to_owned())
        .and_modify(|current| *current = (*current).max(retry_until))
        .or_insert(retry_until);
}

#[tauri::command]
pub async fn confirm_password_reset(
    app: AppHandle,
    state: State<'_, MatrixState>,
    attempt_id: String,
    token: Option<String>,
    new_password: String,
) -> Result<(), String> {
    ensure_registration_feature_enabled(&app)?;
    let mut guard = state.pending_password_reset.lock().await;
    let Some(current) = guard.as_ref() else {
        return Err("password reset attempt expired or was cancelled".to_string());
    };
    if current.attempt_id != attempt_id || current.created_at.elapsed() > PASSWORD_RESET_ATTEMPT_TTL
    {
        return Err("password reset attempt expired or was cancelled".to_string());
    }
    let mut pending = guard
        .take()
        .ok_or_else(|| "password reset attempt expired or was cancelled".to_string())?;
    drop(guard);

    let cancellation = state
        .pending_password_reset_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .filter(|(current_id, _)| current_id == &attempt_id)
        .map(|(_, cancellation)| cancellation.clone())
        .ok_or_else(|| "password reset attempt expired or was cancelled".to_string())?;
    let result = tokio::select! {
        result = complete_password_reset(&mut pending, token.as_deref(), new_password) => result,
        () = cancellation.cancelled() => {
            Err("password reset attempt expired or was cancelled".to_string())
        }
    };
    if result.is_err() {
        let mut guard = state.pending_password_reset.lock().await;
        if !cancellation.is_cancelled()
            && guard.is_none()
            && pending.created_at.elapsed() <= PASSWORD_RESET_ATTEMPT_TTL
        {
            *guard = Some(pending);
        }
    } else {
        clear_password_reset_cancellation(&state, &attempt_id);
    }
    result
}

#[tauri::command]
pub async fn cancel_password_reset(
    _app: AppHandle,
    state: State<'_, MatrixState>,
    attempt_id: Option<String>,
) -> Result<(), String> {
    let mut guard = state.pending_password_reset.lock().await;
    let target_id = attempt_id
        .or_else(|| guard.as_ref().map(|pending| pending.attempt_id.clone()))
        .or_else(|| {
            state
                .pending_password_reset_cancel
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
                .map(|(attempt_id, _)| attempt_id.clone())
        });
    let Some(attempt_id) = target_id else {
        return Ok(());
    };
    if guard
        .as_ref()
        .is_some_and(|pending| pending.attempt_id == attempt_id)
    {
        guard.take();
    }
    cancel_password_reset_cancellation(&state, &attempt_id);
    Ok(())
}

fn sanitize_password_reset_submit_url(
    homeserver: &url::Url,
    submit_url: Option<&str>,
) -> Result<Option<url::Url>, String> {
    sanitize_email_submit_url(homeserver, submit_url, "password-reset")
}

fn sanitize_email_submit_url(
    homeserver: &url::Url,
    submit_url: Option<&str>,
    flow: &str,
) -> Result<Option<url::Url>, String> {
    let Some(submit_url) = submit_url else {
        return Ok(None);
    };
    let parsed = homeserver
        .join(submit_url)
        .map_err(|_| format!("this homeserver returned an unsupported {flow} flow"))?;
    if !(matches!(parsed.scheme(), "https")
        || parsed.scheme() == "http" && parsed.origin() == homeserver.origin())
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(format!(
            "this homeserver returned an unsupported {flow} flow"
        ));
    }
    Ok(Some(parsed))
}

async fn submit_email_validation(
    submit_url: &url::Url,
    homeserver: &url::Url,
    sid: &matrix_sdk::ruma::OwnedSessionId,
    client_secret: &matrix_sdk::ruma::OwnedClientSecret,
    token: &str,
    flow: &str,
) -> Result<(), String> {
    let client = email_validation_submission_client(submit_url, homeserver)
        .await
        .map_err(|_| format!("could not confirm {flow} email"))?;
    let response = client
        .post(submit_url.clone())
        .json(&serde_json::json!({
            "sid": sid,
            "client_secret": client_secret,
            "token": token,
        }))
        .send()
        .await
        .map_err(|_| format!("could not confirm {flow} email"))?;
    if !response.status().is_success() {
        return Err(format!("could not confirm {flow} email"));
    }
    let accepted = response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|body| body.get("success").and_then(serde_json::Value::as_bool))
        .unwrap_or(false);
    if !accepted {
        return Err(format!("could not confirm {flow} email"));
    }
    Ok(())
}

async fn complete_password_reset(
    pending: &mut PendingPasswordReset,
    token: Option<&str>,
    new_password: String,
) -> Result<(), String> {
    if let Some(submit_url) = &pending.submit_url {
        if pending.token_submitted {
            return complete_password_change(pending, new_password).await;
        }
        let token = token
            .filter(|token| !token.is_empty())
            .ok_or_else(|| "enter the token from your password-reset email".to_string())?;
        submit_email_validation(
            submit_url,
            &pending.client.homeserver(),
            &pending.sid,
            &pending.client_secret,
            token,
            "password-reset",
        )
        .await
        .map_err(|_| "could not confirm password reset".to_string())?;
        pending.token_submitted = true;
    }

    complete_password_change(pending, new_password).await
}

async fn complete_password_change(
    pending: &PendingPasswordReset,
    new_password: String,
) -> Result<(), String> {
    let thirdparty_id_creds =
        ThirdpartyIdCredentials::new(pending.sid.clone(), pending.client_secret.clone());
    let email_identity: EmailIdentity = serde_json::from_value(serde_json::json!({
        "threepid_creds": thirdparty_id_creds,
    }))
    .map_err(|_| "could not confirm password reset".to_string())?;
    let mut request = change_password::v3::Request::new(new_password);
    request.auth = Some(AuthData::EmailIdentity(email_identity));
    pending
        .client
        .send(request)
        .with_request_config(RequestConfig::new().skip_auth())
        .await
        .map(|_| ())
        .map_err(|_| "could not confirm password reset".to_string())
}

async fn email_validation_submission_client(
    submit_url: &url::Url,
    homeserver: &url::Url,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15));

    // Resolve every submission host exactly once and pin that result into
    // reqwest. Origin equality does not prevent a configured hostname from
    // being rebound between the homeserver request and token submission.
    let host = submit_url
        .host_str()
        .ok_or_else(|| "could not confirm password reset".to_string())?;
    let port = submit_url
        .port_or_known_default()
        .ok_or_else(|| "could not confirm password reset".to_string())?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "could not confirm password reset".to_string())?
        .collect::<Vec<_>>();
    let explicitly_local_same_origin = submit_url.origin() == homeserver.origin()
        && (host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok());
    if addresses.is_empty()
        || (!explicitly_local_same_origin
            && addresses
                .iter()
                .any(|address| !is_public_network_ip(address.ip())))
    {
        return Err("could not confirm password reset".to_string());
    }
    builder = builder.resolve_to_addrs(host, &addresses);

    builder
        .build()
        .map_err(|_| "could not confirm password reset".to_string())
}

fn password_reset_cancellation_is_current(state: &MatrixState, attempt_id: &str) -> bool {
    state
        .pending_password_reset_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .is_some_and(|(current_id, _)| current_id == attempt_id)
}

fn is_public_network_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 88 && c == 99)
                || (a == 192 && b == 168)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        std::net::IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_network_ip(mapped.into());
            }
            let segments = ip.segments();
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x0064 && segments[1] == 0xff9b)
                || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001)
                || (segments[0] == 0x2001 && segments[1] <= 0x01ff)
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || segments[0] == 0x2002
                || segments[0] == 0x5f00
                || (segments[0] == 0x3fff && (segments[1] & 0xf000) == 0)
                || (segments[0] == 0x0100 && segments[1..4] == [0, 0, 0]))
        }
    }
}

fn spawn_password_reset_expiry(app: AppHandle, attempt_id: String, started_at: std::time::Instant) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep_until(tokio::time::Instant::from_std(
            started_at + PASSWORD_RESET_ATTEMPT_TTL,
        ))
        .await;
        let state = app.state::<MatrixState>();
        let mut guard = state.pending_password_reset.lock().await;
        if guard
            .as_ref()
            .is_some_and(|pending| pending.attempt_id == attempt_id)
        {
            guard.take();
        }
        drop(guard);
        cancel_password_reset_cancellation(&state, &attempt_id);
    });
}

fn clear_password_reset_cancellation(state: &MatrixState, attempt_id: &str) {
    let mut guard = state
        .pending_password_reset_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if guard
        .as_ref()
        .is_some_and(|(current_id, _)| current_id == attempt_id)
    {
        guard.take();
    }
}

fn cancel_password_reset_cancellation(state: &MatrixState, attempt_id: &str) {
    let mut guard = state
        .pending_password_reset_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if guard
        .as_ref()
        .is_some_and(|(current_id, _)| current_id == attempt_id)
    {
        if let Some((_, cancellation)) = guard.take() {
            cancellation.cancel();
        }
    }
}

#[tauri::command]
pub async fn get_login_flows(
    app: AppHandle,
    homeserver_url: String,
) -> Result<LoginFlowSummary, String> {
    ensure_registration_feature_enabled(&app)?;
    let response = tokio::time::timeout(AUTH_NETWORK_TIMEOUT, async {
        let client = Client::builder()
            .server_name_or_homeserver_url(&homeserver_url)
            .build()
            .await
            .map_err(|_| "could not discover login options for this homeserver".to_string())?;
        client
            .matrix_auth()
            .get_login_types()
            .await
            .map_err(|_| "could not discover login options for this homeserver".to_string())
    })
    .await
    .map_err(|_| "login option discovery timed out".to_string())??;
    Ok(summarize_login_flows(response.flows))
}

#[tauri::command]
pub async fn login_with_token(
    app: AppHandle,
    state: State<'_, MatrixState>,
    homeserver_url: String,
    token: String,
) -> Result<LoginResponse, String> {
    let deadline = tokio::time::Instant::now() + AUTH_NETWORK_TIMEOUT;
    ensure_registration_feature_enabled(&app)?;
    cancel_pending_registration_for_superseding_auth(&app, &state).await;
    if let Some(pending) = state.pending_sso.lock().await.take() {
        let store_key = pending.store_key.clone();
        drop(pending);
        let _ = persistence::discard_temp_login_store(&app, &store_key);
    }

    let store_key = persistence::temp_store_key();
    let reservation = ReservedTempStoreGuard::new(&state, store_key.clone());
    let client =
        match tokio::time::timeout_at(deadline, build_client(&app, &homeserver_url, &store_key))
            .await
        {
            Ok(Ok(client)) => client,
            Err(_) => {
                let _ = persistence::discard_temp_login_store(&app, &store_key);
                return Err("token login setup timed out".to_string());
            }
            Ok(Err(error)) => {
                let _ = persistence::discard_temp_login_store(&app, &store_key);
                return Err(error);
            }
        };
    let flows =
        match tokio::time::timeout_at(deadline, client.matrix_auth().get_login_types()).await {
            Ok(Ok(flows)) => flows,
            Ok(Err(_)) | Err(_) => {
                drop(client);
                let _ = persistence::discard_temp_login_store(&app, &store_key);
                return Err("could not verify token login support".to_string());
            }
        };
    if !flows
        .flows
        .iter()
        .any(|flow| matches!(flow, LoginType::Token(_)))
    {
        drop(client);
        let _ = persistence::discard_temp_login_store(&app, &store_key);
        return Err("this homeserver does not advertise token login".to_string());
    }

    if !matches!(
        tokio::time::timeout_at(
            deadline,
            client
                .matrix_auth()
                .login_token(&token)
                .initial_device_display_name("Charm")
                .send(),
        )
        .await,
        Ok(Ok(_))
    ) {
        drop(client);
        let _ = persistence::discard_temp_login_store(&app, &store_key);
        return Err("token login failed".to_string());
    }
    let _restore_store_guard =
        match tokio::time::timeout_at(deadline, restore_store_lock().lock()).await {
            Ok(guard) => guard,
            Err(_) => {
                drop(client);
                let _ = persistence::discard_temp_login_store(&app, &store_key);
                return Err("token login setup timed out".to_string());
            }
        };
    // Keep the reservation visible until the process-wide restore/sweep lock
    // is held, so cleanup cannot delete this active store in the gap.
    reservation.defuse();
    let cleanup_key = store_key.clone();
    match finish_registration(
        app.clone(),
        &state,
        client,
        store_key,
        None,
        None,
        Some(deadline),
    )
    .await
    {
        Ok(session) => Ok(session),
        Err(error) => {
            let _ = persistence::discard_temp_login_store(&app, &cleanup_key);
            Err(error)
        }
    }
}

fn summarize_login_flows(flows: Vec<LoginType>) -> LoginFlowSummary {
    const MAX_IDENTITY_PROVIDERS: usize = 32;
    let mut summary = LoginFlowSummary {
        password: false,
        token: false,
        sso: false,
        identity_providers: Vec::new(),
    };
    for flow in flows {
        match flow {
            LoginType::Password(_) => summary.password = true,
            LoginType::Token(_) => summary.token = true,
            LoginType::Sso(sso) => {
                summary.sso = true;
                for provider in sso.identity_providers {
                    if summary.identity_providers.len() >= MAX_IDENTITY_PROVIDERS
                        || summary
                            .identity_providers
                            .iter()
                            .any(|existing| existing.id == provider.id)
                    {
                        continue;
                    }
                    summary.identity_providers.push(LoginIdentityProvider {
                        id: provider.id,
                        name: sanitized_provider_name(&provider.name),
                        brand: provider.brand.map(|brand| brand.as_str().to_owned()),
                    });
                }
            }
            _ => {}
        }
    }
    summary
}

fn sanitized_provider_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .filter_map(|character| {
            if character.is_alphanumeric() {
                Some(character)
            } else if character.is_whitespace() {
                Some(' ')
            } else if matches!(
                character,
                '-' | '_'
                    | '.'
                    | ','
                    | ':'
                    | ';'
                    | '/'
                    | '&'
                    | '+'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '\''
                    | '’'
            ) {
                Some(character)
            } else {
                None
            }
        })
        .take(80)
        .collect::<String>();
    if sanitized.trim().is_empty() {
        "Single sign-on".to_string()
    } else {
        sanitized
    }
}

fn identity_provider_is_advertised(flows: &[LoginType], idp_id: &str) -> bool {
    flows.iter().any(|flow| {
        matches!(
            flow,
            LoginType::Sso(sso)
                if sso.identity_providers.iter().any(|provider| provider.id == idp_id)
        )
    })
}

fn ensure_registration_feature_enabled(app: &AppHandle) -> Result<(), String> {
    let enabled = app.path().app_data_dir().is_ok_and(|dir| {
        crate::feature_flags::flag(
            &dir,
            crate::feature_flags::FeatureFlagKey::RegistrationAndRecovery,
        )
    });
    enabled
        .then_some(())
        .ok_or_else(|| "registration and recovery is not enabled".to_string())
}

pub(crate) async fn cancel_pending_registration_for_superseding_auth(
    app: &AppHandle,
    state: &MatrixState,
) {
    if let Some((_, cancellation)) = state
        .pending_registration_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        cancellation.cancel();
    }
    if let Some(pending) = state.pending_registration.lock().await.take() {
        discard_pending_registration(app, pending);
    }
}

/// Best-effort synchronous cleanup for Tauri's synchronous `RunEvent::Exit`
/// callback. Cancelling first lets an in-flight continuation perform its own
/// cleanup; an idle attempt can be taken immediately without starting or
/// blocking an async runtime from inside the event loop.
pub(crate) fn cancel_pending_registration_on_exit(app: &AppHandle, state: &MatrixState) {
    if let Some((_, cancellation)) = state
        .pending_registration_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        cancellation.cancel();
    }
    if let Ok(mut pending) = state.pending_registration.try_lock() {
        if let Some(pending) = pending.take() {
            discard_pending_registration(app, pending);
        }
    }
    if let Some(account_key) = state
        .finalizing_registration_account
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        let _ = persistence::mark_cancelled_account_cleanup(app, &account_key);
        let _ = persistence::discard_cancelled_account_session(app, &account_key);
    }
}

fn clear_registration_cancellation(state: &MatrixState, attempt_id: &str) {
    let mut guard = state
        .pending_registration_cancel
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if guard
        .as_ref()
        .is_some_and(|(current_id, _)| current_id == attempt_id)
    {
        guard.take();
    }
}

fn spawn_registration_expiry(
    app: AppHandle,
    attempt_id: String,
    cancellation: tokio_util::sync::CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            () = tokio::time::sleep(REGISTRATION_ATTEMPT_TTL) => {}
            () = cancellation.cancelled() => return,
        }
        let state = app.state::<MatrixState>();
        let cancellation = {
            let guard = state
                .pending_registration_cancel
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            guard
                .as_ref()
                .filter(|(current_id, _)| current_id == &attempt_id)
                .map(|(_, cancellation)| cancellation.clone())
        };
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
            clear_registration_cancellation(&state, &attempt_id);
        }
        let mut guard = state.pending_registration.lock().await;
        let expired = if guard
            .as_ref()
            .is_some_and(|pending| pending.attempt_id == attempt_id)
        {
            guard.take()
        } else {
            None
        };
        drop(guard);
        if let Some(expired) = expired {
            discard_pending_registration(&app, expired);
        }
    });
}

struct FinalizingRegistrationGuard<'a> {
    state: &'a MatrixState,
    account_key: String,
}

impl<'a> FinalizingRegistrationGuard<'a> {
    fn new(state: &'a MatrixState, account_key: String) -> Self {
        state
            .finalizing_registration_account
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .replace(account_key.clone());
        Self { state, account_key }
    }
}

impl Drop for FinalizingRegistrationGuard<'_> {
    fn drop(&mut self) {
        let mut guard = self
            .state
            .finalizing_registration_account
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if guard.as_deref() == Some(self.account_key.as_str()) {
            guard.take();
        }
    }
}

fn discard_pending_registration(app: &AppHandle, pending: PendingRegistration) {
    let store_key = pending.store_key.clone();
    drop(pending);
    let _ = persistence::discard_temp_login_store(app, &store_key);
}

fn safe_registration_error(error: &matrix_sdk::Error) -> String {
    match error.client_api_error_kind() {
        Some(ErrorKind::UserInUse) => "That username is already in use.".to_string(),
        Some(ErrorKind::InvalidUsername) => "That username is not valid.".to_string(),
        Some(ErrorKind::LimitExceeded(_)) => {
            "Too many registration attempts. Wait and try again.".to_string()
        }
        Some(ErrorKind::UserLimitExceeded(_)) | Some(ErrorKind::ResourceLimitExceeded(_)) => {
            "This homeserver is not accepting additional registrations.".to_string()
        }
        _ => "Registration was rejected. Check the username and password requirements.".to_string(),
    }
}

fn registration_error_allows_retry(error: &matrix_sdk::Error) -> bool {
    matches!(
        error.client_api_error_kind(),
        None | Some(ErrorKind::LimitExceeded(_))
    )
}

fn registration_request(
    request: &RegisterRequest,
    auth: Option<AuthData>,
) -> register::v3::Request {
    let mut register_request = register::v3::Request::new();
    register_request.username = Some(request.username.clone());
    register_request.password = Some(request.password.clone());
    register_request.auth = auth;
    register_request
}

fn generate_attempt_id() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn next_registration_stage(uiaa: &UiaaInfo) -> Result<String, String> {
    let completed = uiaa
        .completed
        .iter()
        .map(AuthType::as_str)
        .collect::<std::collections::HashSet<_>>();
    uiaa.flows
        .iter()
        .filter_map(|flow| {
            let remaining = flow
                .stages
                .iter()
                .filter(|stage| !completed.contains(stage.as_str()))
                .collect::<Vec<_>>();
            remaining
                .first()
                .map(|next| (remaining.len(), next.as_str()))
        })
        .min_by_key(|(remaining, _)| *remaining)
        .map(|(_, stage)| stage.to_owned())
        .ok_or_else(|| "homeserver returned no incomplete registration stage".to_string())
}

async fn registration_auth_data(
    response: RegistrationAuthResponse,
    expected_stage: &str,
    uiaa: &UiaaInfo,
    email_validation: Option<&mut PendingRegistrationEmail>,
) -> Result<AuthData, String> {
    match response {
        RegistrationAuthResponse::AcceptTerms if expected_stage == AuthType::Terms.as_str() => {
            let mut terms = Terms::new();
            terms.session = uiaa.session.clone();
            Ok(AuthData::Terms(terms))
        }
        RegistrationAuthResponse::CompleteDummy if expected_stage == AuthType::Dummy.as_str() => {
            let mut dummy = Dummy::new();
            dummy.session = uiaa.session.clone();
            Ok(AuthData::Dummy(dummy))
        }
        RegistrationAuthResponse::CompleteEmail { token }
            if expected_stage == AuthType::EmailIdentity.as_str() =>
        {
            let validation = email_validation
                .ok_or_else(|| "request a registration verification email first".to_string())?;
            if !validation.submitted {
                if let Some(submit_url) = &validation.submit_url {
                    let token = token
                        .as_deref()
                        .filter(|token| !token.is_empty())
                        .ok_or_else(|| {
                            "enter the token from your registration email".to_string()
                        })?;
                    submit_email_validation(
                        submit_url,
                        &validation.homeserver,
                        &validation.sid,
                        &validation.client_secret,
                        token,
                        "registration",
                    )
                    .await?;
                    validation.submitted = true;
                }
            }
            let credentials = ThirdpartyIdCredentials::new(
                validation.sid.clone(),
                validation.client_secret.clone(),
            );
            let mut email_identity: EmailIdentity = serde_json::from_value(serde_json::json!({
                "threepid_creds": credentials,
            }))
            .map_err(|_| "could not confirm registration email".to_string())?;
            email_identity.session = uiaa.session.clone();
            Ok(AuthData::EmailIdentity(email_identity))
        }
        RegistrationAuthResponse::AcknowledgeFallback { stage } if stage == expected_stage => {
            let session = uiaa
                .session
                .clone()
                .ok_or_else(|| "homeserver omitted the registration UIA session".to_string())?;
            Ok(AuthData::fallback_acknowledgement(session))
        }
        _ => Err(format!(
            "registration response does not match the required stage {expected_stage}"
        )),
    }
}

fn registration_challenge(
    attempt_id: &str,
    client: &Client,
    uiaa: &UiaaInfo,
) -> Result<RegistrationStep, String> {
    let next_stage = next_registration_stage(uiaa)?;
    let fallback_url = match uiaa.session.as_deref() {
        Some(session) => registration_fallback_url(client, &next_stage, session)?,
        None if matches!(
            next_stage.as_str(),
            stage if stage == AuthType::Terms.as_str()
                || stage == AuthType::Dummy.as_str()
                || stage == AuthType::EmailIdentity.as_str()
        ) =>
        {
            String::new()
        }
        None => return Err("homeserver omitted the registration UIA session".to_string()),
    };
    let policies = sanitized_registration_policies(uiaa);
    Ok(RegistrationStep::Challenge {
        attempt_id: attempt_id.to_owned(),
        completed: uiaa
            .completed
            .iter()
            .map(|stage| stage.as_str().to_owned())
            .collect(),
        flows: uiaa
            .flows
            .iter()
            .map(|flow| RegistrationFlow {
                stages: flow
                    .stages
                    .iter()
                    .map(|stage| stage.as_str().to_owned())
                    .collect(),
            })
            .collect(),
        next_stage,
        fallback_url,
        policies,
    })
}

fn registration_fallback_url(
    client: &Client,
    stage: &str,
    session: &str,
) -> Result<String, String> {
    let mut url = client.homeserver().clone();
    url.set_query(None);
    url.path_segments_mut()
        .map_err(|_| "homeserver URL cannot host a registration fallback".to_string())?
        .pop_if_empty()
        .extend(["_matrix", "client", "v3", "auth", stage, "fallback", "web"]);
    url.query_pairs_mut().append_pair("session", session);
    Ok(url.to_string())
}

fn sanitized_registration_policies(uiaa: &UiaaInfo) -> Vec<RegistrationPolicy> {
    let Ok(Some(params)) = uiaa.params::<LoginTermsParams>(&AuthType::Terms) else {
        return Vec::new();
    };
    params
        .policies
        .into_iter()
        .flat_map(|(id, definition)| {
            definition
                .translations
                .into_iter()
                .filter_map(move |(language, translation)| {
                    let url = url::Url::parse(&translation.url).ok()?;
                    if !matches!(url.scheme(), "http" | "https") {
                        return None;
                    }
                    Some(RegistrationPolicy {
                        id: id.clone(),
                        version: definition.version.clone(),
                        language,
                        name: translation.name,
                        url: url.to_string(),
                    })
                })
        })
        .collect()
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
    idp_id: Option<String>,
) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + AUTH_NETWORK_TIMEOUT;
    if idp_id.is_some() {
        ensure_registration_feature_enabled(&app)?;
    }
    cancel_pending_registration_for_superseding_auth(&app, &state).await;
    // The account isn't known until the browser redirects back with a
    // `loginToken` — open a temp store now and relocate it in
    // `complete_sso_login` once the MXID is known.
    let store_key = persistence::temp_store_key();
    // See `MatrixState::ReservedTempStoreGuard`'s doc comment (Codex review
    // on #288, P2): reserved before the two `.await`s below (client build,
    // login-URL fetch) so the delayed sweep pass can't see this store as
    // unprotected for however long that network setup takes — `pending_sso`
    // itself isn't set until after both succeed.
    let reservation = ReservedTempStoreGuard::new(&state, store_key.clone());
    let client =
        match tokio::time::timeout_at(deadline, build_client(&app, &homeserver_url, &store_key))
            .await
        {
            Ok(Ok(client)) => client,
            Ok(Err(error)) => {
                let _ = persistence::discard_temp_login_store(&app, &store_key);
                return Err(error);
            }
            Err(_) => {
                let _ = persistence::discard_temp_login_store(&app, &store_key);
                return Err("single sign-on setup timed out".to_string());
            }
        };
    let attempt_state = generate_sso_state();
    if let Some(idp_id) = idp_id.as_deref() {
        let flows =
            match tokio::time::timeout_at(deadline, client.matrix_auth().get_login_types()).await {
                Ok(Ok(flows)) => flows,
                Ok(Err(_)) => {
                    drop(client);
                    let _ = persistence::discard_temp_login_store(&app, &store_key);
                    return Err("could not verify this identity provider".to_string());
                }
                Err(_) => {
                    drop(client);
                    let _ = persistence::discard_temp_login_store(&app, &store_key);
                    return Err("single sign-on setup timed out".to_string());
                }
            };
        if !identity_provider_is_advertised(&flows.flows, idp_id) {
            drop(client);
            let _ = persistence::discard_temp_login_store(&app, &store_key);
            return Err("this identity provider is not advertised by the homeserver".to_string());
        }
    }
    let sso_url = match tokio::time::timeout_at(
        deadline,
        get_sso_login_url_with_provider(&client, &attempt_state, idp_id.as_deref()),
    )
    .await
    {
        Ok(Ok(url)) => url,
        Ok(Err(error)) => {
            drop(client);
            let _ = persistence::discard_temp_login_store(&app, &store_key);
            return Err(error);
        }
        Err(_) => {
            drop(client);
            let _ = persistence::discard_temp_login_store(&app, &store_key);
            return Err("single sign-on setup timed out".to_string());
        }
    };

    // Publish to `pending_sso` *before* defusing the reservation, not after
    // (Codex review on #288, P2): defusing first would leave a gap between
    // that call and this one (an `.await` for the lock apart) where the key
    // was protected by neither set, exactly the race
    // `ReservedTempStoreGuard` exists to close. This order means the
    // reservation is still live for the whole handoff.
    let previous = state.pending_sso.lock().await.replace(PendingSso {
        client,
        state: attempt_state.clone(),
        store_key,
    });
    reservation.defuse();
    // A double-start (e.g. a double click) would otherwise overwrite the
    // previous attempt's `PendingSso` without ever discarding its temp
    // store/passphrase — same leak `cancel_sso_login` guards against, just
    // via a different trigger (a new attempt instead of an explicit
    // cancel).
    if let Some(previous) = previous {
        let store_key = previous.store_key.clone();
        drop(previous);
        let _ = persistence::discard_temp_login_store(&app, &store_key);
    }
    spawn_sso_expiry(app, attempt_state);

    Ok(sso_url)
}

fn spawn_sso_expiry(app: AppHandle, attempt_state: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REGISTRATION_ATTEMPT_TTL).await;
        let state = app.state::<MatrixState>();
        let mut guard = state.pending_sso.lock().await;
        let expired = if guard
            .as_ref()
            .is_some_and(|pending| pending.state == attempt_state)
        {
            guard.take()
        } else {
            None
        };
        drop(guard);
        if let Some(expired) = expired {
            let store_key = expired.store_key.clone();
            drop(expired);
            let _ = persistence::discard_temp_login_store(&app, &store_key);
        }
    });
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
        let store_key = pending.store_key.clone();
        drop(pending);
        let _ = persistence::discard_temp_login_store(&app, &store_key);
    }
    Ok(())
}

/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/`, same rationale as [`super::resolve_alias`].
pub async fn get_sso_login_url(client: &Client, attempt_state: &str) -> Result<String, String> {
    get_sso_login_url_with_provider(client, attempt_state, None).await
}

async fn get_sso_login_url_with_provider(
    client: &Client,
    attempt_state: &str,
    idp_id: Option<&str>,
) -> Result<String, String> {
    let redirect_url = format!("{SSO_REDIRECT_BASE_URL}?state={attempt_state}");
    client
        .matrix_auth()
        .get_sso_login_url(&redirect_url, idp_id)
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
mod registration_uia_tests {
    use matrix_sdk::ruma::api::client::session::get_login_types::v3::LoginType;
    use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, UiaaInfo};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, ResponseTemplate};

    use super::{
        check_auth_mail_quota, complete_password_reset, identity_provider_is_advertised,
        is_public_network_ip, next_registration_stage, refund_auth_mail_quota,
        registration_auth_data, registration_fallback_url, sanitize_password_reset_submit_url,
        sanitized_provider_name, sanitized_registration_policies, summarize_login_flows,
        PasswordResetChallenge, PendingPasswordReset, PendingRegistrationEmail,
        RegistrationAuthResponse, AUTH_MAILS_PER_ADDRESS,
    };
    use crate::matrix::MatrixState;

    fn uiaa(value: serde_json::Value) -> UiaaInfo {
        serde_json::from_value(value).expect("valid UIA fixture")
    }

    fn login_flows(value: serde_json::Value) -> Vec<LoginType> {
        serde_json::from_value(value).expect("valid login-flow fixture")
    }

    #[test]
    fn selects_the_shortest_viable_flow_and_skips_completed_stages() {
        let info = uiaa(json!({
            "flows": [
                {"stages": ["m.login.terms", "m.login.email.identity", "m.login.dummy"]},
                {"stages": ["m.login.terms", "m.login.dummy"]}
            ],
            "completed": ["m.login.terms"],
            "session": "uia-session"
        }));

        assert_eq!(
            next_registration_stage(&info).as_deref(),
            Ok(AuthType::Dummy.as_str())
        );
    }

    #[tokio::test]
    async fn rejects_a_response_for_a_different_stage() {
        let info = uiaa(json!({
            "flows": [{"stages": ["m.login.terms"]}],
            "session": "uia-session"
        }));

        let error = registration_auth_data(
            RegistrationAuthResponse::CompleteDummy,
            AuthType::Terms.as_str(),
            &info,
            None,
        )
        .await
        .expect_err("dummy must not satisfy terms");
        assert!(error.contains(AuthType::Terms.as_str()));
    }

    #[tokio::test]
    async fn threads_the_homeserver_session_into_terms_auth() {
        let info = uiaa(json!({
            "flows": [{"stages": ["m.login.terms"]}],
            "session": "uia-session"
        }));

        let auth = registration_auth_data(
            RegistrationAuthResponse::AcceptTerms,
            AuthType::Terms.as_str(),
            &info,
            None,
        )
        .await
        .expect("terms auth");
        assert!(matches!(
            auth,
            AuthData::Terms(terms) if terms.session.as_deref() == Some("uia-session")
        ));
    }

    #[tokio::test]
    async fn registration_email_submits_the_token_and_threads_owned_credentials() {
        let server = MatrixMockServer::new().await;
        let client_secret = matrix_sdk::ruma::ClientSecret::new();
        let sid =
            serde_json::from_value(json!("registration-email-session")).expect("valid session id");
        Mock::given(method("POST"))
            .and(path("/validate/email/submitToken"))
            .and(body_partial_json(json!({
                "sid": "registration-email-session",
                "client_secret": client_secret,
                "token": "654321",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true})))
            .expect(1)
            .mount(server.server())
            .await;
        let info = uiaa(json!({
            "flows": [{"stages": ["m.login.email.identity"]}],
            "session": "uia-session"
        }));
        let mut validation = PendingRegistrationEmail {
            client_secret: client_secret.clone(),
            sid,
            submit_url: Some(
                url::Url::parse(&format!("{}/validate/email/submitToken", server.uri()))
                    .expect("submission URL"),
            ),
            homeserver: server.uri().parse().expect("homeserver URL"),
            submitted: false,
        };

        let auth = registration_auth_data(
            RegistrationAuthResponse::CompleteEmail {
                token: Some("654321".to_owned()),
            },
            AuthType::EmailIdentity.as_str(),
            &info,
            Some(&mut validation),
        )
        .await
        .expect("email auth");
        let serialized = serde_json::to_value(auth).expect("serialize email auth");
        assert_eq!(serialized["session"], "uia-session");
        assert_eq!(
            serialized["threepid_creds"]["sid"],
            "registration-email-session"
        );
        assert_eq!(
            serialized["threepid_creds"]["client_secret"],
            client_secret.as_str()
        );

        registration_auth_data(
            RegistrationAuthResponse::CompleteEmail { token: None },
            AuthType::EmailIdentity.as_str(),
            &info,
            Some(&mut validation),
        )
        .await
        .expect("a retry reuses the completed email validation");
    }

    #[tokio::test]
    async fn accepts_sessionless_direct_terms_and_dummy_auth() {
        let terms_info = uiaa(json!({"flows": [{"stages": ["m.login.terms"]}]}));
        let dummy_info = uiaa(json!({"flows": [{"stages": ["m.login.dummy"]}]}));

        assert!(matches!(
            registration_auth_data(
                RegistrationAuthResponse::AcceptTerms,
                AuthType::Terms.as_str(),
                &terms_info,
                None,
            )
            .await,
            Ok(AuthData::Terms(terms)) if terms.session.is_none()
        ));
        assert!(matches!(
            registration_auth_data(
                RegistrationAuthResponse::CompleteDummy,
                AuthType::Dummy.as_str(),
                &dummy_info,
                None,
            )
            .await,
            Ok(AuthData::Dummy(dummy)) if dummy.session.is_none()
        ));
    }

    #[test]
    fn exposes_only_http_policy_links() {
        let info = uiaa(json!({
            "flows": [{"stages": ["m.login.terms"]}],
            "params": {
                "m.login.terms": {
                    "policies": {
                        "privacy": {
                            "version": "2",
                            "en": {"name": "Privacy", "url": "https://example.org/privacy"},
                            "bad": {"name": "Bad", "url": "javascript:alert(1)"}
                        }
                    }
                }
            },
            "session": "uia-session"
        }));

        let policies = sanitized_registration_policies(&info);
        assert_eq!(policies.len(), 1);
        assert_eq!(policies[0].name, "Privacy");
        assert_eq!(policies[0].url, "https://example.org/privacy");
    }

    #[tokio::test]
    async fn fallback_url_preserves_a_homeserver_path_prefix() {
        let client = matrix_sdk::Client::builder()
            .homeserver_url("https://example.org/matrix/")
            .build()
            .await
            .expect("client");

        let url = registration_fallback_url(&client, AuthType::ReCaptcha.as_str(), "session value")
            .expect("fallback URL");
        assert_eq!(
            url,
            "https://example.org/matrix/_matrix/client/v3/auth/m.login.recaptcha/fallback/web?session=session+value"
        );
    }

    #[test]
    fn summarizes_login_types_and_provider_metadata() {
        let flows = login_flows(json!([
            {"type": "m.login.password"},
            {"type": "m.login.token", "get_login_token": false},
            {
                "type": "m.login.sso",
                "identity_providers": [
                    {"id": "oidc-github", "name": "GitHub", "brand": "github"},
                    {"id": "company", "name": "Company SSO"}
                ]
            }
        ]));

        let summary = summarize_login_flows(flows);
        assert!(summary.password);
        assert!(summary.token);
        assert!(summary.sso);
        assert_eq!(summary.identity_providers.len(), 2);
        assert_eq!(summary.identity_providers[0].id, "oidc-github");
        assert_eq!(
            summary.identity_providers[0].brand.as_deref(),
            Some("github")
        );
    }

    #[test]
    fn sanitizes_untrusted_identity_provider_labels() {
        let name = format!("Secure\u{202e}evil{}", "x".repeat(100));
        let sanitized = sanitized_provider_name(&name);
        assert!(!sanitized.contains('\u{202e}'));
        assert_eq!(sanitized.chars().count(), 80);
        assert_eq!(sanitized_provider_name("\u{200f}\n"), "Single sign-on");
        assert_eq!(
            sanitized_provider_name("\u{200b}\u{2060}\u{feff}"),
            "Single sign-on"
        );
    }

    #[test]
    fn caps_and_deduplicates_identity_providers() {
        let providers = (0..40)
            .map(|index| {
                json!({
                    "id": format!("provider-{index}"),
                    "name": format!("Provider {index}")
                })
            })
            .chain(std::iter::once(json!({
                "id": "provider-0",
                "name": "Duplicate"
            })))
            .collect::<Vec<_>>();
        let flows = login_flows(json!([{
            "type": "m.login.sso",
            "identity_providers": providers
        }]));

        let summary = summarize_login_flows(flows);
        assert_eq!(summary.identity_providers.len(), 32);
        assert_eq!(
            summary
                .identity_providers
                .iter()
                .filter(|provider| provider.id == "provider-0")
                .count(),
            1
        );
    }

    #[test]
    fn accepts_only_a_freshly_advertised_identity_provider() {
        let flows = login_flows(json!([{
            "type": "m.login.sso",
            "identity_providers": [{"id": "company", "name": "Company SSO"}]
        }]));

        assert!(identity_provider_is_advertised(&flows, "company"));
        assert!(!identity_provider_is_advertised(&flows, "forged"));
    }

    #[test]
    fn accepts_https_password_reset_submission_urls() {
        let homeserver = url::Url::parse("https://matrix.example/base/").expect("valid URL");

        assert_eq!(
            sanitize_password_reset_submit_url(
                &homeserver,
                Some("/_matrix/client/v3/validate/email/submitToken")
            )
            .expect("same-origin URL")
            .expect("submission URL")
            .as_str(),
            "https://matrix.example/_matrix/client/v3/validate/email/submitToken"
        );
        assert_eq!(
            sanitize_password_reset_submit_url(
                &homeserver,
                Some("https://identity.example/validate/email/submitToken")
            )
            .expect("delegated HTTPS URL")
            .expect("submission URL")
            .host_str(),
            Some("identity.example")
        );
        assert!(
            sanitize_password_reset_submit_url(&homeserver, Some("http://127.0.0.1/internal"))
                .is_err()
        );
    }

    #[test]
    fn rejects_non_public_password_reset_submission_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.1.2",
            "192.88.99.1",
            "198.51.100.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "64:ff9b:1::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !is_public_network_ip(address.parse().expect("valid IP")),
                "{address} must not be treated as public"
            );
        }
        assert!(is_public_network_ip(
            "1.1.1.1".parse().expect("valid public IP")
        ));
        assert!(is_public_network_ip(
            "2606:4700:4700::1111".parse().expect("valid public IP")
        ));
    }

    #[test]
    fn password_reset_challenge_exposes_no_matrix_session_or_client_secret() {
        let challenge = PasswordResetChallenge {
            attempt_id: "opaque-attempt".to_owned(),
            requires_token: true,
        };
        let json = serde_json::to_value(challenge).expect("serialize challenge");

        assert_eq!(json["attempt_id"], "opaque-attempt");
        assert_eq!(json["requires_token"], true);
        assert!(json.get("sid").is_none());
        assert!(json.get("client_secret").is_none());
    }

    #[tokio::test]
    async fn password_reset_mail_quota_survives_individual_attempts() {
        let state = MatrixState::default();
        for _ in 0..AUTH_MAILS_PER_ADDRESS {
            check_auth_mail_quota(&state, "Alice@Example.org", "https://example.org")
                .await
                .expect("within address quota");
        }
        assert!(
            check_auth_mail_quota(&state, "alice@example.org", "https://example.org")
                .await
                .is_err(),
            "normalized address quota must not reset with a new attempt"
        );
    }

    #[tokio::test]
    async fn password_reset_mail_quota_refunds_unsent_requests() {
        let state = MatrixState::default();
        let reservation = check_auth_mail_quota(&state, "alice@example.org", "https://example.org")
            .await
            .expect("initial reservation");
        refund_auth_mail_quota(&state, reservation).await;

        for _ in 0..AUTH_MAILS_PER_ADDRESS {
            check_auth_mail_quota(&state, "alice@example.org", "https://example.org")
                .await
                .expect("refunded reservation must not consume capacity");
        }
    }

    #[tokio::test]
    async fn password_reset_upstream_retry_deadline_is_homeserver_scoped() {
        let state = MatrixState::default();
        state
            .auth_mail_quota
            .lock()
            .await
            .upstream_retry_until_by_homeserver
            .insert(
                "https://server-a.example".to_owned(),
                std::time::Instant::now() + std::time::Duration::from_secs(60),
            );

        assert!(
            check_auth_mail_quota(&state, "alice@example.org", "https://server-a.example",)
                .await
                .is_err(),
            "the rate-limited homeserver must retain its deadline"
        );
        check_auth_mail_quota(&state, "alice@example.org", "https://server-b.example")
            .await
            .expect("an unrelated homeserver must remain available");
    }

    #[tokio::test]
    async fn password_reset_submits_the_email_token_then_changes_the_password() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let client_secret = matrix_sdk::ruma::ClientSecret::new();
        let sid = serde_json::from_value(json!("email-session")).expect("valid session id");

        Mock::given(method("POST"))
            .and(path("/validate/email/submitToken"))
            .and(body_partial_json(json!({
                "sid": "email-session",
                "client_secret": client_secret,
                "token": "123456",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true})))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/account/password"))
            .and(body_partial_json(json!({
                "new_password": "new correct horse",
                "auth": {
                    "type": "m.login.email.identity",
                    "threepid_creds": {
                        "sid": "email-session",
                        "client_secret": client_secret,
                    }
                }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;

        let mut pending = PendingPasswordReset {
            client,
            client_secret,
            sid,
            submit_url: Some(
                url::Url::parse(&format!("{}/validate/email/submitToken", server.uri()))
                    .expect("submit URL"),
            ),
            token_submitted: false,
            attempt_id: "opaque".to_owned(),
            created_at: std::time::Instant::now(),
        };
        complete_password_reset(&mut pending, Some("123456"), "new correct horse".to_owned())
            .await
            .expect("password reset completes");
    }
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

    // See `MatrixState::completing_sso_temp_store_keys`'s doc comment
    // (Codex review on #288, P2): tracks this store as still in flight from
    // here through every exit path below, closing the window `pending_sso`
    // being cleared just above would otherwise leave for the delayed sweep
    // pass to race. `struct`+`Drop`, not a `defer!`-style macro (this crate
    // has none) — removes itself on every return, including the early ones,
    // without needing a matching cleanup call at each site.
    //
    // Inserted here — *before* `drop(pending_sso)` below, still holding
    // that lock — not after it, which left an identical handoff gap one
    // level down: releasing the `pending_sso` guard can wake a sweep
    // waiting on that same lock on another worker thread, and if this
    // insertion hadn't happened yet, the sweep would see the key in
    // neither set (Codex review on #288, P2, same finding as
    // `start_sso_login`'s ordering fix, now applied to this function's own
    // internal handoff).
    struct SsoCompletionGuard<'a> {
        matrix_state: &'a MatrixState,
        store_key: String,
    }
    impl Drop for SsoCompletionGuard<'_> {
        fn drop(&mut self) {
            self.matrix_state
                .completing_sso_temp_store_keys
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.store_key);
        }
    }
    state
        .completing_sso_temp_store_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(pending.store_key.clone());
    let _completing_guard = SsoCompletionGuard {
        matrix_state: &state,
        store_key: pending.store_key.clone(),
    };

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
