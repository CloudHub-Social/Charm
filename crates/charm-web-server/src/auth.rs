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
async fn build_client(
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
fn cleanup_failed_crypto_store(crypto: &Option<CryptoStoreHandle>) {
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

    let Some(session_meta) = client.matrix_auth().session() else {
        cleanup_failed_crypto_store(&crypto);
        return Err("login succeeded but no session was returned".to_string());
    };
    let user_id = session_meta.meta.user_id.to_string();

    // Built (and its event handlers registered — see
    // `register_event_handlers`'s doc comment for why that must happen
    // *before* the sync below, not just before `sync_loop::spawn`) ahead of
    // that sync, not after: `Session::new` is what creates this session's
    // broadcast channel, and a `to-device` verification event landing in
    // this very first sync response is processed synchronously as part of
    // this call — never replayed later — so the handler needs somewhere to
    // push it to before this call happens, not after.
    let crypto_store_open = crypto.is_some();
    let session = Session::new(client.clone(), user_id.clone(), crypto, crypto_store_open);
    crate::sync_loop::register_event_handlers(
        &client,
        session.events.clone(),
        session.pending_verification_events.clone(),
        session.profile_and_presence_snapshots(),
    );

    // Room APIs (`snapshot_rooms`/`client.get_room`) read the SDK's local
    // room store, which only gets populated by a sync — without this, every
    // room route 404s/empties out for a freshly logged-in session even
    // though the account genuinely has rooms. This also doubles as
    // `sync_loop::spawn`'s initial sync — see this function's doc comment.
    //
    // A failure here is *not* propagated as this whole function's error:
    // the login itself already succeeded above, so failing this call would
    // throw away valid, already-authenticated credentials over what's very
    // often a transient network/homeserver hiccup, forcing the user to
    // resubmit their password for no reason the login itself caused. An
    // empty/default `SyncResponse` lets the caller still issue a session
    // cookie; `sync_loop::spawn`'s own loop (using this same empty response
    // as its "initial state") will attempt its first real sync immediately
    // after and surface a `sync:state` error there if the homeserver is
    // genuinely still unreachable — this route just stops being the one
    // thing standing between "logged in" and "usable".
    let initial_response = client
        .sync_once(SyncSettings::default())
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(
                "login's initial sync failed, deferring to the background sync loop's own retry: {e}"
            );
            matrix_sdk::sync::SyncResponse::default()
        });

    let response = LoginResponse {
        user_id,
        device_id: session_meta.meta.device_id.to_string(),
    };

    Ok((response, session, initial_response))
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

    let Some(session_meta) = client.matrix_auth().session() else {
        cleanup_failed_crypto_store(&crypto);
        return Err("registration succeeded but no session was returned".to_string());
    };
    let user_id = session_meta.meta.user_id.to_string();

    // See `login`'s doc comment on this same ordering: session (and its
    // event handlers) built before the initial sync, not after.
    let crypto_store_open = crypto.is_some();
    let session = Session::new(client.clone(), user_id.clone(), crypto, crypto_store_open);
    crate::sync_loop::register_event_handlers(
        &client,
        session.events.clone(),
        session.pending_verification_events.clone(),
        session.profile_and_presence_snapshots(),
    );

    // Not propagated as an error — see `login`'s matching doc comment, and
    // more so here: the account was *just created* by
    // `register_with_dummy_auth` above, so failing this call would strand
    // the user with an account that already exists but no way back in —
    // retrying "registration" fails outright (username taken), and this
    // route never told the caller the account/device id it needs to fall
    // back to a plain login instead.
    let initial_response = client
        .sync_once(SyncSettings::default())
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(
                "registration's initial sync failed, deferring to the background sync loop's own retry: {e}"
            );
            matrix_sdk::sync::SyncResponse::default()
        });

    let response = LoginResponse {
        user_id,
        device_id: session_meta.meta.device_id.to_string(),
    };

    Ok((response, session, initial_response))
}
