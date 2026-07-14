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
) -> Result<Option<UrlPreview>, String> {
    let _ = room_id;
    let client = state.require_client().await?;
    Ok(get_url_preview_impl(&client, url).await)
}

pub async fn get_url_preview_impl(client: &Client, url: String) -> Option<UrlPreview> {
    let data = fetch_preview_data(client, url, PREVIEW_TIMEOUT).await?;
    UrlPreview::from_og_data(&data)
}

/// Tries the modern authenticated-media endpoint first, then the deprecated
/// legacy one. Any failure at either step (timeout, transport error, 404,
/// malformed JSON body) is swallowed and treated as "no data" rather than
/// propagated — see the module doc comment. `timeout` is a parameter (rather
/// than always reading [`PREVIEW_TIMEOUT`]) purely so the test suite can
/// exercise the timeout path without waiting out the real production budget.
async fn fetch_preview_data(client: &Client, url: String, timeout: Duration) -> Option<Value> {
    if let Some(data) = fetch_auth(client, url.clone(), timeout).await {
        return Some(data);
    }

    fetch_legacy(client, url, timeout).await
}

async fn fetch_auth(client: &Client, url: String, timeout: Duration) -> Option<Value> {
    let request = auth_preview::v1::Request::new(url);
    let response = tokio::time::timeout(timeout, client.send(request))
        .await
        .ok()? // timed out
        .ok()?; // transport/HTTP-status error (404 included)

    let raw = response.data?;
    serde_json::from_str(raw.get()).ok()
}

#[allow(deprecated)]
async fn fetch_legacy(client: &Client, url: String, timeout: Duration) -> Option<Value> {
    let request = legacy_preview::v3::Request::new(url);
    let response = tokio::time::timeout(timeout, client.send(request))
        .await
        .ok()? // timed out
        .ok()?; // transport/HTTP-status error (404 included)

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

        let preview = get_url_preview_impl(&client, "https://example.com".to_string())
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
            get_url_preview_impl(&client, "https://example.com/missing".to_string()).await;
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

        let preview = get_url_preview_impl(&client, "https://example.com".to_string())
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

        let preview = get_url_preview_impl(&client, "https://example.com".to_string()).await;
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

        let preview = get_url_preview_impl(&client, "https://example.com".to_string()).await;
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
            tiny_client_timeout,
        )
        .await;
        assert!(data.is_none());
    }
}
