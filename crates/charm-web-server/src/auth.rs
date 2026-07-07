//! Login/registration against a homeserver, producing an in-memory (no
//! sqlite store, no disk persistence) `matrix_sdk::Client` — this crate's
//! sessions don't survive a process restart in sub-PR A. See the crate
//! README for the sub-PR B plan to add encrypted-at-rest storage.

use charm_lib::matrix::auth::{LoginRequest, LoginResponse, RegisterRequest};
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

    // matrix-sdk's plain `register` helper handles the common dummy-auth
    // flow (no UIAA stages beyond `m.login.dummy`) — the same one
    // `charm_lib::matrix::auth::register` drives for the desktop app,
    // reimplemented here rather than reused because that function is
    // `AppHandle`-bound (it persists the resulting session to disk/keychain,
    // which this ephemeral crate deliberately does not do).
    use matrix_sdk::ruma::api::client::account::register as register_api;
    use matrix_sdk::ruma::api::client::uiaa::{AuthData, Dummy};

    let mut register_request = register_api::v3::Request::new();
    register_request.username = Some(request.username.clone());
    register_request.password = Some(request.password.clone());
    register_request.auth = Some(AuthData::Dummy(Dummy::new()));

    client
        .matrix_auth()
        .register(register_request)
        .await
        .map_err(|e| e.to_string())?;

    let session_meta = client
        .matrix_auth()
        .session()
        .ok_or_else(|| "registration succeeded but no session was returned".to_string())?;

    let user_id = session_meta.meta.user_id.to_string();
    let response = LoginResponse {
        user_id: user_id.clone(),
        device_id: session_meta.meta.device_id.to_string(),
    };

    Ok((response, Session { client, user_id }))
}
