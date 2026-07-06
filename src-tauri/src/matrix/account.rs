//! Account settings: logout, profile edit, password change, and account
//! deactivation.
//!
//! `ProfileSummary` is a small, independent read/write DTO for the settings
//! Account panel — the Profiles spec (Spec 01) hadn't merged its read-only
//! `get_own_profile`/`OwnProfile` model when this was written (see Spec 08's
//! "Dependencies & sequencing"). Align the two into one shared model once
//! Spec 01 lands; until then this module doesn't depend on it.

use matrix_sdk::ruma::api::client::uiaa::{
    AuthData, MatrixUserIdentifier, Password, UserIdentifier,
};
use matrix_sdk::ruma::UserId;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use ts_rs::TS;

use super::media;
use super::persistence;
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
) -> Result<T, String>
where
    F: FnMut(Option<AuthData>) -> Fut,
    Fut: std::future::Future<Output = matrix_sdk::Result<T>>,
{
    let Some(password) = password else {
        return call(None).await.map_err(|e| e.to_string());
    };

    let session = match call(None).await {
        Ok(value) => return Ok(value),
        Err(e) => e.as_uiaa_response().and_then(|info| info.session.clone()),
    };

    let mut auth = Password::new(
        UserIdentifier::Matrix(MatrixUserIdentifier::new(user_id.to_string())),
        password,
    );
    auth.session = session;
    call(Some(AuthData::Password(auth)))
        .await
        .map_err(|e| e.to_string())
}

/// Tears down the local session identically for `logout` and
/// `deactivate_account`: clears both keychain-backed session kinds
/// (password/SSO's `MatrixSession` and QR login's `OAuthSession` — matching
/// the dual-path handling in `mod::try_restore_session`) and drops the
/// in-memory client. Deliberately does *not* delete the account's SQLCipher
/// store — see Spec 08's "Logout store retention": this is a sign-out, not a
/// device wipe, so a later re-login onto the same account reuses the
/// existing store instead of starting cold.
async fn clear_local_session(state: &State<'_, MatrixState>, user_id: &str) -> Result<(), String> {
    let account_key = persistence::account_key(user_id);
    persistence::clear_session(&account_key)?;
    persistence::clear_oauth_session(&account_key)?;
    *state.client.lock().await = None;

    // The background sync loop (`mod::spawn_sync_loop`) holds its own clone
    // of the `Client`, independent of the one just cleared above — without
    // this, it keeps syncing (and emitting `room_list:update`/`sync:state`)
    // for the now-signed-out account until it happens to fail on its own.
    if let Some(handle) = state.sync_loop_task.lock().unwrap().take() {
        handle.abort();
    }

    Ok(())
}

/// Signs the current session out: best-effort server-side revoke (an
/// unreachable homeserver must not block clearing the local session — see
/// Spec 08 acceptance criterion 2), then unconditionally clears both
/// keychain session entries and drops the client so a relaunch doesn't
/// auto-restore.
#[tauri::command]
pub async fn logout(state: State<'_, MatrixState>) -> Result<(), String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();

    if client.matrix_auth().logged_in() {
        let _ = client.matrix_auth().logout().await;
    } else {
        let _ = client.oauth().logout().await;
    }

    clear_local_session(&state, user_id.as_str()).await
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
    })
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

/// Reads `file_path` off disk and uploads it as the account avatar, setting
/// it as the current `m.room` avatar url in one step — `Account::upload_avatar`
/// does both. Same file-path-in, read-on-the-Rust-side convention as
/// `send::send_attachment` rather than passing raw bytes over IPC.
#[tauri::command]
pub async fn set_avatar(state: State<'_, MatrixState>, file_path: String) -> Result<(), String> {
    let client = state.require_client().await?;
    let path = std::path::Path::new(&file_path);
    let data = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();

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
/// challenge — see [`retry_uia_with_session`].
#[tauri::command]
pub async fn change_password(
    state: State<'_, MatrixState>,
    new_password: String,
    password: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let account = client.account();

    retry_uia_with_session(&user_id, password, |auth| {
        account.change_password(&new_password, auth)
    })
    .await?;
    Ok(())
}

/// UIA-gated, same retry convention as [`change_password`]. Tears down the
/// local session identically to [`logout`] on success — the account no
/// longer exists server-side, so there's nothing left to restore.
/// `erase_data` is always `false`: Secure Backup / content erasure is Day-2
/// scope (see Spec 08 non-goals).
#[tauri::command]
pub async fn deactivate_account(
    state: State<'_, MatrixState>,
    password: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let account = client.account();

    retry_uia_with_session(&user_id, password, |auth| {
        account.deactivate(None, auth, false)
    })
    .await?;

    clear_local_session(&state, user_id.as_str()).await
}

#[cfg(test)]
mod tests {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, ResponseTemplate};

    use super::*;

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
