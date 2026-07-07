//! Login/registration against a homeserver, producing an in-memory (no
//! sqlite store, no disk persistence) `matrix_sdk::Client` — this crate's
//! sessions don't survive a process restart in sub-PR A. See the crate
//! README for the sub-PR B plan to add encrypted-at-rest storage.

use charm_lib::matrix::auth::{
    register_with_dummy_auth, LoginRequest, LoginResponse, RegisterRequest,
};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::Client;

use crate::session::Session;

/// Builds a fresh in-memory `Client` against `homeserver_url` (a server name
/// or full URL — matrix-rust-sdk's `.well-known` discovery handles both, same
/// as `charm_lib::matrix::auth::build_client`) and logs in with a password.
pub async fn login(request: LoginRequest) -> Result<(LoginResponse, Session), String> {
    let client = Client::builder()
        .server_name_or_homeserver_url(&request.homeserver_url)
        .build()
        .await
        .map_err(|e| e.to_string())?;

    client
        .matrix_auth()
        .login_username(&request.username, &request.password)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let session_meta = client
        .matrix_auth()
        .session()
        .ok_or_else(|| "login succeeded but no session was returned".to_string())?;

    // Room APIs (`snapshot_rooms`/`client.get_room`) read the SDK's local
    // room store, which only gets populated by a sync — without this, every
    // room route 404s/empties out for a freshly logged-in session even
    // though the account genuinely has rooms. A background sync loop is
    // sub-PR B (alongside the WS push channel); this single `sync_once`
    // just establishes that initial local state so sub-PR A's
    // request/response routes have something to read.
    client
        .sync_once(SyncSettings::default())
        .await
        .map_err(|e| e.to_string())?;

    let user_id = session_meta.meta.user_id.to_string();
    let response = LoginResponse {
        user_id: user_id.clone(),
        device_id: session_meta.meta.device_id.to_string(),
    };

    Ok((response, Session { client, user_id }))
}

/// Registers a new account and logs it in, same in-memory-client shape as
/// [`login`].
pub async fn register(request: RegisterRequest) -> Result<(LoginResponse, Session), String> {
    let client = Client::builder()
        .server_name_or_homeserver_url(&request.homeserver_url)
        .build()
        .await
        .map_err(|e| e.to_string())?;

    // Reuses `charm_lib`'s UIAA-session-aware dummy-auth flow directly
    // (it's already `Client`-only, no `AppHandle` dependency) rather than
    // sending a bare `Dummy::new()` with no server-issued UIAA session,
    // which Synapse's normal `m.login.dummy` flow rejects.
    register_with_dummy_auth(&client, &request.username, &request.password).await?;

    let session_meta = client
        .matrix_auth()
        .session()
        .ok_or_else(|| "registration succeeded but no session was returned".to_string())?;

    client
        .sync_once(SyncSettings::default())
        .await
        .map_err(|e| e.to_string())?;

    let user_id = session_meta.meta.user_id.to_string();
    let response = LoginResponse {
        user_id: user_id.clone(),
        device_id: session_meta.meta.device_id.to_string(),
    };

    Ok((response, Session { client, user_id }))
}
