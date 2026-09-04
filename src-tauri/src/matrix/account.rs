//! Account settings: logout, profile edit, password change, and account
//! deactivation.
//!
//! `ProfileSummary` is a small, independent read/write DTO for the settings
//! Account panel — the Profiles spec (Spec 01) hadn't merged its read-only
//! `get_own_profile`/`OwnProfile` model when this was written (see Spec 08's
//! "Dependencies & sequencing"). Align the two into one shared model once
//! Spec 01 lands; until then this module doesn't depend on it.

use matrix_sdk::ruma::api::client::account::change_password;
use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AccountManagementActionData;
use matrix_sdk::ruma::api::client::uiaa::{
    AuthData, MatrixUserIdentifier, Password, UserIdentifier,
};
use matrix_sdk::ruma::events::ignored_user_list::IgnoredUserListEventContent;
use matrix_sdk::ruma::{OwnedUserId, UserId};
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use ts_rs::TS;

use super::media;
use super::persistence;
use super::presence;
use super::shell;
use super::sync;
use super::MatrixState;

/// Square thumbnail size (px) requested when resolving a profile avatar's
/// `mxc://` URI to a local file for [`resolve_avatar`].
const AVATAR_THUMBNAIL_SIZE: u32 = 96;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct ProfileSummary {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    /// Whether this session was established via OAuth 2.0/OIDC (QR login;
    /// see `auth::start_qr_login`) rather than the classic `matrix_auth()`
    /// login API (password or SSO). `change_password`/`deactivate_account`
    /// only ever retry UIA with `AuthData::Password`, which an OIDC-managed
    /// account's homeserver has no obligation to accept (account
    /// management for those is typically delegated to the OIDC provider
    /// instead) — the frontend uses this to hide actions that can't
    /// succeed rather than let them fail confusingly.
    pub uses_oauth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct ThirdPartyIdSummary {
    pub medium: String,
    pub address: String,
}

/// The account's confirmed email/phone contact methods, for the Account
/// panel's Contact Information section (Spec 18) — a thin read-only
/// projection of `get_3pids`' `medium`/`address` fields; the homeserver-side
/// add/remove flow (email verification tokens, etc.) is Day-2 (see Spec 18's
/// non-goals; only display is in scope here).
#[tauri::command]
pub async fn get_3pids(state: State<'_, MatrixState>) -> Result<Vec<ThirdPartyIdSummary>, String> {
    let client = state.require_client().await?;
    let response = client
        .account()
        .get_3pids()
        .await
        .map_err(|e| e.to_string())?;
    Ok(response
        .threepids
        .into_iter()
        .map(|t| ThirdPartyIdSummary {
            medium: t.medium.to_string(),
            address: t.address,
        })
        .collect())
}

/// Reads the account's `m.ignored_user_list` account data event directly
/// (rather than `Client::subscribe_to_ignore_user_list_changes`, which only
/// yields a value on the next change, not the current one) — same pattern
/// as `matrix_sdk::Account::ignore_user`'s own internal lookup.
pub async fn ignored_user_ids(client: &Client) -> Result<Vec<OwnedUserId>, String> {
    let content = client
        .account()
        .account_data::<IgnoredUserListEventContent>()
        .await
        .map_err(|e| e.to_string())?;
    let Some(raw) = content else {
        return Ok(Vec::new());
    };
    let content = raw.deserialize().map_err(|e| e.to_string())?;
    Ok(content.ignored_users.into_keys().collect())
}

#[tauri::command]
pub async fn get_ignored_users(state: State<'_, MatrixState>) -> Result<Vec<String>, String> {
    let client = state.require_client().await?;
    Ok(ignored_user_ids(&client)
        .await?
        .into_iter()
        .map(|id| id.to_string())
        .collect())
}

#[tauri::command]
pub async fn ignore_user(state: State<'_, MatrixState>, user_id: String) -> Result<(), String> {
    let client = state.require_client().await?;
    let user_id = <&UserId>::try_from(user_id.as_str()).map_err(|e| e.to_string())?;
    client
        .account()
        .ignore_user(user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unignore_user(state: State<'_, MatrixState>, user_id: String) -> Result<(), String> {
    let client = state.require_client().await?;
    let user_id = <&UserId>::try_from(user_id.as_str()).map_err(|e| e.to_string())?;
    client
        .account()
        .unignore_user(user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Structured error for the four UIA-gated settings commands
/// (`change_password`, `deactivate_account`, `delete_device`,
/// `bootstrap_cross_signing`), carrying the UIA-vs-other distinction
/// `retry_uia_with_session` already computes across the Tauri IPC boundary.
///
/// `UiaChallenge` means the homeserver wants re-authentication — the
/// frontend should prompt for a password and retry. `Other` means a real,
/// unrelated failure (network error, 500, "not logged in", etc.) — the
/// frontend should surface it as-is, not treat it as a password prompt.
///
/// Deliberately minimal (two variants) rather than a general error taxonomy
/// — resist splitting `Other` further (e.g. network vs. server error) unless
/// a concrete frontend need shows up.
#[derive(Debug, Serialize, TS)]
#[serde(tag = "kind")]
#[ts(export, export_to = "../src/bindings/")]
pub enum UiaCommandError {
    UiaChallenge,
    Other { message: String },
}

impl From<String> for UiaCommandError {
    fn from(message: String) -> Self {
        UiaCommandError::Other { message }
    }
}

/// Runs a UIA-gated `call` (`change_password`/`deactivate`/`delete_devices`),
/// threading a real session id through the retry when `password` is given.
///
/// The frontend contract stays a plain two-call retry ("call with no
/// password" -> show a prompt on error -> "call again with the password"),
/// but a `Password` built with `session: None` risks being treated as a
/// fresh, unauthenticated UIA attempt on a homeserver that enforces session
/// continuity across stages (Synapse tolerates it; the spec doesn't
/// guarantee every server will). So when `password` is present, this probes
/// with an auth-less call first to obtain the session id tied to *this*
/// attempt, then retries with that session attached — one extra round trip,
/// hidden from the frontend, in exchange for spec-correct UIA behavior.
pub(crate) async fn retry_uia_with_session<T, F, Fut>(
    user_id: &UserId,
    password: Option<String>,
    mut call: F,
) -> Result<T, UiaCommandError>
where
    F: FnMut(Option<AuthData>) -> Fut,
    Fut: std::future::Future<Output = matrix_sdk::Result<T>>,
{
    let Some(password) = password else {
        return call(None).await.map_err(|e| match e.as_uiaa_response() {
            Some(_) => UiaCommandError::UiaChallenge,
            None => UiaCommandError::Other {
                message: e.to_string(),
            },
        });
    };

    let session = match call(None).await {
        Ok(value) => return Ok(value),
        Err(e) => match e.as_uiaa_response() {
            Some(info) => info.session.clone(),
            // Not a UIA challenge at all (network error, 500, etc.) — retrying
            // with a password would just produce a second, unrelated failure
            // that the frontend can only render as "incorrect password",
            // masking what actually went wrong.
            None => {
                return Err(UiaCommandError::Other {
                    message: e.to_string(),
                })
            }
        },
    };

    let mut auth = Password::new(
        UserIdentifier::Matrix(MatrixUserIdentifier::new(user_id.to_string())),
        password,
    );
    auth.session = session;
    call(Some(AuthData::Password(auth)))
        .await
        .map_err(|e| UiaCommandError::Other {
            message: e.to_string(),
        })
}

#[derive(Clone, Copy)]
enum SearchCleanupScope {
    CurrentDevice,
    EntireAccount,
}

/// Shared ownership of one acquired login-exclusion lock, not another mutex.
type TeardownGuard = std::sync::Arc<tokio::sync::OwnedMutexGuard<()>>;

/// Both the command and any blocking worker retain login exclusion. Aborting
/// the command cannot unlock a still-running filesystem cleanup, and a worker
/// failure cannot unlock the command's remaining recovery steps.
async fn run_account_cleanup<T, F>(
    guard: TeardownGuard,
    cleanup: F,
) -> Result<T, tokio::task::JoinError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        cleanup()
    })
    .await
}

async fn begin_session_teardown(state: &MatrixState) -> Result<(TeardownGuard, Client), String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;
    let device_id = client
        .device_id()
        .ok_or_else(|| "not logged in".to_string())?;
    let guard = std::sync::Arc::clone(&state.login_completion_lock)
        .lock_owned()
        .await;
    let active = state.require_client().await?;
    require_confirmed_session(
        user_id.as_str(),
        device_id.as_str(),
        active.user_id().map(|id| id.as_str()),
        active.device_id().map(|id| id.as_str()),
    )
    .map_err(|_| "session changed; retry the account action".to_string())?;
    Ok((std::sync::Arc::new(guard), client))
}

/// Clears session credentials and in-memory state, retaining the SDK store for
/// ordinary logout. The caller holds login exclusion through any later wipe.
async fn clear_local_session_locked(
    app: &AppHandle,
    state: &State<'_, MatrixState>,
    completion_guard: &TeardownGuard,
    user_id: &str,
    search_cleanup_scope: SearchCleanupScope,
) -> Result<(), String> {
    let account_key = persistence::account_key(user_id);
    // Keep this authenticated session available until its pusher has been
    // removed. Otherwise a failed deletion cannot be retried after local
    // credentials are discarded, and a later reuse of the device token can
    // revive delivery for the signed-out account.
    crate::push::unregister_push_impl(app, state)
        .await
        .map_err(|_| {
            "Could not disable notifications before sign-out; retry when online.".to_string()
        })?;
    let tombstone_result = persistence::mark_logout_tombstone(app, &account_key);
    let search_device_id = state
        .require_client()
        .await
        .ok()
        .and_then(|client| client.device_id().map(ToString::to_string));

    let matrix_result = persistence::clear_session(&account_key);
    let oauth_result = persistence::clear_oauth_session(&account_key);
    // If neither durable veto nor complete credential deletion succeeded,
    // retain the live shell so the user can see and retry the failed logout.
    let durable = logout_is_durable(
        tombstone_result.is_ok(),
        matrix_result.is_ok(),
        oauth_result.is_ok(),
    );
    let mut credential_error =
        clear_logout_credentials(tombstone_result, || matrix_result, || oauth_result);
    if retain_session_after_failed_logout(search_cleanup_scope, durable) {
        return Err(
            "Could not persist sign-out. Your session remains open; retry signing out.".into(),
        );
    }

    // Cleared *before* the awaited teardown below, not after: `state.client`
    // is what `MatrixState::require_client` hands to any other Tauri command
    // that happens to run concurrently, and by this point the persisted
    // session those two `clear_*` calls just deleted is already gone — a
    // command that grabbed the old client during the (now-multi-await)
    // teardown window would let the signed-out account keep sending/fetching
    // until the next launch.
    *state.client.lock().await = None;
    super::search::reset_index_lifecycle(state);

    // The sync loop drives the native dock/taskbar/tray badge from its own
    // snapshots (Spec 10) — stopping it below zeroes the client but doesn't
    // itself zero the badge. Without this, a sign-out with unread rooms
    // leaves the last nonzero badge showing on the login screen, and
    // potentially into the next signed-in account until its first sync.
    let _ = shell::apply_native_badge(app, 0);

    // `sync::abort_current_sync_loop` (not a bespoke abort here) — genuinely
    // stops and *awaits* the sync loop, the detached presence-report task,
    // and every live timeline listener (and redundantly re-clears
    // `state.client`, already `None` above — harmless). A plain
    // `handle.abort()` without awaiting (what this used to do) left the
    // aborted task possibly still unwinding — holding its own `Client` clone,
    // and the store's open file handles under it — if the user immediately
    // logged back in: a fresh login's relocation would find the sync-loop
    // slot already empty (this function had taken it) and have nothing left
    // to await, but the task itself could still be running.
    sync::abort_current_sync_loop(app).await;
    // The sync task is one of the writers of the process-wide room-upgrade
    // barrier sets. Clear only after its awaited shutdown so an in-flight
    // authoritative details refresh cannot repopulate old-account state
    // behind this cleanup and leak it into the next session.
    super::actions::clear_room_upgrade_queue_barriers().await;

    // `sync_presence` is read fresh by `sync::spawn_sync_loop` on every
    // iteration and isn't tied to any particular client — without resetting
    // it, a different account logging in next (in the same app process)
    // would have its very first syncs report whatever presence this account
    // last set (e.g. Unavailable/Offline), even though login itself tries to
    // set presence online.
    *state
        .sync_presence
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = presence::PresenceStateDto::default();

    // Neither is tied to any particular client either — without resetting
    // them, signing into a different account in the same process would have
    // `get_push_status` report the previous account's registration as still
    // active, and `unregister_push` would try to delete the new account's
    // (nonexistent) pusher using the old account's endpoint instead of
    // registering its own.
    *state
        .push_transport
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    *state.push_status.lock().unwrap_or_else(|e| e.into_inner()) =
        crate::push::PushStatus::default();

    let search_index = std::sync::Arc::clone(&state.search_index);
    let search_account_key = account_key.clone();
    let cleanup = match app.path().app_data_dir() {
        Ok(app_data_dir) => {
            run_account_cleanup(std::sync::Arc::clone(completion_guard), move || {
                let active = search_index
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take();
                let mut first_error = None;
                if let Some(active) = active {
                    if let Err(error) = active.index.delete() {
                        first_error = Some(error);
                    }
                }
                let scoped_cleanup = match search_cleanup_scope {
                    SearchCleanupScope::CurrentDevice => {
                        if let Some(device_id) = search_device_id {
                            super::search::SearchIndex::delete_for_source(
                                &app_data_dir,
                                &search_account_key,
                                &device_id,
                            )
                        } else {
                            Ok(())
                        }
                    }
                    SearchCleanupScope::EntireAccount => {
                        super::search::SearchIndex::delete_for_account(
                            &app_data_dir,
                            &search_account_key,
                        )
                    }
                };
                if let Err(error) = scoped_cleanup {
                    first_error.get_or_insert(error);
                }
                match first_error {
                    Some(error) => Err(error),
                    None => Ok(()),
                }
            })
            .await
            .is_ok_and(|result| result.is_ok())
        }
        Err(_) => false,
    };
    if !cleanup {
        tracing::warn!(command = "message_search_logout", status = "cleanup_failed");
    }
    if credential_error.is_none() && cleanup {
        if let Err(error) = persistence::clear_logout_tombstone(app, &account_key) {
            credential_error = Some(error);
        }
    }
    if let Some(error) = credential_error {
        // The active client is already gone. Notify the renderer even though
        // the initiating command rejects, while the durable marker (when it
        // could be written) owns startup retry.
        let _ = app.emit("session:invalidated", ());
        return Err(error);
    }
    // The session is already gone even if a caller's subsequent physical
    // store cleanup fails (notably remote account deactivation). Publish
    // invalidation before releasing login exclusion rather than relying on
    // the initiating command eventually returning success to the renderer.
    let _ = app.emit("session:invalidated", ());
    Ok(())
}

/// Signs the current session out: best-effort server-side revoke (an
/// unreachable homeserver must not block clearing the local session — see
/// Spec 08 acceptance criterion 2 — so this backgrounds the revoke instead of
/// awaiting it; the client HTTP stack has no bounded timeout of its own, so
/// awaiting it inline could hang the command for as long as the OS-level TCP
/// timeout on a homeserver that's merely unreachable rather than promptly
/// refusing), then unconditionally clears both keychain session entries and
/// drops the client so a relaunch doesn't auto-restore.
#[tauri::command]
pub async fn logout(app: AppHandle, state: State<'_, MatrixState>) -> Result<(), String> {
    // Revalidate the requested target after excluding login completion so an
    // old request cannot clear a replacement client.
    let (completion_guard, client) = begin_session_teardown(&state).await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();

    let result = clear_local_session_locked(
        &app,
        &state,
        &completion_guard,
        user_id.as_str(),
        SearchCleanupScope::CurrentDevice,
    )
    .await;
    if state.client.lock().await.is_none() {
        tokio::spawn(async move {
            if client.matrix_auth().logged_in() {
                let _ = client.matrix_auth().logout().await;
            } else {
                let _ = client.oauth().logout().await;
            }
        });
    }
    result
}

/// Explicit device wipe for the active account. Unlike ordinary logout this
/// removes the retained matrix-sdk store, its keychain passphrase, and every
/// device-scoped search index for the account. Cleanup intent is recorded
/// before the session closes so a filesystem/keychain failure is retried at
/// startup instead of leaving an unexplained restorable account behind.
#[tauri::command]
pub async fn forget_local_data(
    app: AppHandle,
    state: State<'_, MatrixState>,
    confirmed: bool,
) -> Result<(), String> {
    require_local_data_confirmation(confirmed)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "application data directory unavailable".to_string())?;
    if !crate::feature_flags::flag(
        &app_data_dir,
        crate::feature_flags::FeatureFlagKey::ForgetLocalData,
    ) {
        return Err("forget local data is unavailable".to_string());
    }
    // Capture the session before showing the dialog, without blocking login
    // completion while waiting for the user to respond.
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let device_id = client
        .device_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let (confirmation_tx, confirmation_rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(
            "Permanently remove this account's retained Matrix store, cached encryption keys, and encrypted search indexes from this device?",
        )
        .title("Forget local data")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Forget local data".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |accepted| {
            let _ = confirmation_tx.send(accepted);
        });
    if !confirmation_rx.await.unwrap_or(false) {
        return Err("local data deletion was cancelled".to_string());
    }
    // Match login/headless-push lock order and exclude store users through
    // physical deletion, including a blocking worker after caller cancellation.
    let restore_guard = std::sync::Arc::new(super::auth::restore_store_lock().lock().await);
    // Keep this lock through physical deletion: a new login must not install
    // a store underneath the wipe after the old client has been cleared.
    let completion_guard = std::sync::Arc::new(
        std::sync::Arc::clone(&state.login_completion_lock)
            .lock_owned()
            .await,
    );
    let active = state.require_client().await?;
    require_confirmed_session(
        user_id.as_str(),
        device_id.as_str(),
        active.user_id().map(|id| id.as_str()),
        active.device_id().map(|id| id.as_str()),
    )?;
    drop(active);
    let account_key = persistence::account_key(user_id.as_str());

    persistence::mark_cancelled_account_cleanup(&app, &account_key)?;
    let teardown_result = clear_local_session_locked(
        &app,
        &state,
        &completion_guard,
        user_id.as_str(),
        SearchCleanupScope::EntireAccount,
    )
    .await;

    // A detached revoke would retain SDK store handles during physical
    // deletion (particularly problematic on Windows). This bounded attempt
    // owns and drops our last client handle before filesystem cleanup starts.
    revoke_before_local_wipe(client, std::time::Duration::from_secs(5)).await;

    let cleanup_app = app.clone();
    let cleanup_account_key = account_key.clone();
    let cleanup = async {
        let worker_restore_guard = std::sync::Arc::clone(&restore_guard);
        run_account_cleanup(std::sync::Arc::clone(&completion_guard), move || {
            let _restore_guard = worker_restore_guard;
            let mut first_error = None;
            if let Err(error) =
                persistence::discard_cancelled_account_session(&cleanup_app, &cleanup_account_key)
            {
                first_error = Some(error);
            }
            if let Err(error) =
                super::search::SearchIndex::delete_for_account(&app_data_dir, &cleanup_account_key)
            {
                first_error.get_or_insert(error);
            }
            match first_error {
                Some(error) => Err(error),
                None => persistence::clear_cancelled_account_cleanup_marker(
                    &cleanup_app,
                    &cleanup_account_key,
                ),
            }
        })
        .await
        .map_err(|_| "local account cleanup task failed".to_string())
        .and_then(|result| result)
    };
    finish_local_wipe_cleanup(teardown_result, cleanup).await
}

async fn finish_local_wipe_cleanup(
    teardown: Result<(), String>,
    cleanup: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    // Teardown already closed the session. Its error must not prevent the
    // account-wide physical wipe from making progress under login exclusion.
    let cleanup = cleanup.await;
    if teardown.is_err() || cleanup.is_err() {
        tracing::warn!(command = "forget_local_data", status = "cleanup_pending");
    }
    teardown.and(cleanup)
}

async fn revoke_before_local_wipe(client: Client, timeout: std::time::Duration) {
    let _ = tokio::time::timeout(timeout, async move {
        if client.matrix_auth().logged_in() {
            let _ = client.matrix_auth().logout().await;
        } else {
            let _ = client.oauth().logout().await;
        }
    })
    .await;
}

fn require_local_data_confirmation(confirmed: bool) -> Result<(), String> {
    confirmed
        .then_some(())
        .ok_or_else(|| "local data deletion requires confirmation".to_string())
}

fn require_confirmed_session(
    user_id: &str,
    device_id: &str,
    active_user_id: Option<&str>,
    active_device_id: Option<&str>,
) -> Result<(), String> {
    if active_user_id == Some(user_id) && active_device_id == Some(device_id) {
        Ok(())
    } else {
        Err("session changed; confirm local data deletion again".to_string())
    }
}

#[tauri::command]
pub async fn get_profile(state: State<'_, MatrixState>) -> Result<ProfileSummary, String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let display_name = client
        .account()
        .get_display_name()
        .await
        .map_err(|e| e.to_string())?;
    let avatar_url = client
        .account()
        .get_avatar_url()
        .await
        .map_err(|e| e.to_string())?;

    Ok(ProfileSummary {
        user_id: user_id.to_string(),
        display_name,
        avatar_url: avatar_url.map(|url| url.to_string()),
        uses_oauth: client.oauth().user_session().is_some(),
    })
}

/// The OIDC account-management URL for a given action, if the homeserver
/// advertises one — `None` for a plain password/SSO session (no OIDC
/// provider at all) or if the homeserver's auth metadata doesn't advertise
/// the action. Shared by every "this in-app flow can't work for an
/// OAuth-managed account, so point at their provider instead" command (see
/// `devices::get_cross_signing_reset_url`, `get_account_deactivate_url`,
/// `devices::get_device_delete_url`) — the frontend only offers those
/// URL-backed links when this is `Some`; per Spec 08, the flows themselves
/// are never reimplemented in-app.
pub(crate) async fn account_management_url(
    client: &Client,
    action: AccountManagementActionData<'_>,
) -> Option<String> {
    if client.matrix_auth().logged_in() {
        return None;
    }

    let metadata = client.oauth().server_metadata().await.ok()?;
    metadata
        .account_management_url_with_action(action)
        .map(|url| url.to_string())
}

/// See [`account_management_url`] — `None` for a non-OAuth session, hiding
/// the in-app "Deactivate account" action makes no sense for: the password-
/// only UIA retry `deactivate_account` uses can't ever satisfy an
/// OAuth-managed account's challenge.
#[tauri::command]
pub async fn get_account_deactivate_url(
    state: State<'_, MatrixState>,
) -> Result<Option<String>, String> {
    let client = state.require_client().await?;
    Ok(account_management_url(&client, AccountManagementActionData::AccountDeactivate).await)
}

/// Resolves `ProfileSummary.avatar_url` (a bare `mxc://` URI — never
/// webview-loadable directly) to a local, `convertFileSrc`-able filesystem
/// path, same convention as `mod::resolve_media`. `None` on any resolution
/// failure (e.g. no media cache available), so the frontend can fall back to
/// the initials placeholder rather than showing a broken image.
#[tauri::command]
pub async fn resolve_avatar(
    app: AppHandle,
    state: State<'_, MatrixState>,
    mxc_url: String,
) -> Result<Option<String>, String> {
    let client = state.require_client().await?;
    let Ok(cache) = state.require_media_cache(&app).await else {
        return Ok(None);
    };
    Ok(
        media::resolve_avatar_thumbnail(cache, &client, &mxc_url, AVATAR_THUMBNAIL_SIZE)
            .await
            .map(|path| path.to_string_lossy().into_owned()),
    )
}

#[tauri::command]
pub async fn set_display_name(
    state: State<'_, MatrixState>,
    display_name: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    client
        .account()
        .set_display_name(display_name.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Defense-in-depth cap on avatar uploads: comfortably above any real photo
/// (a raw 4000x4000 RGBA frame is ~64MB) while bounding how much a bogus
/// `file_path` could make this command read into memory and ship off to the
/// homeserver.
const MAX_AVATAR_BYTES: u64 = 20 * 1024 * 1024;

/// Sane per-side pixel ceiling checked against the *decoded* dimensions
/// before the full decode happens. A compressed file well under
/// `MAX_AVATAR_BYTES` can still decode to a huge `DynamicImage` (a
/// decompression bomb) — e.g. a tiny, highly-compressible PNG that unpacks
/// to tens of thousands of pixels per side. No UI anywhere in this app
/// (`src/components/ui/avatar.tsx`'s largest size, or the room/profile
/// settings avatar previews) ever displays an avatar above a few hundred
/// pixels per side, so 2048px per side is already a generous multiple of
/// any real use case while bounding worst-case decoded memory to roughly
/// 2048*2048*4 bytes (~16MB) — small enough to not be a meaningful DoS
/// risk even on memory-constrained builds (this is a Tauri app with
/// Android/iOS targets), unlike the previous 8192px cap (~256MB worst
/// case).
const MAX_AVATAR_DIMENSION: u32 = 2048;

/// Formats the avatar picker in `RoomSettingsForm`/profile settings actually
/// offers. Kept as an explicit allowlist — rather than just checking
/// "does this decode at all" — as a hedge against `image`'s enabled-decoder
/// set changing out from under this check. Verified empirically that in
/// this crate's own build (`cargo build`/`test`/`clippy` from `src-tauri/`,
/// matching what CI runs) only `gif,jpeg,png,webp` are compiled in per
/// `cargo tree -f "{p} {f}" -i image`, since Cargo only unifies features
/// among crates in the same build invocation's resolved graph and
/// `crates/charm-web-server` (which depends on plain `image = "0.25"`,
/// pulling in its much larger `default-formats` set) isn't a dependency of
/// this package. That isolation is a property of how these two crates are
/// built today, not a language guarantee — a future change that builds them
/// together (e.g. `cargo build --workspace`) could unify features and widen
/// what `image::guess_format`/`load_from_memory_with_format` accept here.
/// Without this allowlist, a file in one of those other formats (TIFF/BMP/
/// ICO/AVIF/QOI/...) would then decode successfully yet not be renderable by
/// every Matrix client that fetches the resulting `mxc://` avatar.
const ALLOWED_AVATAR_FORMATS: [image::ImageFormat; 4] = [
    image::ImageFormat::Png,
    image::ImageFormat::Jpeg,
    image::ImageFormat::Gif,
    image::ImageFormat::WebP,
];

/// Validates that `file_path` is safe to read and upload as an avatar:
/// resolves symlinks to a real file on disk, isn't implausibly large either
/// on disk or decoded, and decodes as one of the image formats the picker in
/// `RoomSettingsForm`/profile settings offers (png/jpeg/gif/webp). Returns
/// the canonical path, original bytes, and detected MIME type on success.
///
/// This command has no Tauri fs-plugin capability backing it (see
/// `src-tauri/capabilities/default.json` — there is no `fs:*` permission),
/// so the filesystem read here is raw and unscoped on the Rust side;
/// nothing at the IPC/capability layer limits which paths it can touch.
/// Today `file_path` only ever comes from a native file-picker dialog, so
/// this isn't reachable by an attacker yet, but if some other bug (e.g. an
/// XSS in the webview) ever let `invoke("set_avatar", { file_path })` be
/// called with an arbitrary path, this is what stands between that call and
/// reading arbitrary files (e.g. `~/.ssh/id_rsa`) off the user's disk and
/// uploading them as the account avatar. Validating the *decoded* image
/// content (not just the extension or a `mime_guess` off the file name)
/// means a renamed non-image file is rejected too.
///
/// Shared with `room_admin::set_room_avatar_impl`, which uploads a room
/// avatar from the same kind of frontend-supplied file-picker path — same
/// validation needs to apply there too, not just to the account avatar.
pub(crate) async fn validate_avatar_path(
    file_path: &str,
) -> Result<(std::path::PathBuf, Vec<u8>, mime_guess::Mime), String> {
    use tokio::io::AsyncReadExt;

    let path = tokio::fs::canonicalize(file_path)
        .await
        .map_err(|e| format!("invalid avatar path: {e}"))?;

    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("invalid avatar path: {e}"))?;
    if !metadata.is_file() {
        return Err("avatar path is not a regular file".to_string());
    }
    if metadata.len() > MAX_AVATAR_BYTES {
        return Err(format!(
            "avatar file is too large ({} bytes, max {MAX_AVATAR_BYTES})",
            metadata.len()
        ));
    }

    // Re-check the cap against what's actually read rather than trusting the
    // `metadata.len()` check above alone: the file on disk could change
    // between that stat and this read (TOCTOU), so cap the read itself at
    // one byte over the limit and reject if it's hit.
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    file.take(MAX_AVATAR_BYTES + 1)
        .read_to_end(&mut data)
        .await
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_AVATAR_BYTES {
        return Err(format!(
            "avatar file is too large (max {MAX_AVATAR_BYTES} bytes)"
        ));
    }

    let format = image::guess_format(&data)
        .map_err(|_| "avatar file is not a recognized image format".to_string())?;
    if !ALLOWED_AVATAR_FORMATS.contains(&format) {
        return Err("avatar file is not a supported image format".to_string());
    }

    // Peek dimensions before the full decode below: a small, highly
    // compressible file can still decode into a huge `DynamicImage`, so
    // reject implausible dimensions before paying for that allocation.
    let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(&data), format)
        .into_dimensions()
        .map_err(|_| "avatar file is not a valid image".to_string())?;
    if width > MAX_AVATAR_DIMENSION || height > MAX_AVATAR_DIMENSION {
        return Err(format!(
            "avatar image dimensions are too large ({width}x{height}, max {MAX_AVATAR_DIMENSION}px per side)"
        ));
    }

    image::load_from_memory_with_format(&data, format)
        .map_err(|_| "avatar file is not a valid image".to_string())?;
    let mime: mime_guess::Mime = format
        .to_mime_type()
        .parse()
        .map_err(|_| "avatar file has an unsupported image format".to_string())?;

    Ok((path, data, mime))
}

/// Reads `file_path` off disk and uploads it as the account avatar, setting
/// it as the current `m.room` avatar url in one step — `Account::upload_avatar`
/// does both. Same file-path-in, read-on-the-Rust-side convention as
/// `send::send_attachment` rather than passing raw bytes over IPC.
#[tauri::command]
pub async fn set_avatar(state: State<'_, MatrixState>, file_path: String) -> Result<(), String> {
    let client = state.require_client().await?;
    let (_path, data, mime) = validate_avatar_path(&file_path).await?;

    client
        .account()
        .upload_avatar(&mime, data)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remove_avatar(state: State<'_, MatrixState>) -> Result<(), String> {
    let client = state.require_client().await?;
    client
        .account()
        .set_avatar_url(None)
        .await
        .map_err(|e| e.to_string())
}

/// UIA-gated: the first call (no `password`) always fails with a UIA
/// challenge — see [`retry_uia_with_session`]. Sends the raw request rather
/// than going through `Account::change_password` (which hardcodes Ruma's
/// `logout_devices: true` default): this is meant as a routine credential
/// rotation, not an "I think my account is compromised, kick everyone else
/// off" action, so it must not silently sign out every other device — that
/// needs to be its own explicit choice, not a side effect of changing your
/// password.
#[tauri::command]
pub async fn change_password(
    state: State<'_, MatrixState>,
    new_password: String,
    password: Option<String>,
) -> Result<(), UiaCommandError> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();

    retry_uia_with_session(&user_id, password, |auth| {
        let client = client.clone();
        let new_password = new_password.clone();
        async move {
            let mut request = change_password::v3::Request::new(new_password);
            request.logout_devices = false;
            request.auth = auth;
            client.send(request).await.map_err(matrix_sdk::Error::from)
        }
    })
    .await
    .map(|_| ())
}

/// UIA-gated, same retry convention as [`change_password`]. Tears down the
/// local session identically to [`logout`] on success — the account no
/// longer exists server-side, so there's nothing left to restore.
/// `erase_data` is always `false`: Secure Backup / content erasure is Day-2
/// scope (see Spec 08 non-goals).
#[tauri::command]
pub async fn deactivate_account(
    app: AppHandle,
    state: State<'_, MatrixState>,
    password: Option<String>,
) -> Result<(), UiaCommandError> {
    let restore_guard = std::sync::Arc::new(super::auth::restore_store_lock().lock().await);
    // Remote deactivation and local deletion form one session transition.
    // A UIA challenge returns from this call (releasing the lock); we never
    // retain it while the user is entering a password between requests.
    let (completion_guard, client) = begin_session_teardown(&state).await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let account = client.account();

    retry_uia_with_session(&user_id, password, |auth| {
        account.deactivate(None, auth, false)
    })
    .await?;

    // Release our SDK handles before attempting to remove its store files.
    drop(account);
    drop(client);

    let account_key = persistence::account_key(user_id.as_str());
    let marker_error = persistence::mark_cancelled_account_cleanup(&app, &account_key).err();
    let teardown_result = clear_local_session_locked(
        &app,
        &state,
        &completion_guard,
        user_id.as_str(),
        SearchCleanupScope::EntireAccount,
    )
    .await;

    // The remote account is gone, so unlike ordinary logout there is no
    // reason to retain the SDK store. Attempt physical removal now; either
    // the primary or fallback cancelled-account marker keeps startup
    // fail-closed and owns full-store retry after a partial failure.
    let cleanup_app = app.clone();
    let cleanup_account_key = account_key.clone();
    let worker_restore_guard = std::sync::Arc::clone(&restore_guard);
    let cleanup_result = run_account_cleanup(std::sync::Arc::clone(&completion_guard), move || {
        let _restore_guard = worker_restore_guard;
        let store_result =
            persistence::discard_cancelled_account_session(&cleanup_app, &cleanup_account_key);
        let search_result = cleanup_app
            .path()
            .app_data_dir()
            .map_err(|_| "application data directory unavailable".to_string())
            .and_then(|dir| {
                super::search::SearchIndex::delete_for_account(&dir, &cleanup_account_key)
            });
        // Attempt both independent targets before propagating either failure.
        // Full-wipe retry intent must outlive a failed search-index deletion.
        store_result.and(search_result)?;
        persistence::clear_cancelled_account_cleanup_marker(&cleanup_app, &cleanup_account_key)
    })
    .await
    .map_err(|_| "local account cleanup task failed".to_string())
    .and_then(|result| result);

    if let Some(error) = marker_error {
        // `clear_local_session` may have completed its own logout marker.
        // Re-establish durable account-wide retry intent before surfacing
        // the original marker failure from this already-deactivated account.
        persistence::mark_cancelled_account_cleanup(&app, &account_key)
            .map_err(UiaCommandError::from)?;
        let _ = app.emit("session:invalidated", ());
        return Err(UiaCommandError::from(error));
    }
    teardown_result.map_err(UiaCommandError::from)?;
    cleanup_result.map_err(UiaCommandError::from)
}

// Marker persistence and both credential stores are independent cleanup
// opportunities. A filesystem failure must not skip working keychain deletion.
pub(crate) fn logout_is_durable(marked: bool, matrix_cleared: bool, oauth_cleared: bool) -> bool {
    marked || (matrix_cleared && oauth_cleared)
}

fn retain_session_after_failed_logout(scope: SearchCleanupScope, durable: bool) -> bool {
    // EntireAccount is reached only after a durable full-wipe marker or a
    // successful remote deactivation. Neither flow may keep a client alive
    // while its caller deletes the SDK store, even if the separate logout
    // tombstone/keychain cleanup failed. Ordinary logout remains retryable.
    matches!(scope, SearchCleanupScope::CurrentDevice) && !durable
}

pub(super) fn clear_logout_credentials(
    marker: Result<(), String>,
    clear_matrix: impl FnOnce() -> Result<(), String>,
    clear_oauth: impl FnOnce() -> Result<(), String>,
) -> Option<String> {
    let mut error = marker.err();
    for result in [clear_matrix(), clear_oauth()] {
        if let Err(failure) = result {
            error.get_or_insert(failure);
        }
    }
    error
}

#[cfg(test)]
mod tests {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, ResponseTemplate};

    use super::*;

    #[test]
    fn logout_needs_a_durable_restore_veto_or_all_credentials_removed() {
        for matrix_cleared in [false, true] {
            for oauth_cleared in [false, true] {
                assert!(logout_is_durable(true, matrix_cleared, oauth_cleared));
                assert_eq!(
                    logout_is_durable(false, matrix_cleared, oauth_cleared),
                    matrix_cleared && oauth_cleared
                );
            }
        }
    }

    #[test]
    fn marked_wipe_and_deactivation_always_release_the_live_client() {
        for durable in [false, true] {
            assert!(!retain_session_after_failed_logout(
                SearchCleanupScope::EntireAccount,
                durable
            ));
            assert_eq!(
                retain_session_after_failed_logout(SearchCleanupScope::CurrentDevice, durable),
                !durable
            );
        }
    }

    #[tokio::test]
    async fn physical_wipe_runs_after_teardown_failure_and_reports_both_outcomes() {
        for teardown_fails in [false, true] {
            for cleanup_fails in [false, true] {
                let ran = std::cell::Cell::new(false);
                let teardown = if teardown_fails {
                    Err("teardown failed".to_string())
                } else {
                    Ok(())
                };
                let result = finish_local_wipe_cleanup(teardown, async {
                    ran.set(true);
                    if cleanup_fails {
                        Err("cleanup failed".to_string())
                    } else {
                        Ok(())
                    }
                })
                .await;
                assert!(ran.get());
                assert_eq!(result.is_err(), teardown_fails || cleanup_fails);
            }
        }
    }

    #[test]
    fn failed_logout_marker_still_attempts_both_credential_deletions() {
        let matrix_cleared = std::cell::Cell::new(false);
        let oauth_cleared = std::cell::Cell::new(false);
        let result = clear_logout_credentials(
            Err("marker unavailable".into()),
            || {
                matrix_cleared.set(true);
                Err("matrix keychain unavailable".into())
            },
            || {
                oauth_cleared.set(true);
                Ok(())
            },
        );
        assert!(matrix_cleared.get() && oauth_cleared.get());
        assert_eq!(result.as_deref(), Some("marker unavailable"));
    }

    #[test]
    fn logout_reports_credential_failure_even_with_a_durable_marker() {
        assert_eq!(
            clear_logout_credentials(Ok(()), || Ok(()), || Err("oauth unavailable".into())),
            Some("oauth unavailable".into())
        );
    }

    #[tokio::test]
    async fn wipe_revoke_completes_the_remote_logout_when_available() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/logout"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        revoke_before_local_wipe(client, std::time::Duration::from_secs(5)).await;
        server.server().verify().await;
    }

    #[tokio::test]
    async fn wipe_revoke_does_not_wait_for_an_unresponsive_homeserver() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/logout"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({}))
                    .set_delay(std::time::Duration::from_secs(30)),
            )
            .mount(server.server())
            .await;
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            revoke_before_local_wipe(client, std::time::Duration::from_millis(50)),
        )
        .await
        .expect("local wipe must not wait for the delayed logout response");
    }

    #[tokio::test]
    async fn account_cleanup_keeps_login_excluded_after_caller_cancellation() {
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let guard = std::sync::Arc::new(std::sync::Arc::clone(&lock).lock_owned().await);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let caller = tokio::spawn(run_account_cleanup(guard, move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        }));
        started_rx.await.unwrap();
        caller.abort();
        let result = caller.await;
        let replacement_blocked = lock.try_lock().is_err();
        release_tx.send(()).unwrap();
        assert!(result.unwrap_err().is_cancelled());
        assert!(replacement_blocked);
        let _replacement = tokio::time::timeout(std::time::Duration::from_secs(5), lock.lock())
            .await
            .expect("finished cleanup must release login exclusion");
    }

    #[tokio::test]
    async fn account_cleanup_panic_preserves_callers_recovery_exclusion() {
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let guard = std::sync::Arc::new(std::sync::Arc::clone(&lock).lock_owned().await);
        let result = run_account_cleanup(std::sync::Arc::clone(&guard), || {
            panic!("simulated filesystem worker failure");
        })
        .await;
        assert!(result.unwrap_err().is_panic());
        assert!(lock.try_lock().is_err());
        drop(guard);
        assert!(lock.try_lock().is_ok());
    }

    #[tokio::test]
    async fn teardown_rejects_a_session_change_while_waiting_for_login_exclusion() {
        let state = MatrixState::default();
        let server = MatrixMockServer::new().await;
        let original = server.client_builder().build().await;
        *state.client.lock().await = Some(original);
        let login = state.login_completion_lock.lock().await;
        let teardown = begin_session_teardown(&state);
        tokio::pin!(teardown);
        tokio::select! {
            biased;
            _ = &mut teardown => panic!("teardown read the client before login completed"),
            () = std::future::ready(()) => {}
        }
        *state.client.lock().await = None;
        drop(login);
        assert!(teardown.await.is_err());
        assert!(state.login_completion_lock.try_lock().is_ok());
    }

    #[test]
    fn forget_local_data_requires_an_explicit_confirmation_bit() {
        assert!(require_local_data_confirmation(false).is_err());
        assert!(require_local_data_confirmation(true).is_ok());
    }

    #[test]
    fn forget_local_data_rejects_a_changed_account_or_device() {
        for (user, device) in [
            (Some("@b:example.org"), Some("A")),
            (Some("@a:example.org"), Some("B")),
            (None, None),
        ] {
            assert!(require_confirmed_session("@a:example.org", "A", user, device).is_err());
        }
    }

    #[test]
    fn forget_local_data_accepts_the_confirmed_session() {
        assert!(require_confirmed_session(
            "@a:example.org",
            "A",
            Some("@a:example.org"),
            Some("A")
        )
        .is_ok());
    }

    #[tokio::test]
    async fn validate_avatar_path_accepts_a_real_image() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("avatar.png");
        // Minimal valid 1x1 PNG.
        let mut png_bytes = Vec::new();
        image::RgbaImage::new(1, 1)
            .write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        tokio::fs::write(&file_path, &png_bytes).await.unwrap();

        let result = validate_avatar_path(file_path.to_str().unwrap()).await;
        let (_path, _data, mime) =
            result.unwrap_or_else(|err| panic!("expected a real PNG to validate, got {err}"));
        assert_eq!(mime, mime_guess::mime::IMAGE_PNG);
    }

    #[tokio::test]
    async fn validate_avatar_path_uses_detected_content_type() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("avatar.png");
        let mut jpeg_bytes = Vec::new();
        image::RgbImage::new(1, 1)
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg_bytes),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        tokio::fs::write(&file_path, &jpeg_bytes).await.unwrap();

        let (_path, _data, mime) = validate_avatar_path(file_path.to_str().unwrap())
            .await
            .unwrap_or_else(|err| {
                panic!("expected JPEG bytes with a PNG extension to validate, got {err}")
            });
        assert_eq!(mime, mime_guess::mime::IMAGE_JPEG);
    }

    #[tokio::test]
    async fn validate_avatar_path_rejects_a_nonexistent_path() {
        let result = validate_avatar_path("/nonexistent/path/to/avatar.png").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn validate_avatar_path_rejects_a_non_image_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("id_rsa");
        tokio::fs::write(
            &file_path,
            b"-----BEGIN OPENSSH PRIVATE KEY-----\nnot an image\n",
        )
        .await
        .unwrap();

        let result = validate_avatar_path(file_path.to_str().unwrap()).await;
        assert!(
            result.is_err(),
            "expected a non-image file to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn validate_avatar_path_rejects_an_image_header_without_image_data() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("fake.png");
        let mut fake_png = b"\x89PNG\r\n\x1a\n".to_vec();
        fake_png.extend_from_slice(b"-----BEGIN OPENSSH PRIVATE KEY-----\nnot an image\n");
        tokio::fs::write(&file_path, fake_png).await.unwrap();

        let result = validate_avatar_path(file_path.to_str().unwrap()).await;
        assert!(
            result.is_err(),
            "expected a fake PNG header to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn validate_avatar_path_rejects_an_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("huge.png");
        tokio::fs::write(&file_path, vec![0u8; (MAX_AVATAR_BYTES + 1) as usize])
            .await
            .unwrap();

        let result = validate_avatar_path(file_path.to_str().unwrap()).await;
        assert!(
            result.is_err(),
            "expected an oversized file to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn validate_avatar_path_rejects_a_decompression_bomb() {
        // A 1px-tall, very-wide solid-color image: compresses to a tiny file
        // on disk but would decode to far more than `MAX_AVATAR_DIMENSION`
        // pixels along one side. The size-on-disk check alone would let this
        // through; the dimension peek before the full decode should not.
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("bomb.png");
        let mut png_bytes = Vec::new();
        image::RgbImage::new(MAX_AVATAR_DIMENSION + 1, 1)
            .write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        assert!(
            (png_bytes.len() as u64) < MAX_AVATAR_BYTES,
            "expected the solid-color PNG to compress well under the byte cap"
        );
        tokio::fs::write(&file_path, &png_bytes).await.unwrap();

        let result = validate_avatar_path(file_path.to_str().unwrap()).await;
        assert!(
            result.is_err(),
            "expected an oversized-dimension image to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn validate_avatar_path_rejects_a_format_outside_the_allowlist() {
        // BMP is a format `image::guess_format` recognizes by magic bytes
        // (`"BM"`) but that the avatar picker never offers and that isn't in
        // `ALLOWED_AVATAR_FORMATS`. This crate's own `Cargo.toml` doesn't
        // enable the `bmp` feature, so this also guards against Cargo
        // feature unification (e.g. with another workspace crate's `image`
        // dependency) silently widening which formats get accepted here —
        // decodability alone must not be the gate. Built by hand (rather
        // than via `image`'s BMP encoder, which isn't compiled into this
        // binary either) since only enough of a real BMP header is needed
        // for the magic-byte sniff to recognize the format.
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("avatar.bmp");
        let mut bmp_bytes = b"BM".to_vec();
        bmp_bytes.extend_from_slice(&[0u8; 62]); // pad past a minimal BMP header
        tokio::fs::write(&file_path, &bmp_bytes).await.unwrap();

        let result = validate_avatar_path(file_path.to_str().unwrap()).await;
        assert!(
            result.is_err(),
            "expected a BMP file to be rejected as outside the avatar format allowlist, got {result:?}"
        );
    }

    /// Mounts the standard two-step UIA dance on `server` for `endpoint_path`:
    /// a password-less request gets the 401 challenge (matching real Synapse
    /// behavior), and a request whose body includes `"auth"` succeeds. Higher
    /// priority on the success mock so it's checked (and skipped, on the
    /// first, auth-less call) before falling through to the catch-all
    /// challenge — see `wiremock::Mock::with_priority`'s doc comment.
    ///
    /// `success_body` covers the one endpoint here (`deactivate`) whose
    /// response has a required field beyond an empty `{}` — every other
    /// caller passes `json!({})`.
    async fn mock_uia_dance_with_body(
        server: &MatrixMockServer,
        endpoint_path: &str,
        success_body: serde_json::Value,
    ) {
        Mock::given(method("POST"))
            .and(path(endpoint_path))
            .and(body_string_contains("\"auth\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(success_body))
            .with_priority(1)
            .mount(server.server())
            .await;

        Mock::given(method("POST"))
            .and(path(endpoint_path))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "errcode": "M_FORBIDDEN",
                "flows": [{ "stages": ["m.login.password"] }],
                "params": {},
                "session": "test-uia-session"
            })))
            .mount(server.server())
            .await;
    }

    #[tokio::test]
    async fn change_password_needs_a_password_on_first_attempt_then_succeeds() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        mock_uia_dance_with_body(&server, "/_matrix/client/v3/account/password", json!({})).await;

        let user_id = client.user_id().unwrap().to_owned();
        let account = client.account();

        let first_attempt = account.change_password("new-password", None).await;
        assert!(
            first_attempt
                .as_ref()
                .err()
                .is_some_and(|e| e.as_uiaa_response().is_some()),
            "expected a recognizable UIA challenge on the password-less attempt"
        );

        let first_attempt_via_helper = retry_uia_with_session(&user_id, None, |auth| {
            account.change_password("new-password", auth)
        })
        .await;
        assert!(
            matches!(first_attempt_via_helper, Err(UiaCommandError::UiaChallenge)),
            "expected the password-less attempt to surface as UiaCommandError::UiaChallenge, got {first_attempt_via_helper:?}"
        );

        let retry =
            retry_uia_with_session(&user_id, Some("current-password".to_string()), |auth| {
                account.change_password("new-password", auth)
            })
            .await;
        assert!(
            retry.is_ok(),
            "expected the retry with a password to succeed"
        );
    }

    /// A non-UIA failure (network error, 500, etc.) on the first attempt must
    /// surface as `UiaCommandError::Other`, not be misclassified as a
    /// password challenge — see the spec's acceptance criteria.
    #[tokio::test]
    async fn change_password_non_uia_error_on_first_attempt_is_not_a_challenge() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let endpoint_path = "/_matrix/client/v3/account/password";

        Mock::given(method("POST"))
            .and(path(endpoint_path))
            .respond_with(ResponseTemplate::new(500))
            .mount(server.server())
            .await;

        let user_id = client.user_id().unwrap().to_owned();
        let account = client.account();

        let result = retry_uia_with_session(&user_id, None, |auth| {
            account.change_password("new-password", auth)
        })
        .await;

        assert!(
            matches!(result, Err(UiaCommandError::Other { .. })),
            "expected a non-UIA server error to surface as UiaCommandError::Other, got {result:?}"
        );
    }

    /// The production `change_password` command builds its request raw
    /// (rather than via `Account::change_password`, which hardcodes Ruma's
    /// `logout_devices: true` default) specifically so a routine password
    /// change doesn't silently sign out every other device. The mock here
    /// only accepts a body containing `"logout_devices":false`, so this only
    /// passes if that field actually made it onto the wire.
    #[tokio::test]
    async fn change_password_never_logs_out_other_devices() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let endpoint_path = "/_matrix/client/v3/account/password";

        Mock::given(method("POST"))
            .and(path(endpoint_path))
            .and(body_string_contains("\"logout_devices\":false"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .with_priority(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path(endpoint_path))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "errcode": "M_FORBIDDEN",
                "flows": [{ "stages": ["m.login.password"] }],
                "params": {},
                "session": "test-uia-session"
            })))
            .mount(server.server())
            .await;

        let user_id = client.user_id().unwrap().to_owned();

        let result =
            retry_uia_with_session(&user_id, Some("current-password".to_string()), |auth| {
                let client = client.clone();
                async move {
                    let mut request = change_password::v3::Request::new("new-password".to_string());
                    request.logout_devices = false;
                    request.auth = auth;
                    client.send(request).await.map_err(matrix_sdk::Error::from)
                }
            })
            .await;

        assert!(
            result.is_ok(),
            "expected the retry to succeed against the mock that only accepts logout_devices: false"
        );
    }

    #[tokio::test]
    async fn deactivate_account_needs_a_password_on_first_attempt_then_succeeds() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        mock_uia_dance_with_body(
            &server,
            "/_matrix/client/v3/account/deactivate",
            json!({ "id_server_unbind_result": "success" }),
        )
        .await;

        let user_id = client.user_id().unwrap().to_owned();
        let account = client.account();

        let first_attempt = account.deactivate(None, None, false).await;
        assert!(
            first_attempt
                .as_ref()
                .err()
                .is_some_and(|e| e.as_uiaa_response().is_some()),
            "expected a recognizable UIA challenge on the password-less attempt"
        );

        let first_attempt_via_helper =
            retry_uia_with_session(&user_id, None, |auth| account.deactivate(None, auth, false))
                .await;
        assert!(
            matches!(first_attempt_via_helper, Err(UiaCommandError::UiaChallenge)),
            "expected the password-less attempt to surface as UiaCommandError::UiaChallenge, got {first_attempt_via_helper:?}"
        );

        let retry =
            retry_uia_with_session(&user_id, Some("current-password".to_string()), |auth| {
                account.deactivate(None, auth, false)
            })
            .await;
        assert!(
            retry.is_ok(),
            "expected the retry with a password to succeed"
        );
    }

    /// A non-UIA failure on the first attempt must surface as
    /// `UiaCommandError::Other`, not be misclassified as a password
    /// challenge.
    #[tokio::test]
    async fn deactivate_account_non_uia_error_on_first_attempt_is_not_a_challenge() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let endpoint_path = "/_matrix/client/v3/account/deactivate";

        Mock::given(method("POST"))
            .and(path(endpoint_path))
            .respond_with(ResponseTemplate::new(500))
            .mount(server.server())
            .await;

        let user_id = client.user_id().unwrap().to_owned();
        let account = client.account();

        let result =
            retry_uia_with_session(&user_id, None, |auth| account.deactivate(None, auth, false))
                .await;

        assert!(
            matches!(result, Err(UiaCommandError::Other { .. })),
            "expected a non-UIA server error to surface as UiaCommandError::Other, got {result:?}"
        );
    }

    /// The gap a reviewer caught: a `Password` built with `session: None`
    /// (the old behavior) looks like a brand new UIA attempt to a strict
    /// homeserver. This homeserver only accepts the retry when its body
    /// echoes back the *exact* session id from the 401 challenge — a naive
    /// retry (any `"auth"` blob) would fail here even though it passed the
    /// looser `mock_uia_dance_with_body` check above.
    #[tokio::test]
    async fn retry_uia_with_session_threads_the_real_session_id_through() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let user_id = client.user_id().unwrap().to_owned();
        let account = client.account();

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/account/password"))
            .and(body_string_contains("\"session\":\"exact-session-id\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .with_priority(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/account/password"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "errcode": "M_FORBIDDEN",
                "flows": [{ "stages": ["m.login.password"] }],
                "params": {},
                "session": "exact-session-id"
            })))
            .mount(server.server())
            .await;

        let result =
            retry_uia_with_session(&user_id, Some("current-password".to_string()), |auth| {
                account.change_password("new-password", auth)
            })
            .await;

        assert!(
            result.is_ok(),
            "expected the session id from the 401 challenge to be echoed back on retry: {result:?}"
        );
    }
}
