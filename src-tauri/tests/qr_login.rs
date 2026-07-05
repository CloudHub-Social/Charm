//! Real network proof that QR login (MSC4108) works end to end, no mocking:
//! two real matrix-sdk `Client`s perform the actual secure-channel + OAuth
//! device-code dance against a live, MAS-delegated Synapse instance.
//!
//! Device A (Charm, the "new device") generates the QR code —
//! `charm_lib::matrix::qr_login`'s production code path. Device B (the
//! "already signed in" phone in a real scenario) scans it and grants the
//! login; that role isn't exposed as a Tauri command anywhere in this app,
//! so this test drives it directly against matrix-sdk's own API. B first
//! needs a real, working OAuth session of its own — bootstrapped here by
//! walking MAS's actual hosted login + consent forms with a plain `reqwest`
//! client, the same technique `tests/sso_login.rs` uses for Dex.
//!
//! Requires the MAS-delegated homeserver stack from `dev/synapse/` (locally:
//! `synapse-mas` + `mas` + `mas-db`, see `docker-compose.yml` and
//! `configure-mas.sh`) or the equivalent GitHub Actions service containers.
//! This is a separate stack from the plain `synapse` instance the
//! password/registration/SSO tests use — MAS delegation replaces a
//! homeserver's native auth entirely, which would break those tests if
//! shared.

use charm_lib::matrix::qr_login::grant_client_metadata;
use matrix_sdk::authentication::oauth::ClientRegistrationData;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::Client;
use std::sync::Arc;
use tokio::sync::Mutex;

const HOMESERVER: &str = "http://localhost:8010";
const GRANT_REDIRECT_URI: &str = "http://localhost:0/callback";
const MAS_PASSWORD: &str = "testpass123";

/// Registers a brand new MAS user for this test run (`docker exec` +
/// `mas-cli manage register-user`, same tool `configure-mas.sh` uses).
/// Needed because a reused account would already have cross-signing set up
/// server-side from a previous run — `bootstrap_cross_signing_if_needed`
/// would then treat it as a no-op, leaving this fresh session with no local
/// private key material to export (exactly the `MissingCrossSigningKeys`
/// failure this test is designed to catch if the QR/grant flow itself ever
/// regresses).
fn register_fresh_mas_user() -> String {
    let username = format!("qr-test-{}", std::process::id());
    let status = std::process::Command::new("docker")
        .args([
            "exec",
            "charm-dev-mas",
            "mas-cli",
            "manage",
            "register-user",
            &username,
            "--password",
            MAS_PASSWORD,
            "--yes",
            "--ignore-password-complexity",
            "--config",
            "/config.yaml",
        ])
        .status()
        .expect("run mas-cli manage register-user");
    assert!(status.success(), "mas-cli manage register-user failed");
    username
}

/// Logs `client` in via a real browser-facing OAuth authorization-code walk
/// through MAS's hosted login + consent forms (cookie-jar `reqwest`,
/// following redirects manually — same technique as
/// `tests/sso_login.rs::drive_sso_flow_to_callback_url`), so it ends up with
/// a genuine working OAuth session before it plays the "already signed in"
/// granting role.
async fn log_in_via_mas(client: &Client, username: &str) -> reqwest::Client {
    let oauth = client.oauth();
    let metadata = grant_client_metadata().await;
    let metadata: Raw<_> = Raw::new(&metadata).expect("serialize client metadata");
    let registration_data = ClientRegistrationData::new(metadata);

    let redirect_uri: url::Url = GRANT_REDIRECT_URI.parse().expect("valid redirect URI");
    let auth_data = oauth
        .login(redirect_uri, None, Some(registration_data), None)
        .build()
        .await
        .expect("build authorization URL");

    let http = reqwest::Client::builder()
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build reqwest client");

    // 1. Follow MAS's redirect(s) to the login form (plain GETs).
    let mut page_url = reqwest::Url::parse(auth_data.url.as_str()).expect("parse auth URL");
    loop {
        let response = http
            .get(page_url.clone())
            .send()
            .await
            .expect("follow MAS redirect chain");
        if !response.status().is_redirection() {
            break;
        }
        let location = response
            .headers()
            .get("location")
            .expect("redirect has a location header")
            .to_str()
            .expect("location header is valid UTF-8");
        page_url = page_url.join(location).expect("resolve redirect location");
    }
    let login_page = http
        .get(page_url.clone())
        .send()
        .await
        .expect("reach the login page")
        .text()
        .await
        .expect("read login page body");
    let csrf = extract_attr(&login_page, "csrf").expect("login page has a csrf token");

    // 2. Submit the login form.
    let login_body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("csrf", &csrf)
        .append_pair("username", username)
        .append_pair("password", MAS_PASSWORD)
        .finish();
    let after_login = http
        .post(page_url.clone())
        .header("content-type", "application/x-www-form-urlencoded")
        .body(login_body)
        .send()
        .await
        .expect("submit login form");
    let consent_location = after_login
        .headers()
        .get("location")
        .expect("login redirects to the consent page")
        .to_str()
        .expect("location header is valid UTF-8")
        .to_string();
    let consent_url = page_url
        .join(&consent_location)
        .expect("resolve consent page location");

    // 3. Grant consent.
    let consent_page = http
        .get(consent_url.clone())
        .send()
        .await
        .expect("reach the consent page")
        .text()
        .await
        .expect("read consent page body");
    let consent_csrf = extract_attr(&consent_page, "csrf").expect("consent page has a csrf token");
    let consent_body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("csrf", &consent_csrf)
        .finish();
    let after_consent = http
        .post(consent_url)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(consent_body)
        .send()
        .await
        .expect("submit consent form");
    let callback_url = after_consent
        .headers()
        .get("location")
        .expect("consent redirects to our callback URL")
        .to_str()
        .expect("location header is valid UTF-8")
        .to_string();

    // 4. Complete the login on the real client.
    oauth
        .finish_login(
            callback_url
                .parse::<url::Url>()
                .expect("parse callback URL")
                .into(),
        )
        .await
        .expect("finish OAuth login");

    http
}

/// Approves the device-code grant MAS shows during QR login's device
/// authorization step (`GrantLoginProgress::WaitingForAuth`) — a second,
/// separate consent screen from the one `log_in_via_mas` already walked, but
/// the same shape (a bare csrf-protected form). Reuses `http`'s cookie jar
/// so it hits this page as the same already-logged-in MAS session.
async fn approve_device_code(http: &reqwest::Client, verification_uri: url::Url) {
    // `http` is built with Policy::none() (this whole file follows redirects
    // manually), so a `/link?code=...` redirect to the actual consent page
    // needs the same treatment as everywhere else here, or `.text()` below
    // reads the redirect's near-empty body instead of the consent form.
    let mut page_url =
        reqwest::Url::parse(verification_uri.as_str()).expect("parse device-code URL");
    loop {
        let response = http
            .get(page_url.clone())
            .send()
            .await
            .expect("follow device-code redirect chain");
        if !response.status().is_redirection() {
            break;
        }
        let location = response
            .headers()
            .get("location")
            .expect("redirect has a location header")
            .to_str()
            .expect("location header is valid UTF-8");
        page_url = page_url.join(location).expect("resolve redirect location");
    }
    let page = http
        .get(page_url.clone())
        .send()
        .await
        .expect("reach the device-code consent page")
        .text()
        .await
        .expect("read device-code consent page body");
    let csrf = extract_attr(&page, "csrf").expect("device-code consent page has a csrf token");
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("csrf", &csrf)
        .append_pair("action", "consent")
        .finish();
    let response = http
        .post(page_url)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .expect("submit device-code consent form");
    assert!(
        response.status().is_success() || response.status().is_redirection(),
        "device-code consent submission failed: {}",
        response.status()
    );
}

/// Extracts `name="{attr}" value="..."` from an HTML page — good enough for
/// MAS's hidden CSRF token inputs without pulling in a full HTML parser.
fn extract_attr(html: &str, attr: &str) -> Option<String> {
    let marker = format!(r#"name="{attr}" value=""#);
    let start = html.find(&marker)? + marker.len();
    let end = html[start..].find('"')? + start;
    Some(html[start..end].to_string())
}

#[tokio::test]
async fn qr_login_completes_with_a_real_working_session() {
    let username = register_fresh_mas_user();

    // Device B: the "already signed in" existing device. Needs a real
    // working session (with E2EE set up) before it can grant a login.
    let device_b = Client::builder()
        .homeserver_url(HOMESERVER)
        .build()
        .await
        .expect("build device B client");
    let http = log_in_via_mas(&device_b, &username).await;
    device_b
        .sync_once(SyncSettings::default())
        .await
        .expect("device B initial sync (activates E2EE)");
    device_b
        .encryption()
        .bootstrap_cross_signing_if_needed(None)
        .await
        .expect("bootstrap cross-signing on device B");
    device_b
        .sync_once(SyncSettings::default())
        .await
        .expect("device B post-bootstrap sync");

    // Device A: Charm itself, the "new device" generating the QR code —
    // exercises the actual production code path in charm_lib::matrix.
    let device_a = Client::builder()
        .homeserver_url(HOMESERVER)
        .build()
        .await
        .expect("build device A client");
    let a_metadata = matrix_sdk::authentication::oauth::registration::ClientMetadata::new(
        matrix_sdk::authentication::oauth::registration::ApplicationType::Native,
        vec![matrix_sdk::authentication::oauth::registration::OAuthGrantType::DeviceCode],
        matrix_sdk::authentication::oauth::registration::Localized::new(
            "https://charm.cloudhub.social/".parse().unwrap(),
            [],
        ),
    );
    let a_metadata: Raw<_> = Raw::new(&a_metadata).expect("serialize device A metadata");
    let a_registration_data = ClientRegistrationData::new(a_metadata);

    let oauth_a = device_a.oauth();
    let login = oauth_a
        .login_with_qr_code(Some(&a_registration_data))
        .generate();
    let mut a_progress = login.subscribe_to_progress();

    // Bridges A's generated QR code to B (in place of a real camera scan)
    // and B's check code back to A (in place of a human reading it off B's
    // screen and typing it into A) — the only two points where a real
    // device pairing needs a human or a camera; everything else is the
    // genuine MSC4108 protocol running over a real secure channel.
    let qr_code_data = Arc::new(Mutex::new(None));
    let check_code_sender = Arc::new(Mutex::new(None));

    let a_watcher = tokio::spawn({
        let qr_code_data = qr_code_data.clone();
        let check_code_sender = check_code_sender.clone();
        async move {
            use futures_util::StreamExt;
            use matrix_sdk::authentication::oauth::qrcode::{GeneratedQrProgress, LoginProgress};
            while let Some(update) = a_progress.next().await {
                match update {
                    LoginProgress::EstablishingSecureChannel(GeneratedQrProgress::QrReady(
                        data,
                    )) => {
                        *qr_code_data.lock().await = Some(data);
                    }
                    LoginProgress::EstablishingSecureChannel(GeneratedQrProgress::QrScanned(
                        sender,
                    )) => {
                        *check_code_sender.lock().await = Some(sender);
                    }
                    LoginProgress::Done => break,
                    _ => {}
                }
            }
        }
    });

    // `login` is a builder future borrowing `&a_registration_data`, so it
    // can't be `tokio::spawn`ed (needs `'static`) — but nothing drives its
    // internal state machine (and therefore the progress stream a_watcher is
    // reading) until it's actually polled somewhere. It has to run
    // concurrently with the "wait for the QR code, then run the grant side"
    // logic in the same `tokio::join!`, not be deferred to a join at the end
    // after already blocking on qr_code_data — that would deadlock exactly
    // as this comment's blank line above once did.
    let oauth_b = device_b.oauth();
    let (login_result, grant_result) = tokio::join!(login, async {
        let qr_data = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if let Some(data) = qr_code_data.lock().await.clone() {
                    break data;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("timed out waiting for the QR code data from device A's progress stream");

        let grant = oauth_b.grant_login_with_qr_code().scan(&qr_data);
        let mut b_progress = grant.subscribe_to_progress();

        let b_watcher = tokio::spawn({
            let check_code_sender = check_code_sender.clone();
            let http = http.clone();
            async move {
                use futures_util::StreamExt;
                use matrix_sdk::authentication::oauth::qrcode::{GrantLoginProgress, QrProgress};
                while let Some(update) = b_progress.next().await {
                    match update {
                        GrantLoginProgress::EstablishingSecureChannel(QrProgress {
                            check_code,
                        }) => {
                            let digit = check_code.to_digit();
                            loop {
                                if let Some(sender) = check_code_sender.lock().await.take() {
                                    sender
                                        .send(digit)
                                        .await
                                        .expect("send check code to device A");
                                    break;
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            }
                        }
                        GrantLoginProgress::WaitingForAuth { verification_uri } => {
                            approve_device_code(&http, verification_uri).await;
                            break;
                        }
                        _ => {}
                    }
                }
            }
        });

        let result = grant.await;
        b_watcher.abort();
        result
    });
    a_watcher.abort();

    login_result.expect("device A's QR login completes");
    grant_result.expect("device B's grant completes");

    let session = device_a
        .oauth()
        .full_session()
        .expect("device A has a full OAuth session after QR login");
    assert_eq!(
        session.user.meta.user_id.localpart(),
        username,
        "device A logged in as the account that granted it"
    );

    device_a
        .whoami()
        .await
        .expect("device A's freshly QR-logged-in session can make an authenticated request");
}
