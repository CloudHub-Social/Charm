//! Login/registration against a homeserver. This builds the live
//! `matrix_sdk::Client`; `crate::routes::finish_login` is responsible for
//! saving the resulting Matrix session through
//! `crate::persistence::PersistenceStore` when `CHARM_WEB_SERVER_MASTER_KEY`
//! is configured.

use charm_lib::matrix::auth::{
    client_encryption_settings, register_with_dummy_auth, LoginRequest, LoginResponse,
    RegisterRequest,
};
use futures_util::StreamExt;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::Client;
use std::time::Duration;

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
    let (homeserver, http_client) = validated_homeserver_client(homeserver_url).await?;
    if !has_persistence {
        let client = Client::builder()
            .homeserver_url(homeserver)
            .http_client(http_client)
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
    struct CryptoBuildGuard(Option<CryptoStoreHandle>);
    impl Drop for CryptoBuildGuard {
        fn drop(&mut self) {
            cleanup_failed_crypto_store(&self.0);
        }
    }
    let mut cleanup = CryptoBuildGuard(Some(crypto.clone()));
    let client = match Client::builder()
        .homeserver_url(homeserver)
        .http_client(http_client)
        .with_encryption_settings(client_encryption_settings())
        .sqlite_store(&store_dir, Some(crypto.passphrase.as_str()))
        .build()
        .await
    {
        Ok(client) => client,
        Err(e) => {
            return Err(e.to_string());
        }
    };
    cleanup.0.take();
    Ok((client, Some(crypto)))
}

pub(crate) async fn validated_homeserver_client(
    homeserver_url: &str,
) -> Result<(reqwest::Url, reqwest::Client), String> {
    let homeserver = if homeserver_url.contains("://") {
        reqwest::Url::parse(homeserver_url)
            .map_err(|_| "enter a valid Matrix server name or HTTPS homeserver URL".to_string())?
    } else {
        discover_homeserver(homeserver_url).await?
    };
    validated_url_client(homeserver).await
}

#[derive(serde::Deserialize)]
struct ClientWellKnown {
    #[serde(rename = "m.homeserver")]
    homeserver: ClientWellKnownHomeserver,
}

#[derive(serde::Deserialize)]
struct ClientWellKnownHomeserver {
    base_url: String,
}

async fn discover_homeserver(server_name: &str) -> Result<reqwest::Url, String> {
    const MAX_WELL_KNOWN_BYTES: usize = 64 * 1024;
    let origin = reqwest::Url::parse(&format!("https://{server_name}"))
        .map_err(|_| "enter a valid Matrix server name or HTTPS homeserver URL".to_string())?;
    if origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
        || !origin.username().is_empty()
        || origin.password().is_some()
    {
        return Err("enter a valid Matrix server name or HTTPS homeserver URL".to_string());
    }

    let mut target = origin
        .join("/.well-known/matrix/client")
        .map_err(|_| "enter a valid Matrix server name or HTTPS homeserver URL".to_string())?;
    for redirect_count in 0..=3 {
        let (_, client) = validated_url_client(target.clone()).await?;
        let response = match client.get(target.clone()).send().await {
            Ok(response) => response,
            Err(_) => return Ok(origin),
        };
        if response.status().is_redirection() {
            if redirect_count == 3 {
                return Err("homeserver discovery used too many redirects".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "homeserver discovery returned an invalid redirect".to_string())?;
            target = target
                .join(location)
                .map_err(|_| "homeserver discovery returned an invalid redirect".to_string())?;
            continue;
        }
        if !response.status().is_success() {
            return Ok(origin);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_WELL_KNOWN_BYTES as u64)
        {
            return Err("homeserver discovery response was too large".to_string());
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|_| "homeserver discovery returned an invalid response".to_string())?;
            append_bounded_chunk(&mut body, &chunk, MAX_WELL_KNOWN_BYTES)?;
        }
        let discovered: ClientWellKnown = match serde_json::from_slice(&body) {
            Ok(discovered) => discovered,
            Err(_) => return Ok(origin),
        };
        return reqwest::Url::parse(&discovered.homeserver.base_url)
            .map_err(|_| "homeserver discovery returned an invalid base URL".to_string());
    }
    unreachable!("the bounded discovery loop always returns")
}

fn append_bounded_chunk(buffer: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), String> {
    if buffer.len().saturating_add(chunk.len()) > limit {
        return Err("homeserver discovery response was too large".to_string());
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

async fn validated_url_client(
    homeserver: reqwest::Url,
) -> Result<(reqwest::Url, reqwest::Client), String> {
    if !homeserver.username().is_empty() || homeserver.password().is_some() {
        return Err("enter a valid HTTPS homeserver URL".to_string());
    }
    let host = homeserver
        .host_str()
        .ok_or_else(|| "enter a valid HTTPS homeserver URL".to_string())?;
    let explicitly_local = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| !is_public_network_ip(ip));
    let allow_insecure_local = homeserver.scheme() == "http"
        && explicitly_local
        && std::env::var("CHARM_WEB_SERVER_INSECURE_COOKIES").as_deref() == Ok("1");
    if homeserver.scheme() != "https" && !allow_insecure_local {
        return Err("enter a valid HTTPS homeserver URL".to_string());
    }
    let port = homeserver
        .port_or_known_default()
        .ok_or_else(|| "enter a valid HTTPS homeserver URL".to_string())?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "could not resolve homeserver".to_string())?
        .collect::<Vec<_>>();
    if addresses.is_empty()
        || (!allow_insecure_local
            && !cfg!(test)
            && addresses
                .iter()
                .any(|address| !is_public_network_ip(address.ip())))
    {
        return Err("homeserver must resolve only to public addresses".to_string());
    }
    let http_client = reqwest::Client::builder()
        .resolve_to_addrs(host, &addresses)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "could not build homeserver client".to_string())?;
    Ok((homeserver, http_client))
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
            if segments[..6] == [0, 0, 0, 0, 0, 0] {
                let embedded = std::net::Ipv4Addr::new(
                    (segments[6] >> 8) as u8,
                    segments[6] as u8,
                    (segments[7] >> 8) as u8,
                    segments[7] as u8,
                );
                return is_public_network_ip(embedded.into());
            }
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
                || segments[0] == 0x5f00)
        }
    }
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
/// or full URL). Bare server-name discovery is performed above with Charm's
/// pinned, no-proxy HTTP policy before the SDK client is built.
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

#[cfg(test)]
mod tests {
    #[test]
    fn compatible_ipv6_uses_embedded_ipv4_policy() {
        for address in [
            "::127.0.0.1",
            "::10.0.0.1",
            "::192.168.1.1",
            "::169.254.169.254",
        ] {
            assert!(!super::is_public_network_ip(address.parse().unwrap()));
        }
        assert!(super::is_public_network_ip("::8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn discovery_body_limit_is_enforced_while_streaming() {
        let mut body = vec![0; 4];
        super::append_bounded_chunk(&mut body, &[1, 2], 6).expect("chunk reaches exact limit");
        assert_eq!(body.len(), 6);

        let error = super::append_bounded_chunk(&mut body, &[3], 6)
            .expect_err("chunk beyond limit must be rejected before buffering");
        assert_eq!(error, "homeserver discovery response was too large");
        assert_eq!(body.len(), 6, "rejected bytes must never enter the buffer");
    }

    #[tokio::test]
    async fn bare_server_names_reject_paths_before_discovery() {
        let error = super::discover_homeserver("example.org/not-a-server-name")
            .await
            .expect_err("a Matrix server name cannot contain a URL path");
        assert_eq!(
            error,
            "enter a valid Matrix server name or HTTPS homeserver URL"
        );
    }
}
