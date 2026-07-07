//! HTTP routes. Each authenticated route resolves the caller's session from
//! their cookie, then calls straight into the same `charm_lib::matrix::*`
//! `_impl` function the desktop Tauri commands use, and serializes the
//! result as JSON. Deliberately a broad-but-personal-use slice of the full
//! command surface for sub-PR A — media resolution, avatar upload (both
//! file-path based on the desktop side), and multi-device
//! verification/QR-login flows are deferred; everything else needed for a
//! usable single-account web client is covered. See the crate README.

use std::sync::Arc;

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
use charm_lib::matrix::send::{build_message_content, send_and_capture_transaction_id};
use charm_lib::matrix::timeline::get_timeline_page_impl;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::RoomId;
use matrix_sdk_ui::timeline::RoomExt as _;

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

async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let (response, session) = crate::auth::login(request)
        .await
        .map_err(ApiError::unauthorized)?;
    let token = state.sessions.create(session).await;
    Ok((jar.add(session_cookie(token)), Json(response)))
}

async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<RegisterRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let (response, session) = crate::auth::register(request)
        .await
        .map_err(ApiError::bad_request)?;
    let token = state.sessions.create(session).await;
    Ok((jar.add(session_cookie(token)), Json(response)))
}

async fn logout(State(state): State<AppState>, jar: CookieJar) -> impl IntoResponse {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        state.sessions.remove(cookie.value()).await;
    }
    let jar = jar.remove(Cookie::from(SESSION_COOKIE));
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
/// (HTTPS-only transport — see the crate README's local-dev HTTP caveat),
/// SameSite=Strict (never sent on cross-site navigations/requests).
fn session_cookie(token: String) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, token))
        .http_only(true)
        .secure(true)
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
    let room = session
        .client
        .get_room(&parsed_room_id)
        .ok_or_else(|| ApiError::not_found(format!("room {room_id} not found")))?;
    // No cross-request timeline cache in sub-PR A (that's the `MatrixState`
    // LRU on the desktop side, which is `AppHandle`-bound) — each page
    // request builds a fresh `Timeline` handle. Fine for MVP request volume;
    // worth revisiting (likely as part of sub-PR B, alongside real
    // persistence) if this becomes a hot path.
    let timeline = room
        .timeline()
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
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

async fn redact_event(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, event_id)): Path<(String, String)>,
    body: Option<Json<RedactRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let reason = body.map(|Json(r)| r.reason).unwrap_or_default();
    redact_event_impl(&session.client, &room_id, &event_id, reason.as_deref())
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
    let result = run_command_impl(&session.client, &room_id, request.command, request.args).await;
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
    body: Option<Json<ReasonRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let reason = body.map(|Json(r)| r.reason).unwrap_or_default();
    kick_member_impl(&session.client, &room_id, &user_id, reason.as_deref())
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn ban_member(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, user_id)): Path<(String, String)>,
    body: Option<Json<ReasonRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let reason = body.map(|Json(r)| r.reason).unwrap_or_default();
    ban_member_impl(&session.client, &room_id, &user_id, reason.as_deref())
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unban_member(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, user_id)): Path<(String, String)>,
    body: Option<Json<ReasonRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let reason = body.map(|Json(r)| r.reason).unwrap_or_default();
    unban_member_impl(&session.client, &room_id, &user_id, reason.as_deref())
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
    let profile = get_own_profile_impl(&session.client, None, PresenceStateDto::default())
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
