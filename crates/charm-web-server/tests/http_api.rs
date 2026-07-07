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
use axum::http::{Request, StatusCode};
use axum::Router;
use charm_web_server::{routes, session::SessionStore, AppState};
use serde_json::{json, Value};
use tower::ServiceExt;

const HOMESERVER: &str = "http://localhost:8008";

fn test_username() -> String {
    std::env::var("TEST_MATRIX_USERNAME").unwrap_or_else(|_| "evie".to_string())
}

fn test_password() -> String {
    std::env::var("TEST_MATRIX_PASSWORD").unwrap_or_else(|_| "testpass123".to_string())
}

fn app() -> Router {
    routes::router(AppState {
        sessions: SessionStore::new(),
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

#[tokio::test]
async fn logout_clears_the_session() {
    let app = app();
    let cookie = login_and_get_cookie(&app).await;

    let logout_response = request(&app, "POST", "/api/auth/logout", Some(&cookie), None).await;
    assert_eq!(logout_response.status(), StatusCode::NO_CONTENT);

    let me_response = request(&app, "GET", "/api/auth/me", Some(&cookie), None).await;
    assert_eq!(me_response.status(), StatusCode::UNAUTHORIZED);
}
