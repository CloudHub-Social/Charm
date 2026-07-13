//! Integration tests against a real homeserver (same convention as
//! `src-tauri/tests/common/mod.rs`: `TEST_MATRIX_USERNAME`/`TEST_MATRIX_PASSWORD`
//! env vars, defaulting to the local dev Synapse's `evie`/`testpass123`).
//!
//! Uses `tower::ServiceExt::oneshot` to drive the real axum `Router` in
//! process, rather than spinning up a TCP listener — same router
//! `charm-web-server`'s `main.rs` serves, just exercised in-memory. Each test
//! builds its own `AppState`/router (so tests don't share session state with
//! each other) but reuses that *same* router/state across every request it
//! makes, since a session created against one `SessionStore` is meaningless
//! against another.

use axum::body::Body;
use axum::http::{HeaderValue, Request, StatusCode};
use axum::Router;
use charm_web_server::{routes, session::SessionStore, AppState};
use serde_json::{json, Value};
use tower::ServiceExt;

const HOMESERVER: &str = "http://localhost:8008";
const ALLOWED_ORIGIN_ENV: &str = "CHARM_WEB_SERVER_ALLOWED_ORIGIN";
const TEST_ALLOWED_ORIGIN: &str = "https://charm.example.test";
static ALLOWED_ORIGIN_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct EnvVarGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }

    fn remove(key: &'static str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::remove_var(key);
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.previous {
            std::env::set_var(self.key, value);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

fn test_username() -> String {
    std::env::var("TEST_MATRIX_USERNAME").unwrap_or_else(|_| "evie".to_string())
}

fn test_password() -> String {
    std::env::var("TEST_MATRIX_PASSWORD").unwrap_or_else(|_| "testpass123".to_string())
}

fn app() -> Router {
    routes::router(AppState {
        sessions: SessionStore::new(),
        persistence: None,
    })
}

async fn request(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    json_body: Option<Value>,
) -> axum::http::Response<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    let body = match json_body {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    app.clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap()
}

/// Extracts the `charm_session` cookie value from a response's `Set-Cookie`
/// header, panicking if login didn't set one.
fn session_cookie_from(response: &axum::http::Response<Body>) -> String {
    let set_cookie = response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .expect("login response should set a session cookie")
        .to_str()
        .unwrap();
    // `charm_session=<token>; HttpOnly; SameSite=Strict; ...` — just need the
    // first `name=value` segment to round-trip as a `Cookie` request header.
    set_cookie.split(';').next().unwrap().to_string()
}

async fn body_json(response: axum::http::Response<Body>) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// Logs in against `app` and returns the session cookie to use on subsequent
/// requests against that *same* router/state.
async fn login_and_get_cookie(app: &Router) -> String {
    let response = request(
        app,
        "POST",
        "/api/auth/login",
        None,
        Some(json!({
            "homeserver_url": HOMESERVER,
            "username": test_username(),
            "password": test_password(),
        })),
    )
    .await;

    assert_eq!(
        response.status(),
        StatusCode::OK,
        "login should succeed against the local dev homeserver"
    );
    session_cookie_from(&response)
}

#[tokio::test]
async fn login_issues_a_session_cookie() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;
    assert!(cookie.starts_with("charm_session="));
    assert!(
        cookie.len() > "charm_session=".len(),
        "session token should be non-empty"
    );
}

#[tokio::test]
async fn authenticated_route_works_with_session_cookie() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    let response = request(&app, "GET", "/api/auth/me", Some(&cookie), None).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(
        body["user_id"].as_str().unwrap(),
        format!("@{}:localhost", test_username())
    );
}

#[tokio::test]
async fn unauthenticated_route_is_rejected() {
    let app = app();
    let response = request(&app, "GET", "/api/auth/me", None, None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn unauthenticated_route_is_rejected_with_bogus_cookie() {
    let app = app();
    let response = request(
        &app,
        "GET",
        "/api/auth/me",
        Some("charm_session=not-a-real-token"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn list_rooms_returns_an_array() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    let response = request(&app, "GET", "/api/rooms", Some(&cookie), None).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert!(body.is_array());
}

/// Sends a message into the first room the account is a member of — the
/// dev/CI Synapse setup (see `src-tauri/tests/common`) is expected to have
/// the test account joined to at least one room.
#[tokio::test]
async fn send_message_into_a_room() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    let rooms_response = request(&app, "GET", "/api/rooms", Some(&cookie), None).await;
    let rooms = body_json(rooms_response).await;
    let rooms = rooms.as_array().expect("rooms should be an array");
    let Some(room) = rooms.first() else {
        // No shared room configured for this environment — nothing to
        // exercise the send path against. Other tests already cover
        // auth/session behavior without needing a room to exist.
        eprintln!("skipping send_message_into_a_room: test account has no rooms");
        return;
    };
    let room_id = room["room_id"].as_str().unwrap();

    let response = request(
        &app,
        "POST",
        &format!("/api/rooms/{room_id}/send"),
        Some(&cookie),
        Some(json!({ "body": "hello from charm-web-server's test suite" })),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert!(body.is_string(), "response should be the sent event id");
}

/// Spec 19 Phase 4: `create_space` must return the new room's id as a bare
/// JSON string (like `resolve_room_alias`/`join_room`), not a
/// `204 No Content` — the frontend's `CreateJoinSpaceDialog` navigates
/// straight to whatever id this resolves to.
#[tokio::test]
async fn create_space_returns_the_new_room_id() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    let response = request(
        &app,
        "POST",
        "/api/rooms/create-space",
        Some(&cookie),
        Some(json!({
            "name": "charm-web-server test space",
            "topic": null,
            "room_alias_name": null,
            "public": false,
        })),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    let room_id = body.as_str().expect("response should be the new room id");
    assert!(room_id.starts_with('!'), "got {room_id:?}");
}

/// Spec 19 Phase 4: `join_room` must return the resolved room id and
/// whether it's a space (not `204 No Content`) so the frontend can
/// navigate to it even when the caller only supplied an alias — joins the
/// space this test itself just created, by its own room id, since that's
/// guaranteed joinable without depending on any fixture room/alias
/// existing in the test environment.
#[tokio::test]
async fn join_room_returns_the_resolved_room_id() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    let created = body_json(
        request(
            &app,
            "POST",
            "/api/rooms/create-space",
            Some(&cookie),
            Some(json!({
                "name": "charm-web-server join-room test space",
                "topic": null,
                "room_alias_name": null,
                "public": false,
            })),
        )
        .await,
    )
    .await;
    let created_room_id = created.as_str().expect("create-space should return an id");

    // `is_space` reads the client's local sync state (the `m.room.create`
    // event's `type` field), which can lag a moment behind the room having
    // just been created in this same test run — unlike `room_id`, which the
    // join response always has immediately. Retry the (idempotent, since
    // we're already joined) join a few times rather than asserting on the
    // first response.
    let mut body = None;
    for _ in 0..10 {
        let response = request(
            &app,
            "POST",
            "/api/rooms/join",
            Some(&cookie),
            Some(json!({ "room_id_or_alias": created_room_id })),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let candidate = body_json(response).await;
        if candidate["is_space"].as_bool() == Some(true) {
            body = Some(candidate);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    let body = body.expect("room should sync as a space within the retry window");
    assert_eq!(body["room_id"].as_str(), Some(created_room_id));
    assert_eq!(body["is_space"].as_bool(), Some(true));
}

#[tokio::test]
async fn logout_clears_the_session() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    let logout_response = request(&app, "POST", "/api/auth/logout", Some(&cookie), None).await;
    assert_eq!(logout_response.status(), StatusCode::NO_CONTENT);

    let me_response = request(&app, "GET", "/api/auth/me", Some(&cookie), None).await;
    assert_eq!(me_response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn raw_body_origin_guard_rejects_malformed_origin_header() {
    let _env_lock = ALLOWED_ORIGIN_ENV_LOCK.lock().await;
    let _env_guard = EnvVarGuard::set(ALLOWED_ORIGIN_ENV, TEST_ALLOWED_ORIGIN);

    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header("cookie", &cookie)
                .header(
                    axum::http::header::ORIGIN,
                    HeaderValue::from_bytes(&[0xff]).unwrap(),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------
// Sub-PR B: verification / cross-signing routes
// ---------------------------------------------------------------------

#[tokio::test]
async fn cross_signing_status_is_readable_after_login() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    let response = request(
        &app,
        "GET",
        "/api/verification/cross-signing",
        Some(&cookie),
        None,
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    // Just needs to be readable/well-shaped — whether this account has
    // already bootstrapped cross-signing depends on the test environment.
    assert!(body["has_identity"].is_boolean());
    assert!(body["has_master_key"].is_boolean());
}

#[tokio::test]
async fn verification_routes_reject_an_unknown_flow() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    let response = request(
        &app,
        "POST",
        "/api/verification/@nobody:localhost/not-a-real-flow/accept",
        Some(&cookie),
        None,
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn verification_routes_require_a_session() {
    let app = app();
    let response = request(&app, "GET", "/api/verification/cross-signing", None, None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------
// Sub-PR B: avatar upload
// ---------------------------------------------------------------------

#[tokio::test]
async fn avatar_upload_and_removal_round_trip() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    // A 1x1 transparent PNG — small enough to be a cheap, real upload rather
    // than a mocked one, exercising the actual `upload_avatar` SDK call
    // against the dev homeserver.
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    let put_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/profile/avatar")
                .header("cookie", &cookie)
                .body(Body::from(TINY_PNG))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(put_response.status(), StatusCode::NO_CONTENT);

    let remove_response = request(&app, "DELETE", "/api/profile/avatar", Some(&cookie), None).await;
    assert_eq!(remove_response.status(), StatusCode::NO_CONTENT);
}

// ---------------------------------------------------------------------
// Sub-PR B: WebSocket event channel
// ---------------------------------------------------------------------

/// `oneshot` can't drive a real protocol upgrade, so the WS tests below bind
/// a real TCP listener and serve `app` on it — same router `main.rs` serves,
/// just on an ephemeral port instead of `CHARM_WEB_SERVER_ADDR`.
async fn serve_for_websocket_test(
    app: Router,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, handle)
}

fn websocket_request(
    addr: std::net::SocketAddr,
    cookie: Option<&str>,
    origin: Option<&str>,
) -> tokio_tungstenite::tungstenite::http::Request<()> {
    let mut builder = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(format!("ws://{addr}/api/ws"))
        .header("host", addr.to_string())
        .header("connection", "upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header(
            "sec-websocket-key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        );
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    if let Some(origin) = origin {
        builder = builder.header("origin", origin);
    }
    builder.body(()).unwrap()
}

#[tokio::test]
async fn websocket_upgrade_is_rejected_without_a_session_cookie() {
    let _env_lock = ALLOWED_ORIGIN_ENV_LOCK.lock().await;
    let _env_guard = EnvVarGuard::set(ALLOWED_ORIGIN_ENV, TEST_ALLOWED_ORIGIN);

    let app = app();
    let (addr, _server) = serve_for_websocket_test(app).await;

    let request = websocket_request(addr, None, Some(TEST_ALLOWED_ORIGIN));
    let result = tokio_tungstenite::connect_async(request).await;
    assert!(
        result.is_err(),
        "an unauthenticated WebSocket upgrade must be rejected"
    );
}

#[tokio::test]
async fn websocket_upgrade_is_rejected_when_allowed_origin_is_unset() {
    let _env_lock = ALLOWED_ORIGIN_ENV_LOCK.lock().await;
    let _env_guard = EnvVarGuard::remove(ALLOWED_ORIGIN_ENV);

    let app = app();
    let cookie = login_and_get_cookie(&app).await;
    let (addr, _server) = serve_for_websocket_test(app).await;

    let request = websocket_request(addr, Some(&cookie), Some(TEST_ALLOWED_ORIGIN));
    let result = tokio_tungstenite::connect_async(request).await;
    assert!(
        result.is_err(),
        "an authenticated WebSocket upgrade with an Origin must be rejected when \
         CHARM_WEB_SERVER_ALLOWED_ORIGIN is unset"
    );
}

/// End-to-end: log in (which spawns this session's background sync loop —
/// see `sync_loop::spawn`), connect a WebSocket with that session's cookie,
/// and confirm *some* `ServerEvent` actually arrives — proving the sync
/// loop's events reach a real WebSocket client, not just the in-process
/// broadcast channel `isolation.rs` exercises directly.
///
/// Deliberately doesn't assert on a specific event like `sync:state`: that
/// one is only ever sent once, right as the sync loop starts, and the
/// broadcast channel doesn't replay history to a subscriber that connects
/// after it already fired — `login_and_get_cookie` returning doesn't
/// guarantee the spawned sync-loop task has reached that point yet, and on a
/// fast local homeserver it easily can have. `room_list:update`/
/// `badge:update`, by contrast, are re-sent on every steady-state sync
/// iteration for as long as the loop runs, so accepting any event here (not
/// just the first one) avoids that race without weakening what the test
/// actually proves.
#[tokio::test]
async fn websocket_receives_events_after_login() {
    use futures_util::StreamExt;

    let _env_lock = ALLOWED_ORIGIN_ENV_LOCK.lock().await;
    let _env_guard = EnvVarGuard::set(ALLOWED_ORIGIN_ENV, TEST_ALLOWED_ORIGIN);

    let app = app();
    let cookie = login_and_get_cookie(&app).await;
    let (addr, _server) = serve_for_websocket_test(app).await;

    let request = websocket_request(addr, Some(&cookie), Some(TEST_ALLOWED_ORIGIN));

    let (mut ws, _response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("authenticated WebSocket upgrade should succeed");

    let received = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while let Some(Ok(msg)) = ws.next().await {
            if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                let value: Value = serde_json::from_str(&text).unwrap();
                return value;
            }
        }
        panic!("WebSocket closed before any event arrived");
    })
    .await
    .expect("should receive at least one ServerEvent within 30s of connecting");

    assert!(
        received["event"].is_string(),
        "event envelope must be tagged"
    );
}
