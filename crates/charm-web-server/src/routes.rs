//! HTTP routes. Each authenticated route resolves the caller's session from
//! their cookie, then calls straight into the same `charm_lib::matrix::*`
//! `_impl` function the desktop Tauri commands use, and serializes the
//! result as JSON.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};

use charm_lib::matrix::account_data::{get_account_data_impl, set_account_data_impl};
use charm_lib::matrix::actions::{
    can_redact_impl, edit_message_impl, redact_event_impl, send_reply_impl, toggle_reaction_impl,
};
use charm_lib::matrix::auth::{DiscoverHomeserverResponse, LoginRequest, RegisterRequest};
use charm_lib::matrix::commands::run_command_impl;
use charm_lib::matrix::commands::SlashCommand;
use charm_lib::matrix::ephemeral::{mark_room_read_impl, send_read_receipt_impl, send_typing_impl};
use charm_lib::matrix::members::get_room_members_impl;
use charm_lib::matrix::presence::{get_presence_impl, set_presence_impl, PresenceStateDto};
use charm_lib::matrix::profiles::get_own_profile_impl;
use charm_lib::matrix::room_admin::{
    ban_member_impl, build_room_details, enable_room_encryption_impl, get_room_member_list_impl,
    invite_member_impl, kick_member_impl, remove_room_avatar_impl, set_member_power_level_impl,
    set_room_history_visibility_impl, set_room_join_rule_impl, set_room_name_impl,
    set_room_power_level_thresholds_impl, set_room_topic_impl, unban_member_impl,
    HistoryVisibilityKind, JoinRuleKind, PowerLevelThresholds,
};
use charm_lib::matrix::rooms::{
    resolve_alias, set_room_favourite_impl, set_room_low_priority_impl, set_room_manual_order_impl,
    set_room_marked_unread_impl, snapshot_rooms,
};
use charm_lib::matrix::send::{
    attachment_info_for, build_message_content, send_and_capture_transaction_id,
};
use charm_lib::matrix::timeline::get_timeline_page_impl;
use charm_lib::matrix::verification::{
    accept_verification_request_impl, bootstrap_cross_signing_impl, cancel_verification_impl,
    confirm_sas_verification_impl, cross_signing_status_impl,
};
use matrix_sdk::attachment::AttachmentConfig;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::RoomId;

use crate::session::Session;
use crate::AppState;

pub const SESSION_COOKIE: &str = "charm_session";

pub fn router(state: AppState) -> Router {
    Router::new()
        // -- unauthenticated: discovery, login/registration --
        .route("/api/auth/discover", post(discover_homeserver))
        .route("/api/auth/login", post(login))
        .route("/api/auth/register", post(register))
        // -- session --
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me))
        // -- rooms --
        .route("/api/rooms", get(list_rooms))
        .route("/api/rooms/resolve-alias", post(resolve_room_alias))
        .route("/api/rooms/{room_id}", get(get_room_details))
        .route("/api/rooms/{room_id}/members", get(get_room_members))
        .route(
            "/api/rooms/{room_id}/member-list",
            get(get_room_member_list),
        )
        .route("/api/rooms/{room_id}/timeline", get(get_timeline_page))
        // -- messaging --
        .route("/api/rooms/{room_id}/send", post(send_message))
        .route("/api/rooms/{room_id}/reply", post(send_reply))
        .route(
            "/api/rooms/{room_id}/events/{event_id}/edit",
            post(edit_message),
        )
        .route(
            "/api/rooms/{room_id}/events/{event_id}/redact",
            post(redact_event),
        )
        .route(
            "/api/rooms/{room_id}/events/{event_id}/can-redact",
            get(can_redact),
        )
        .route(
            "/api/rooms/{room_id}/events/{event_id}/react",
            post(toggle_reaction),
        )
        .route("/api/rooms/{room_id}/command", post(run_command))
        // -- ephemeral (receipts/typing/read) --
        .route("/api/rooms/{room_id}/receipt", post(send_read_receipt))
        .route("/api/rooms/{room_id}/typing", post(send_typing))
        .route("/api/rooms/{room_id}/mark-read", post(mark_room_read))
        // -- room organization (favourite/low-priority/marked-unread/order) --
        .route("/api/rooms/{room_id}/favourite", put(set_room_favourite))
        .route(
            "/api/rooms/{room_id}/low-priority",
            put(set_room_low_priority),
        )
        .route(
            "/api/rooms/{room_id}/marked-unread",
            put(set_room_marked_unread),
        )
        .route(
            "/api/rooms/{room_id}/manual-order",
            put(set_room_manual_order),
        )
        // -- room admin --
        .route("/api/rooms/{room_id}/name", put(set_room_name))
        .route("/api/rooms/{room_id}/topic", put(set_room_topic))
        .route("/api/rooms/{room_id}/avatar", delete(remove_room_avatar))
        .route("/api/rooms/{room_id}/join-rule", put(set_room_join_rule))
        .route(
            "/api/rooms/{room_id}/history-visibility",
            put(set_room_history_visibility),
        )
        .route(
            "/api/rooms/{room_id}/encryption",
            post(enable_room_encryption),
        )
        .route(
            "/api/rooms/{room_id}/power-levels/thresholds",
            put(set_room_power_level_thresholds),
        )
        .route(
            "/api/rooms/{room_id}/members/{user_id}/power-level",
            put(set_member_power_level),
        )
        .route(
            "/api/rooms/{room_id}/members/{user_id}/invite",
            post(invite_member),
        )
        .route(
            "/api/rooms/{room_id}/members/{user_id}/kick",
            post(kick_member),
        )
        .route(
            "/api/rooms/{room_id}/members/{user_id}/ban",
            post(ban_member),
        )
        .route(
            "/api/rooms/{room_id}/members/{user_id}/unban",
            post(unban_member),
        )
        // -- presence / profile --
        .route("/api/presence", put(set_presence))
        .route("/api/presence/{user_id}", get(get_presence))
        .route("/api/profile/me", get(get_own_profile))
        // -- account data --
        .route(
            "/api/account-data/{event_type}",
            get(get_account_data).put(set_account_data),
        )
        // -- media --
        .route(
            "/api/rooms/{room_id}/events/{event_id}/media",
            get(resolve_message_media),
        )
        .route("/api/rooms/{room_id}/attachments", post(send_attachment))
        .route("/api/profile/avatar", put(set_avatar).delete(remove_avatar))
        // -- verification --
        .route(
            "/api/verification/cross-signing",
            get(get_cross_signing_status).post(bootstrap_cross_signing),
        )
        .route(
            "/api/verification/{other_user_id}/{flow_id}/accept",
            post(accept_verification),
        )
        .route(
            "/api/verification/{other_user_id}/{flow_id}/cancel",
            post(cancel_verification),
        )
        .route(
            "/api/verification/{other_user_id}/{flow_id}/sas/start",
            post(start_sas_verification),
        )
        .route(
            "/api/verification/{other_user_id}/{flow_id}/sas/confirm",
            post(confirm_sas_verification),
        )
        // -- live events --
        .route("/api/ws", get(ws_handler))
        .with_state(state)
}

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

async fn discover_homeserver(
    Json(input): Json<String>,
) -> Result<Json<DiscoverHomeserverResponse>, ApiError> {
    let homeserver_url = charm_lib::matrix::auth::discover(&input)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(DiscoverHomeserverResponse { homeserver_url }))
}

/// After a successful login/register, spawns the session's background sync
/// loop (see `sync_loop::spawn`) and, if session persistence is configured
/// (`AppState::persistence`, see `persistence.rs`), saves it encrypted-at-rest
/// under the token it's about to be created with — so a restart doesn't drop
/// this login. Best-effort: a persistence write failure is logged, not
/// surfaced to the caller, since the session itself is already fully usable
/// in-memory (matches sub-PR A's behavior when no master key is configured
/// at all).
async fn finish_login(state: &AppState, mut session: Session, homeserver_url: &str) -> String {
    let handle = crate::sync_loop::spawn(session.client.clone(), session.events.clone());
    *session
        .sync_handle
        .get_mut()
        .unwrap_or_else(|e| e.into_inner()) = Some(handle);

    let matrix_session = session.client.matrix_auth().session();
    let token = state.sessions.create(session).await;

    if let (Some(persistence), Some(matrix_session)) = (&state.persistence, matrix_session) {
        if let Err(e) = persistence
            .save(&token, homeserver_url, &matrix_session)
            .await
        {
            tracing::warn!("failed to persist session: {e}");
        }
    }

    token
}

async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let homeserver_url = request.homeserver_url.clone();
    let (response, session) = crate::auth::login(request)
        .await
        .map_err(ApiError::unauthorized)?;
    let token = finish_login(&state, session, &homeserver_url).await;
    Ok((jar.add(session_cookie(token)), Json(response)))
}

async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<RegisterRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let homeserver_url = request.homeserver_url.clone();
    let (response, session) = crate::auth::register(request)
        .await
        .map_err(ApiError::bad_request)?;
    let token = finish_login(&state, session, &homeserver_url).await;
    Ok((jar.add(session_cookie(token)), Json(response)))
}

async fn logout(State(state): State<AppState>, jar: CookieJar) -> impl IntoResponse {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        let token = cookie.value().to_string();
        if let Some(session) = state.sessions.remove(&token).await {
            if let Some(handle) = session
                .sync_handle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
            {
                handle.abort();
            }
            if let Some(persistence) = &state.persistence {
                if let Err(e) = persistence.remove(&token).await {
                    tracing::warn!("failed to remove persisted session on logout: {e}");
                }
            }
            // Revoke the access token on the homeserver too — otherwise it
            // stays valid indefinitely after "logout" only clears local
            // server-side state, unlike the desktop app (which calls the
            // same `matrix_auth().logout()`). Spawned rather than awaited
            // inline so a slow/unreachable homeserver doesn't block the
            // response to the browser; best-effort, same as desktop's other
            // fire-and-forget homeserver calls (e.g. `set_presence_online`).
            tokio::spawn(async move {
                let _ = session.client.matrix_auth().logout().await;
            });
        }
    }
    // `remove` must be given a cookie matching the *original* cookie's
    // path — `Cookie::from(SESSION_COOKIE)` alone defaults to no path,
    // which doesn't match `session_cookie`'s explicit `path("/")` and would
    // leave some clients holding onto the (now server-side-invalid) cookie.
    let jar = jar.remove(Cookie::build(SESSION_COOKIE).path("/"));
    (jar, StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct MeResponse {
    user_id: String,
}

async fn me(State(state): State<AppState>, jar: CookieJar) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    Ok(Json(MeResponse {
        user_id: session.user_id.clone(),
    }))
}

/// Server-issued session cookie: HttpOnly (unreadable to page JS), Secure
/// unless explicitly disabled (HTTPS-only transport by default — see below),
/// SameSite=Strict (never sent on cross-site navigations/requests).
///
/// `Secure` cookies are never stored or sent by browsers over plain HTTP —
/// `main.rs` itself only ever serves plain HTTP (TLS termination is expected
/// to happen in front of it, e.g. a reverse proxy on `matrix-vps`), so a
/// `Secure` cookie against a non-TLS deployment or local dev would silently
/// never persist a login. `CHARM_WEB_SERVER_INSECURE_COOKIES=1` opts out for
/// exactly those two cases; production behind TLS must not set it.
fn session_cookie(token: String) -> Cookie<'static> {
    let secure = std::env::var("CHARM_WEB_SERVER_INSECURE_COOKIES").as_deref() != Ok("1");
    Cookie::build((SESSION_COOKIE, token))
        .http_only(true)
        .secure(secure)
        .same_site(SameSite::Strict)
        .path("/")
        .build()
}

/// Resolves the caller's session from their cookie, or a 401 if it's
/// missing/unknown. Every authenticated route below starts with this — kept
/// as a plain helper rather than `axum` middleware so each handler's auth
/// failure path stays explicit and easy to audit against the "no
/// cross-session leakage" acceptance criterion.
async fn require_session(state: &AppState, jar: &CookieJar) -> Result<Arc<Session>, ApiError> {
    let token = jar
        .get(SESSION_COOKIE)
        .map(|c| c.value().to_string())
        .ok_or_else(|| ApiError::unauthorized("no session cookie"))?;
    state
        .sessions
        .get(&token)
        .await
        .ok_or_else(|| ApiError::unauthorized("unknown or expired session"))
}

// ---------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------

async fn list_rooms(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    Ok(Json(snapshot_rooms(&session.client, None).await))
}

async fn resolve_room_alias(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(alias): Json<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let room_id = resolve_alias(&session.client, &alias)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(room_id))
}

async fn get_room_details(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let details = build_room_details(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(details))
}

async fn get_room_members(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let members = get_room_members_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(members))
}

async fn get_room_member_list(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let members = get_room_member_list_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(members))
}

#[derive(Deserialize)]
struct TimelineQuery {
    limit: Option<u32>,
}

async fn get_timeline_page(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Query(query): Query<TimelineQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let parsed_room_id =
        RoomId::parse(&room_id).map_err(|e| ApiError::bad_request(e.to_string()))?;
    // Reuses this session's cached `Timeline` for the room (see
    // `Session::get_or_create_timeline`) rather than building a fresh one
    // per request — a `Timeline` carries its own pagination cursor, so a
    // brand-new one on every call silently reset pagination and made
    // "load older messages" always return the same first page.
    let timeline = session
        .get_or_create_timeline(&parsed_room_id)
        .await
        .map_err(|e| {
            if e == format!("room {room_id} not found") {
                ApiError::not_found(e)
            } else {
                ApiError::bad_request(e)
            }
        })?;
    let page = get_timeline_page_impl(&session.client, &timeline, None, query.limit)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(page))
}

// ---------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SendMessageRequest {
    body: String,
    formatted_body: Option<String>,
    mentions: Option<Vec<String>>,
}

async fn send_message(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(request): Json<SendMessageRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let parsed_room_id =
        RoomId::parse(&room_id).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let room = session
        .client
        .get_room(&parsed_room_id)
        .ok_or_else(|| ApiError::not_found(format!("room {room_id} not found")))?;

    let content = build_message_content(request.body, request.formatted_body, request.mentions)
        .map_err(ApiError::bad_request)?;
    let content = AnyMessageLikeEventContent::RoomMessage(content);
    let event_id = send_and_capture_transaction_id(&session.client, &room, content)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(event_id))
}

#[derive(Debug, Deserialize)]
struct ReplyRequest {
    in_reply_to_event_id: String,
    body: String,
}

async fn send_reply(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(request): Json<ReplyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let event_id = send_reply_impl(
        &session.client,
        &room_id,
        &request.in_reply_to_event_id,
        request.body,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(event_id))
}

#[derive(Debug, Deserialize)]
struct EditMessageRequest {
    new_body: String,
}

async fn edit_message(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, event_id)): Path<(String, String)>,
    Json(request): Json<EditMessageRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    edit_message_impl(&session.client, &room_id, &event_id, request.new_body)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, Default)]
struct RedactRequest {
    reason: Option<String>,
}

/// Parses an optional JSON body, treating an empty body as `T::default()`
/// rather than an error — regardless of `Content-Type`. Deliberately not
/// `axum`'s `Option<Json<T>>` extractor: as of axum 0.8, that extractor
/// rejects an empty body when `Content-Type: application/json` is present
/// (which `fetch` and most JSON HTTP clients set even for bodyless
/// requests) instead of yielding `None`, so these "reason is optional"
/// moderation routes would incorrectly 4xx on the common no-reason case.
fn parse_optional_json<T: serde::de::DeserializeOwned + Default>(
    body: &Bytes,
) -> Result<T, ApiError> {
    if body.is_empty() {
        Ok(T::default())
    } else {
        serde_json::from_slice(body).map_err(|e| ApiError::bad_request(e.to_string()))
    }
}

async fn redact_event(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, event_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let reason: RedactRequest = parse_optional_json(&body)?;
    redact_event_impl(
        &session.client,
        &room_id,
        &event_id,
        reason.reason.as_deref(),
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct CanRedactQuery {
    target_sender: String,
}

async fn can_redact(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, _event_id)): Path<(String, String)>,
    Query(query): Query<CanRedactQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let can = can_redact_impl(&session.client, &room_id, &query.target_sender)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(can))
}

#[derive(Debug, Deserialize)]
struct ReactRequest {
    key: String,
}

async fn toggle_reaction(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, event_id)): Path<(String, String)>,
    Json(request): Json<ReactRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let result = toggle_reaction_impl(&session.client, &room_id, &event_id, request.key)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
struct RunCommandRequest {
    command: SlashCommand,
    args: Vec<String>,
}

async fn run_command(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(request): Json<RunCommandRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let result = run_command_impl(&session.client, &room_id, request.command, request.args)
        .await
        .map_err(|e| {
            // `run_command_impl`'s `get_room` helper fails with exactly this
            // message shape for a missing room (see `commands.rs`) — map
            // that case to 404, consistent with every other room-scoped
            // route (`get_timeline_page`, `send_message`, etc.), rather than
            // lumping it in with genuine bad-request failures (bad args,
            // permission errors, send-queue failures).
            if e == format!("room {room_id} not found") {
                ApiError::not_found(e)
            } else {
                ApiError::bad_request(e)
            }
        })?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------
// Ephemeral (receipts / typing / read markers)
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ReadReceiptRequest {
    event_id: String,
    #[serde(default)]
    private: bool,
}

async fn send_read_receipt(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(request): Json<ReadReceiptRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    send_read_receipt_impl(&session.client, &room_id, request.event_id, request.private)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct TypingRequest {
    typing: bool,
}

async fn send_typing(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(request): Json<TypingRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    send_typing_impl(&session.client, &room_id, request.typing)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn mark_room_read(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    mark_room_read_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------
// Room organization
// ---------------------------------------------------------------------

async fn set_room_favourite(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(favourite): Json<bool>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_room_favourite_impl(&session.client, &room_id, favourite)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_room_low_priority(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(low_priority): Json<bool>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_room_low_priority_impl(&session.client, &room_id, low_priority)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_room_marked_unread(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(unread): Json<bool>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_room_marked_unread_impl(&session.client, &room_id, unread)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_room_manual_order(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(order): Json<f64>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_room_manual_order_impl(&session.client, &room_id, order)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------
// Room admin
// ---------------------------------------------------------------------

async fn set_room_name(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(name): Json<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_room_name_impl(&session.client, &room_id, name)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_room_topic(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(topic): Json<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_room_topic_impl(&session.client, &room_id, &topic)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_room_avatar(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    remove_room_avatar_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_room_join_rule(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(join_rule): Json<JoinRuleKind>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_room_join_rule_impl(&session.client, &room_id, join_rule)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_room_history_visibility(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(visibility): Json<HistoryVisibilityKind>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_room_history_visibility_impl(&session.client, &room_id, visibility)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn enable_room_encryption(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    enable_room_encryption_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_room_power_level_thresholds(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(changes): Json<PowerLevelThresholds>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_room_power_level_thresholds_impl(&session.client, &room_id, changes)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_member_power_level(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, user_id)): Path<(String, String)>,
    Json(power_level): Json<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_member_power_level_impl(&session.client, &room_id, &user_id, power_level)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, Default)]
struct ReasonRequest {
    reason: Option<String>,
}

async fn invite_member(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, user_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    invite_member_impl(&session.client, &room_id, &user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kick_member(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, user_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let reason: ReasonRequest = parse_optional_json(&body)?;
    kick_member_impl(
        &session.client,
        &room_id,
        &user_id,
        reason.reason.as_deref(),
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn ban_member(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, user_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let reason: ReasonRequest = parse_optional_json(&body)?;
    ban_member_impl(
        &session.client,
        &room_id,
        &user_id,
        reason.reason.as_deref(),
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unban_member(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, user_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let reason: ReasonRequest = parse_optional_json(&body)?;
    unban_member_impl(
        &session.client,
        &room_id,
        &user_id,
        reason.reason.as_deref(),
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------
// Presence / profile
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SetPresenceRequest {
    presence: PresenceStateDto,
    status_msg: Option<String>,
}

async fn set_presence(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<SetPresenceRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_presence_impl(&session.client, request.presence, request.status_msg)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_presence(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(user_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let presence = get_presence_impl(&session.client, &user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(presence))
}

async fn get_own_profile(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    // Unlike desktop's `MatrixState::sync_presence` (updated by the
    // background sync loop and reflecting whatever was last explicitly
    // set), this crate has no such loop yet in sub-PR A — so query the
    // homeserver directly for the actual current value instead of
    // hardcoding `PresenceStateDto::default()` (always `Online`), which
    // would misreport `unavailable`/`offline` accounts.
    let presence = get_presence_impl(&session.client, &session.user_id)
        .await
        .ok()
        .flatten()
        .map(|update| update.presence)
        .unwrap_or_default();
    let profile = get_own_profile_impl(&session.client, None, presence)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(profile))
}

// ---------------------------------------------------------------------
// Account data
// ---------------------------------------------------------------------

async fn get_account_data(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(event_type): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let value = get_account_data_impl(&session.client, event_type)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(value))
}

async fn set_account_data(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(event_type): Path<String>,
    Json(value): Json<serde_json::Value>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_account_data_impl(&session.client, event_type, value)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------
// Media / avatar upload
// ---------------------------------------------------------------------

/// Resolves an image/video/audio/file `m.room.message`'s attached media and
/// streams the resolved file back. Unlike desktop's `media::resolve_media`
/// (which hands the frontend a `file://`-loadable local cache path), a
/// browser has no such filesystem path to receive — so this reuses the same
/// `resolve_media_impl` (decryption, cache lookup/population, thumbnail vs.
/// full-size selection all included) against `crate::media_cache`'s
/// process-wide cache dir, then reads the resulting cached file back off
/// disk and streams its bytes with a `Content-Type` guessed from its
/// extension.
#[derive(Deserialize)]
struct ResolveMediaQuery {
    #[serde(default)]
    thumbnail: bool,
}

async fn resolve_message_media(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, event_id)): Path<(String, String)>,
    Query(query): Query<ResolveMediaQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let cache = crate::media_cache::shared()
        .await
        .map_err(ApiError::bad_request)?;
    let path = charm_lib::matrix::media::resolve_media_impl(
        &session.client,
        cache,
        &room_id,
        &event_id,
        query.thumbnail,
    )
    .await
    .map_err(ApiError::bad_request)?;

    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    Ok(([("content-type", content_type)], data))
}

/// Uploads a room attachment straight from the request body (a browser has
/// no local file path to hand over the way desktop's `send_attachment`
/// takes one) and pushes `upload:progress` over this session's WebSocket
/// channel as it goes.
#[derive(Debug, Deserialize)]
struct AttachmentQuery {
    filename: String,
    txn_id: String,
    caption: Option<String>,
}

async fn send_attachment(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Query(query): Query<AttachmentQuery>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let parsed_room_id =
        RoomId::parse(&room_id).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let room = session
        .client
        .get_room(&parsed_room_id)
        .ok_or_else(|| ApiError::not_found(format!("room {room_id} not found")))?;

    if body.len() as u64 > charm_lib::matrix::send::MAX_ATTACHMENT_UPLOAD_BYTES {
        return Err(ApiError::bad_request(format!(
            "attachment is {} bytes, over the {}-byte limit",
            body.len(),
            charm_lib::matrix::send::MAX_ATTACHMENT_UPLOAD_BYTES
        )));
    }

    let data = body.to_vec();
    let total_bytes = data.len() as u64;
    let mime = mime_guess::from_path(&query.filename).first_or_octet_stream();
    let info = attachment_info_for(&mime, &data, total_bytes);

    let ruma_txn_id: matrix_sdk::ruma::OwnedTransactionId = query.txn_id.clone().into();
    let mut config = AttachmentConfig::new().txn_id(ruma_txn_id).info(info);
    if let Some(caption) = query.caption {
        config = config.caption(Some(
            matrix_sdk::ruma::events::room::message::TextMessageEventContent::plain(caption),
        ));
    }

    room.send_attachment(query.filename, &mime, data, config)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;

    let _ = session
        .events
        .send(crate::events::ServerEvent::UploadProgress(
            charm_lib::matrix::send::UploadProgress {
                txn_id: query.txn_id,
                room_id,
                sent: total_bytes,
                total: total_bytes,
            },
        ));

    Ok(StatusCode::NO_CONTENT)
}

/// Reads the request body as raw avatar image bytes and uploads it as the
/// account avatar in one step — the bytes-based web equivalent of desktop's
/// file-path-based `account::set_avatar`.
async fn set_avatar(
    State(state): State<AppState>,
    jar: CookieJar,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let mime = infer_image_mime(&body);
    session
        .client
        .account()
        .upload_avatar(&mime, body.to_vec())
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

fn infer_image_mime(bytes: &[u8]) -> mime::Mime {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => mime::IMAGE_PNG,
        [0xFF, 0xD8, 0xFF, ..] => mime::IMAGE_JPEG,
        [b'G', b'I', b'F', b'8', ..] => mime::IMAGE_GIF,
        _ => mime::IMAGE_PNG,
    }
}

async fn remove_avatar(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    session
        .client
        .account()
        .set_avatar_url(None)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------

async fn get_cross_signing_status(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let status = cross_signing_status_impl(&session.client)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(status))
}

#[derive(Debug, Deserialize, Default)]
struct BootstrapCrossSigningRequest {
    password: Option<String>,
}

async fn bootstrap_cross_signing(
    State(state): State<AppState>,
    jar: CookieJar,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let request: BootstrapCrossSigningRequest = parse_optional_json(&body)?;
    bootstrap_cross_signing_impl(&session.client, request.password)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn accept_verification(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((other_user_id, flow_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    accept_verification_request_impl(&session.client, &other_user_id, &flow_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn cancel_verification(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((other_user_id, flow_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    cancel_verification_impl(&session.client, &other_user_id, &flow_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Starts the SAS flow and streams `verification:sas_update` over this
/// session's WebSocket channel — see `sync_loop::start_sas_verification`.
async fn start_sas_verification(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((other_user_id, flow_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    crate::sync_loop::start_sas_verification(
        &session.client,
        session.events.clone(),
        &other_user_id,
        &flow_id,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn confirm_sas_verification(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((other_user_id, flow_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    confirm_sas_verification_impl(&session.client, &other_user_id, &flow_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------
// Live events (WebSocket)
// ---------------------------------------------------------------------

/// Upgrades to a WebSocket and streams this session's `ServerEvent`s
/// (`sync:state`, `room_list:update`, `timeline:update`, etc. — see
/// `events.rs`) as they're pushed by `sync_loop.rs` and the per-room
/// timeline listeners in `session.rs`. Authenticates the same way every HTTP
/// route does — via the session cookie, checked *before* the protocol
/// upgrade — since a WebSocket handshake is still a plain HTTP request the
/// browser sends its cookies on.
async fn ws_handler(
    State(state): State<AppState>,
    jar: CookieJar,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, session)))
}

async fn handle_socket(mut socket: WebSocket, session: Arc<Session>) {
    let mut receiver = session.events.subscribe();
    loop {
        tokio::select! {
            event = receiver.recv() => {
                match event {
                    Ok(event) => {
                        let Ok(json) = serde_json::to_string(&event) else { continue };
                        if socket.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    // A slow consumer fell behind the broadcast channel's
                    // capacity — skip ahead rather than disconnecting; the
                    // next event (e.g. the next `room_list:update`) already
                    // supersedes whatever was missed for every event type
                    // this crate emits.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                // This channel is server-push only; a client message (or a
                // close frame, or the connection dropping) both just mean
                // "stop streaming" — nothing sent by the client is consumed.
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => continue,
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

// ---------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------

pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}
