//! Login/registration against a homeserver. This builds the live
//! `matrix_sdk::Client`; `crate::routes::finish_login` is responsible for
//! saving the resulting Matrix session through
//! `crate::persistence::PersistenceStore` when `CHARM_WEB_SERVER_MASTER_KEY`
//! is configured.

use charm_lib::matrix::auth::{
    client_encryption_settings, register_with_dummy_auth, LoginRequest, LoginResponse,
    RegisterRequest,
};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::Client;

use crate::session::{CryptoStoreHandle, Session};

/// Generates a fresh crypto-store key/passphrase and builds a `Client`
/// against it when `has_persistence` is true (mirroring desktop's
/// `sqlite_store`-backed client); otherwise builds the same bare in-memory
/// `Client` as before Spec 25. Shared by [`login`]/[`register`] so a fresh
/// login's crypto state (device keys, etc.) lands directly in the persisted
/// store from the very first `Client::builder().build()` call, rather than
/// being established in-memory and needing a separate migration into a store
/// afterward.
pub(crate) async fn build_client(
    homeserver_url: &str,
    has_persistence: bool,
) -> Result<(Client, Option<CryptoStoreHandle>), String> {
    if !has_persistence {
        let client = Client::builder()
            .server_name_or_homeserver_url(homeserver_url)
            .with_encryption_settings(client_encryption_settings())
            .build()
            .await
            .map_err(|e| e.to_string())?;
        return Ok((client, None));
    }

    let crypto = CryptoStoreHandle {
        store_key: crate::crypto_store::generate_store_key(),
        passphrase: crate::crypto_store::generate_passphrase(),
    };
    let store_dir = crate::crypto_store::create_store_dir(&crypto.store_key)?;
    let client = match Client::builder()
        .server_name_or_homeserver_url(homeserver_url)
        .with_encryption_settings(client_encryption_settings())
        .sqlite_store(&store_dir, Some(crypto.passphrase.as_str()))
        .build()
        .await
    {
        Ok(client) => client,
        Err(e) => {
            // The directory above was already created by `create_store_dir`
            // — a `?` here without this cleanup would leak it on every
            // failed build (e.g. an invalid homeserver URL, or a sqlite
            // open error), the same leak `cleanup_failed_crypto_store`
            // exists to prevent for a login/register failure *after* a
            // successful build. Best-effort for the same reason that one is:
            // the caller already has a real error to report.
            cleanup_failed_crypto_store(&Some(crypto));
            return Err(e.to_string());
        }
    };
    Ok((client, Some(crypto)))
}

/// Removes a just-created crypto-store directory when the login/register
/// attempt that created it (via [`build_client`]) fails partway through —
/// otherwise a repeated failed login/register (wrong password, UIAA
/// rejection, homeserver hiccup) leaks one `data/crypto/<random>/`
/// directory per attempt, since nothing else ever learns that random key to
/// clean it up later (it's never returned to a caller or persisted). No-op
/// when `crypto` is `None` (persistence disabled). Best-effort: logged, not
/// propagated — the caller already has a real auth error to report, and
/// leftover disk usage from a rare cleanup failure is far less urgent than
/// surfacing that.
pub(crate) fn cleanup_failed_crypto_store(crypto: &Option<CryptoStoreHandle>) {
    let Some(crypto) = crypto else { return };
    match crate::crypto_store::existing_store_dir(&crypto.store_key) {
        Ok(Some(dir)) => {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                tracing::warn!("failed to remove crypto store after failed auth: {e}");
            }
        }
        Ok(None) => {}
        Err(e) => tracing::warn!("failed to resolve crypto store directory for cleanup: {e}"),
    }
}

/// Converts an already-authenticated Matrix client into the same web
/// session shape used by password login, registration UIA, and token login.
pub(crate) async fn finish_authenticated_client(
    client: Client,
    crypto: Option<CryptoStoreHandle>,
    flow: &str,
) -> Result<(LoginResponse, Session, matrix_sdk::sync::SyncResponse), String> {
    let Some(session_meta) = client.matrix_auth().session() else {
        cleanup_failed_crypto_store(&crypto);
        return Err(format!("{flow} succeeded but no session was returned"));
    };
    let user_id = session_meta.meta.user_id.to_string();
    let device_id = session_meta.meta.device_id.to_string();
    let crypto_store_open = crypto.is_some();
    let session = Session::new(client.clone(), user_id.clone(), crypto, crypto_store_open);
    crate::sync_loop::register_event_handlers(
        &client,
        session.events.clone(),
        session.pending_verification_events.clone(),
        session.profile_and_presence_snapshots(),
    );
    let initial_response = client
        .sync_once(SyncSettings::default())
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(
                "{flow}'s initial sync failed, deferring to the background sync loop's own retry: {error}"
            );
            matrix_sdk::sync::SyncResponse::default()
        });
    Ok((
        LoginResponse { user_id, device_id },
        session,
        initial_response,
    ))
}

/// Builds a fresh in-memory `Client` against `homeserver_url` (a server name
/// or full URL — matrix-rust-sdk's `.well-known` discovery handles both, same
/// as `charm_lib::matrix::auth::build_client`) and logs in with a password.
///
/// Also returns the `SyncResponse` from the initial `sync_once` below, so
/// `sync_loop::spawn` can use it directly as its *own* "initial state"
/// instead of performing a second `sync_once` immediately afterward. That
/// second call was harmless correctness-wise (`ReusePrevious` just picks up
/// from the token this one already advanced to) but is a real user-visible
/// bug: with nothing new to report, a `/sync` long-polls up to its timeout
/// (tens of seconds) before returning, so the frontend's first
/// `sync:state`/`room_list:update` over the WebSocket was delayed by that
/// whole long-poll for no reason on every fresh login.
pub async fn login(
    request: LoginRequest,
    has_persistence: bool,
) -> Result<(LoginResponse, Session, matrix_sdk::sync::SyncResponse), String> {
    let (client, crypto) = build_client(&request.homeserver_url, has_persistence).await?;

    if let Err(e) = client
        .matrix_auth()
        .login_username(&request.username, &request.password)
        .send()
        .await
    {
        cleanup_failed_crypto_store(&crypto);
        return Err(e.to_string());
    }

    finish_authenticated_client(client, crypto, "login").await
}

/// Registers a new account and logs it in, same in-memory-client shape as
/// [`login`] (including the returned initial `SyncResponse` — see its doc
/// comment for why).
pub async fn register(
    request: RegisterRequest,
    has_persistence: bool,
) -> Result<(LoginResponse, Session, matrix_sdk::sync::SyncResponse), String> {
    let (client, crypto) = build_client(&request.homeserver_url, has_persistence).await?;

    // Reuses `charm_lib`'s UIAA-session-aware dummy-auth flow directly
    // (it's already `Client`-only, no `AppHandle` dependency) rather than
    // sending a bare `Dummy::new()` with no server-issued UIAA session,
    // which Synapse's normal `m.login.dummy` flow rejects.
    if let Err(e) = register_with_dummy_auth(&client, &request.username, &request.password).await {
        cleanup_failed_crypto_store(&crypto);
        return Err(e);
    }

    finish_authenticated_client(client, crypto, "registration").await
}
