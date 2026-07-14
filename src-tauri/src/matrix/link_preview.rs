//! Spec 29: link previews for URLs in message bodies.
//!
//! Calls the homeserver's `/preview_url` endpoint (authenticated media
//! `GET /_matrix/client/v1/media/preview_url`, falling back to the legacy
//! `GET /_matrix/media/r0/preview_url` for homeservers that don't yet
//! support the newer authenticated-media endpoint), and maps the returned
//! OpenGraph-ish JSON blob into a small typed struct.
//!
//! This never surfaces a hard failure to the frontend for anything
//! preview-shaped going wrong (404, malformed body, or a slow/hanging
//! server) — those all just mean "no preview", i.e. `Ok(None)`. The outer
//! `Result::Err` is reserved for real infrastructure failures (no active
//! session), matching the convention `get_cross_signing_reset_url` /
//! `get_device_delete_url` already use for "maybe nothing to show".

use std::time::Duration;

use matrix_sdk::ruma::api::client::authenticated_media::get_media_preview as auth_preview;
use matrix_sdk::ruma::api::client::media::get_media_preview as legacy_preview;
use matrix_sdk::ruma::{MilliSecondsSinceUnixEpoch, UInt};
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use ts_rs::TS;

use super::MatrixState;

/// Ceiling on a single preview_url round trip. The homeserver itself fetches
/// and scrapes the remote page server-side, which can hang far longer than a
/// normal API call if the target site is slow or unreachable — this bounds
/// how long a message row's preview fetch can block before giving up.
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(8);

/// Frontend-facing preview data for one URL. All fields are best-effort —
/// any of them may be absent depending on what the target page's OpenGraph
/// tags (or the homeserver's fallback scraping) actually provided.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct UrlPreview {
    pub title: Option<String>,
    pub description: Option<String>,
    /// `og:image`, as returned by the homeserver. Per the C-S API, this is
    /// typically an `mxc://` URI (the homeserver re-hosts the remote image),
    /// not a directly-loadable URL — resolve it the same way an avatar mxc
    /// URI is resolved (`resolve_avatar`) before use.
    pub image_url: Option<String>,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
    pub site_name: Option<String>,
}

impl UrlPreview {
    /// `None` if every field would be empty — a preview with nothing in it
    /// isn't worth rendering a card for.
    fn from_og_data(data: &Value) -> Option<Self> {
        let title = og_string(data, "og:title");
        let description = og_string(data, "og:description");
        let image_url = og_string(data, "og:image");
        let site_name = og_string(data, "og:site_name");
        let image_width = og_u32(data, "og:image:width");
        let image_height = og_u32(data, "og:image:height");

        if title.is_none() && description.is_none() && image_url.is_none() && site_name.is_none() {
            return None;
        }

        Some(UrlPreview {
            title,
            description,
            image_url,
            image_width,
            image_height,
            site_name,
        })
    }
}

fn og_string(data: &Value, key: &str) -> Option<String> {
    data.get(key)?
        .as_str()
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

fn og_u32(data: &Value, key: &str) -> Option<u32> {
    let value = data.get(key)?;
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .and_then(|n| u32::try_from(n).ok())
}

#[tauri::command]
pub async fn get_url_preview(
    state: State<'_, MatrixState>,
    // Accepted for parity with the spec's IPC contract and to leave room for
    // future room-scoped policy (e.g. per-room preview opt-out); the current
    // homeserver call itself is not room-scoped.
    room_id: String,
    url: String,
    // The message event's own timestamp, forwarded as `preview_url`'s `ts`
    // query param — per the C-S API spec, this asks the homeserver for the
    // preview data closest to that point in time rather than whatever's
    // current right now, so a preview rendered for an old message doesn't
    // show a page's current title/thumbnail if it changed since the message
    // was sent. `None` for messages with no known timestamp (shouldn't
    // normally happen) falls back to "current", the previous behavior.
    event_ts_ms: Option<i64>,
) -> Result<Option<UrlPreview>, String> {
    let _ = room_id;
    let client = state.require_client().await?;
    Ok(get_url_preview_impl(&client, url, event_ts_ms).await)
}

pub async fn get_url_preview_impl(
    client: &Client,
    url: String,
    event_ts_ms: Option<i64>,
) -> Option<UrlPreview> {
    let ts =
        event_ts_ms.map(|ms| MilliSecondsSinceUnixEpoch(UInt::new_saturating(ms.max(0) as u64)));
    let data = fetch_preview_data(client, url, ts, PREVIEW_TIMEOUT).await?;
    UrlPreview::from_og_data(&data)
}

/// Tries the modern authenticated-media endpoint first, then the deprecated
/// legacy one. Any failure at either step (timeout, transport error, 404,
/// malformed JSON body) is swallowed and treated as "no data" rather than
/// propagated — see the module doc comment.
///
/// Both attempts share **one** outer `timeout` budget (wrapping the whole
/// sequential try-auth-then-try-legacy attempt in a single
/// `tokio::time::timeout`), not one independent timeout per attempt — a
/// homeserver that's slow/unresponsive on both endpoints previously could
/// block for up to `2 * timeout` (each of `fetch_auth`/`fetch_legacy` timing
/// out on its own), well past the documented ceiling. `timeout` stays a
/// parameter (rather than always reading [`PREVIEW_TIMEOUT`]) purely so the
/// test suite can exercise the timeout path without waiting out the real
/// production budget.
async fn fetch_preview_data(
    client: &Client,
    url: String,
    ts: Option<MilliSecondsSinceUnixEpoch>,
    timeout: Duration,
) -> Option<Value> {
    tokio::time::timeout(timeout, async {
        if let Some(data) = fetch_auth(client, url.clone(), ts).await {
            return Some(data);
        }
        fetch_legacy(client, url, ts).await
    })
    .await
    .ok()
    .flatten()
}

async fn fetch_auth(
    client: &Client,
    url: String,
    ts: Option<MilliSecondsSinceUnixEpoch>,
) -> Option<Value> {
    let mut request = auth_preview::v1::Request::new(url);
    request.ts = ts;
    let response = client.send(request).await.ok()?;

    let raw = response.data?;
    serde_json::from_str(raw.get()).ok()
}

#[allow(deprecated)]
async fn fetch_legacy(
    client: &Client,
    url: String,
    ts: Option<MilliSecondsSinceUnixEpoch>,
) -> Option<Value> {
    let mut request = legacy_preview::v3::Request::new(url);
    request.ts = ts;
    let response = client.send(request).await.ok()?;

    let raw = response.data?;
    serde_json::from_str(raw.get()).ok()
}

#[cfg(test)]
mod tests {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::matchers::{method, path, path_regex, query_param};
    use wiremock::{Mock, ResponseTemplate};

    use super::*;

    #[tokio::test]
    async fn success_maps_og_fields() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        Mock::given(method("GET"))
            .and(path("/_matrix/client/v1/media/preview_url"))
            .and(query_param("url", "https://example.com"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "og:title": "Example Domain",
                "og:description": "An example site.",
                "og:image": "mxc://example.org/abc123",
                "og:image:width": 800,
                "og:image:height": 600,
                "og:site_name": "Example",
            })))
            .mount(server.server())
            .await;

        let preview = get_url_preview_impl(&client, "https://example.com".to_string(), None)
            .await
            .expect("expected a preview");

        assert_eq!(preview.title.as_deref(), Some("Example Domain"));
        assert_eq!(preview.description.as_deref(), Some("An example site."));
        assert_eq!(
            preview.image_url.as_deref(),
            Some("mxc://example.org/abc123")
        );
        assert_eq!(preview.image_width, Some(800));
        assert_eq!(preview.image_height, Some(600));
        assert_eq!(preview.site_name.as_deref(), Some("Example"));
    }

    /// Regression test: an `event_ts_ms` must forward as `preview_url`'s
    /// `ts` query param, so a preview rendered for an old message asks the
    /// homeserver for the preview near the message's own timestamp rather
    /// than the page's current state. The mock only matches a request with
    /// exactly this `ts` value — a request missing it (or carrying the
    /// wrong one) 404s and the call returns `None`.
    #[tokio::test]
    async fn event_ts_ms_forwards_as_the_ts_query_param() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        Mock::given(method("GET"))
            .and(path("/_matrix/client/v1/media/preview_url"))
            .and(query_param("url", "https://example.com"))
            .and(query_param("ts", "1700000000000"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "og:title": "Historical Example",
            })))
            .mount(server.server())
            .await;

        let preview = get_url_preview_impl(
            &client,
            "https://example.com".to_string(),
            Some(1700000000000),
        )
        .await
        .expect("expected a preview matched on the ts query param");

        assert_eq!(preview.title.as_deref(), Some("Historical Example"));
    }

    #[tokio::test]
    async fn not_found_falls_back_then_returns_none() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        Mock::given(method("GET"))
            .and(path("/_matrix/client/v1/media/preview_url"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_NOT_FOUND",
                "error": "Not found",
            })))
            .mount(server.server())
            .await;

        Mock::given(method("GET"))
            .and(path_regex(r"^/_matrix/media/(r0|v3)/preview_url$"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_NOT_FOUND",
                "error": "Not found",
            })))
            .mount(server.server())
            .await;

        let preview =
            get_url_preview_impl(&client, "https://example.com/missing".to_string(), None).await;
        assert!(preview.is_none());
    }

    #[tokio::test]
    async fn legacy_fallback_used_when_modern_endpoint_unavailable() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        Mock::given(method("GET"))
            .and(path("/_matrix/client/v1/media/preview_url"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_UNRECOGNIZED",
                "error": "Unrecognized endpoint",
            })))
            .mount(server.server())
            .await;

        Mock::given(method("GET"))
            .and(path_regex(r"^/_matrix/media/(r0|v3)/preview_url$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "og:title": "Legacy Example",
            })))
            .mount(server.server())
            .await;

        let preview = get_url_preview_impl(&client, "https://example.com".to_string(), None)
            .await
            .expect("legacy endpoint should have produced a preview");

        assert_eq!(preview.title.as_deref(), Some("Legacy Example"));
    }

    #[tokio::test]
    async fn malformed_json_body_returns_none() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        Mock::given(method("GET"))
            .and(path("/_matrix/client/v1/media/preview_url"))
            .respond_with(ResponseTemplate::new(200).set_body_raw("not json", "application/json"))
            .mount(server.server())
            .await;

        Mock::given(method("GET"))
            .and(path_regex(r"^/_matrix/media/(r0|v3)/preview_url$"))
            .respond_with(ResponseTemplate::new(200).set_body_raw("not json", "application/json"))
            .mount(server.server())
            .await;

        let preview = get_url_preview_impl(&client, "https://example.com".to_string(), None).await;
        assert!(preview.is_none());
    }

    #[tokio::test]
    async fn empty_og_data_returns_none() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        Mock::given(method("GET"))
            .and(path("/_matrix/client/v1/media/preview_url"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(server.server())
            .await;

        let preview = get_url_preview_impl(&client, "https://example.com".to_string(), None).await;
        assert!(preview.is_none());
    }

    #[tokio::test]
    async fn timeout_returns_none() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let generous_server_delay = Duration::from_millis(200);
        let tiny_client_timeout = Duration::from_millis(20);

        Mock::given(method("GET"))
            .and(path("/_matrix/client/v1/media/preview_url"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "og:title": "Too slow" }))
                    .set_delay(generous_server_delay),
            )
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/_matrix/media/(r0|v3)/preview_url$"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "og:title": "Too slow" }))
                    .set_delay(generous_server_delay),
            )
            .mount(server.server())
            .await;

        let data = fetch_preview_data(
            &client,
            "https://example.com".to_string(),
            None,
            tiny_client_timeout,
        )
        .await;
        assert!(data.is_none());
    }

    /// Regression test: both attempts (auth then legacy) must share **one**
    /// timeout budget, not one independent timeout each. Both endpoints are
    /// mocked to hang far past `budget`; under the pre-fix behavior (each
    /// attempt getting its own `budget`-length timeout) this would take
    /// ~`2 * budget` wall-clock time to resolve. Asserts total elapsed stays
    /// well under `2 * budget`, proving the second attempt doesn't get a
    /// fresh timeout after the first one expires.
    #[tokio::test]
    async fn total_wait_across_both_attempts_stays_within_one_timeout_budget() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let hangs_forever = Duration::from_secs(3600);
        let budget = Duration::from_millis(100);

        Mock::given(method("GET"))
            .and(path("/_matrix/client/v1/media/preview_url"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "og:title": "Too slow" }))
                    .set_delay(hangs_forever),
            )
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/_matrix/media/(r0|v3)/preview_url$"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "og:title": "Too slow" }))
                    .set_delay(hangs_forever),
            )
            .mount(server.server())
            .await;

        let started = std::time::Instant::now();
        let data =
            fetch_preview_data(&client, "https://example.com".to_string(), None, budget).await;
        let elapsed = started.elapsed();

        assert!(data.is_none());
        // Well under 2 * budget (200ms) — if the auth attempt's own timeout
        // fired and a *second* fresh `budget` timeout then applied to the
        // legacy attempt, this would take roughly 200ms+.
        assert!(
            elapsed < Duration::from_millis(180),
            "expected total wait to stay within one timeout budget (~100ms), took {elapsed:?}",
        );
    }
}
