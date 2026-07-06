//! Real network proof that SSO login works end to end, no mocking: drives
//! the actual Synapse -> Dex -> Synapse OIDC redirect chain with a plain
//! `reqwest` client (cookie jar, following redirects manually), exactly like
//! a browser would, then hands the resulting `charm://sso-callback` URL to
//! [`complete_sso_login_with_callback`] and proves the session it produces
//! is real by calling `whoami()`.
//!
//! Requires the local Dex + Synapse OIDC setup from `dev/synapse/` (locally)
//! or the equivalent GitHub Actions service containers (CI) — see
//! `dev/synapse/configure-homeserver.sh` and `dev/synapse/dex-config.yaml`.
//! The `sso-test` / `testpass123` account is a static, hardcoded credential
//! in Dex's local-only "staticPasswords" connector — not a real identity, so
//! it's fine to keep it out of GH secrets, unlike the Synapse test account in
//! `tests/common`.

mod common;

use charm_lib::matrix::auth::{complete_sso_login_with_callback, get_sso_login_url};
use common::HOMESERVER;
use matrix_sdk::Client;

const DEX_USERNAME: &str = "sso-test@localhost";
const DEX_PASSWORD: &str = "testpass123";
const REDIRECT_URL: &str = "charm://sso-callback";

/// Walks the full browser-facing redirect chain and returns the final
/// `charm://sso-callback?loginToken=...` URL, without ever needing a real
/// browser or a headless one — Dex's local-password connector is a plain
/// HTML form POST, and Synapse's SSO redirect/callback are plain HTTP
/// redirects.
async fn drive_sso_flow_to_callback_url(sso_login_url: &str) -> String {
    // Policy::none() rather than an auto-following policy: steps 2 and 3
    // below need the raw `Location` header of a 302/303 response (to build
    // the *next*, differently-shaped request — a POST, not a followed GET),
    // so every redirect in this flow is followed manually.
    let http = reqwest::Client::builder()
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build reqwest client");

    // 1. Follow Synapse's redirect(s) through to Dex's login form (plain
    //    GETs the whole way, so following manually is just a loop).
    let mut login_page_url = reqwest::Url::parse(sso_login_url).expect("parse SSO login URL");
    loop {
        let response = http
            .get(login_page_url.clone())
            .send()
            .await
            .expect("follow SSO redirect chain");
        if !response.status().is_redirection() {
            break;
        }
        let location = response
            .headers()
            .get("location")
            .expect("redirect response has a location header")
            .to_str()
            .expect("location header is valid UTF-8");
        login_page_url = login_page_url
            .join(location)
            .expect("resolve redirect location against the current URL");
    }

    // 2. Submit the static-password login form.
    let login_body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("login", DEX_USERNAME)
        .append_pair("password", DEX_PASSWORD)
        .finish();
    let after_login = http
        .post(login_page_url.clone())
        .header("content-type", "application/x-www-form-urlencoded")
        .body(login_body)
        .send()
        .await
        .expect("submit Dex login form");
    let approval_location = after_login
        .headers()
        .get("location")
        .expect("login redirects to the approval page")
        .to_str()
        .expect("location header is valid UTF-8")
        .to_string();
    let approval_url = login_page_url
        .join(&approval_location)
        .expect("resolve the approval page location");

    let hmac = approval_url
        .query_pairs()
        .find(|(k, _)| k == "hmac")
        .map(|(_, v)| v.into_owned())
        .expect("approval URL has an hmac param");
    let req = approval_url
        .query_pairs()
        .find(|(k, _)| k == "req")
        .map(|(_, v)| v.into_owned())
        .expect("approval URL has a req param");

    // 3. Grant the (one-time) consent screen.
    let approval_body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("req", &req)
        .append_pair("approval", "approve")
        .append_pair("hmac", &hmac)
        .finish();
    let after_approval = http
        .post("http://localhost:5556/dex/approval")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(approval_body)
        .send()
        .await
        .expect("submit Dex approval form");
    let synapse_callback_url = after_approval
        .headers()
        .get("location")
        .expect("approval redirects to Synapse's OIDC callback")
        .to_str()
        .expect("location header is valid UTF-8")
        .to_string();

    // 4. Synapse completes the exchange and shows a "Continue to your
    //    account" page linking to our (non-http, so un-followable) redirect
    //    scheme — extract the link rather than expect a real redirect.
    let page = http
        .get(&synapse_callback_url)
        .send()
        .await
        .expect("reach Synapse's OIDC callback")
        .text()
        .await
        .expect("read callback page body");

    let marker = format!("{REDIRECT_URL}?");
    let start = page
        .find(&marker)
        .expect("callback page links to charm://sso-callback");
    let rest = &page[start..];
    let end = rest
        .find('"')
        .expect("closing quote after the callback URL");
    // The link lives in an HTML href attribute, so multi-param query strings
    // come back with their "&" separators HTML-entity-encoded.
    rest[..end].replace("&amp;", "&")
}

#[tokio::test]
async fn sso_login_completes_with_a_real_working_session() {
    let client = Client::builder()
        .homeserver_url(HOMESERVER)
        .build()
        .await
        .expect("build client");

    // Uses charm_lib's own get_sso_login_url (not matrix_sdk's directly) so
    // this test exercises the real redirect_url shape production code
    // builds, including the `state` query param `complete_sso_login`
    // verifies — the actual thing being proven here is that Synapse
    // preserves that param through its whole redirect chain rather than
    // stripping or reordering it, which is easy to assume wrong without a
    // real end-to-end check.
    let attempt_state = "test-attempt-state-12345";
    let sso_login_url = get_sso_login_url(&client, attempt_state)
        .await
        .expect("get_sso_login_url succeeds");

    let callback_url = drive_sso_flow_to_callback_url(&sso_login_url).await;
    assert!(
        callback_url.contains(&format!("state={attempt_state}")),
        "callback URL should still carry our state param: {callback_url}"
    );

    complete_sso_login_with_callback(&client, &callback_url)
        .await
        .expect("SSO login completes");

    let session = client
        .matrix_auth()
        .session()
        .expect("a session is set on the client after SSO login");
    assert_eq!(session.meta.user_id.localpart(), "sso-test");

    client
        .whoami()
        .await
        .expect("the freshly SSO-logged-in session can make an authenticated request");
}
