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

use charm_lib::matrix::account::UiaCommandError;
use charm_lib::matrix::account_data::{get_account_data_impl, set_account_data_impl};
use charm_lib::matrix::actions::{
    can_redact_impl, discard_failed_message_impl, edit_message_impl, redact_event_impl,
    resend_message_impl, send_reply_impl, toggle_reaction_impl,
};
use charm_lib::matrix::auth::{DiscoverHomeserverResponse, LoginRequest, RegisterRequest};
use charm_lib::matrix::commands::run_command_impl;
use charm_lib::matrix::commands::SlashCommand;
use charm_lib::matrix::devices::{
    delete_device_impl, get_cross_signing_reset_url_impl, get_device_delete_url_impl,
    list_devices_impl,
};
use charm_lib::matrix::ephemeral::{mark_room_read_impl, send_read_receipt_impl, send_typing_impl};
use charm_lib::matrix::link_preview::get_url_preview_impl;
use charm_lib::matrix::members::get_room_members_impl;
use charm_lib::matrix::presence::{get_presence_impl, set_presence_impl, PresenceStateDto};
use charm_lib::matrix::profiles::{get_own_profile_impl, OwnProfile};
use charm_lib::matrix::room_admin::{
    add_room_alias_impl, ban_member_impl, build_room_details, check_room_alias_available_impl,
    enable_room_encryption_impl, get_room_local_aliases_impl, get_room_member_list_impl,
    invite_member_impl, kick_member_impl, leave_room_impl, remove_alt_alias_impl,
    remove_room_alias_impl, remove_room_avatar_impl, set_canonical_alias_impl,
    set_member_power_level_impl, set_room_history_visibility_impl, set_room_join_rule_impl,
    set_room_name_impl, set_room_power_level_thresholds_impl, set_room_topic_impl,
    unban_member_impl, HistoryVisibilityKind, JoinRuleKind, PowerLevelThresholds,
};
use charm_lib::matrix::rooms::{
    accept_invite_impl, decline_invite_impl, resolve_alias, set_room_favourite_impl,
    set_room_low_priority_impl, set_room_manual_order_impl, set_room_marked_unread_impl,
    snapshot_rooms,
};
use charm_lib::matrix::send::{
    attachment_info_for, build_message_content, send_and_capture_transaction_id,
};
use charm_lib::matrix::spaces::{
    add_existing_space_child_impl, create_space_impl, join_room_impl, knock_room_impl,
    list_space_hierarchy_impl, remove_space_child_impl, set_space_child_suggested_impl,
};
use charm_lib::matrix::timeline::get_timeline_page_impl;
use charm_lib::matrix::verification::{
    accept_verification_request_impl, bootstrap_cross_signing_impl, cancel_verification_impl,
    confirm_sas_verification_impl, cross_signing_status_impl, recover_from_key_impl,
    recovery_status_impl,
};
use matrix_sdk::attachment::AttachmentConfig;
use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AccountManagementActionData;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::RoomId;

use crate::session::Session;
use crate::AppState;

pub const SESSION_COOKIE: &str = "charm_session";

/// Sanity cap on an avatar upload — well over any real profile picture, but
/// (unlike attachments) an avatar has no legitimate reason to approach
/// `MAX_ATTACHMENT_UPLOAD_BYTES`, so this gets its own, much smaller limit
/// rather than reusing that one.
const AVATAR_UPLOAD_MAX_BYTES: usize = 10 * 1024 * 1024;

/// `MAX_ATTACHMENT_UPLOAD_BYTES` plus a fixed allowance for
/// `multipart/form-data` framing overhead (boundary markers, per-part
/// headers, the optional `caption` field) — see the `attachments` route's
/// `DefaultBodyLimit` comment for why this can't just be
/// `MAX_ATTACHMENT_UPLOAD_BYTES` itself.
const MULTIPART_ATTACHMENT_BODY_LIMIT: usize =
    charm_lib::matrix::send::MAX_ATTACHMENT_UPLOAD_BYTES as usize + 64 * 1024;

pub fn router(state: AppState) -> Router {
    Router::new()
        // -- unauthenticated: platform health check --
        // No session/homeserver reachability implied by a 200 here — just
        // "this process is up and routing requests" — so a deploy platform's
        // health check (which needs a plain 200, unlike `/api/auth/me`'s
        // deliberate 401-when-logged-out) can hit it with zero setup.
        .route("/api/health", get(health))
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
        .route("/api/rooms/join", post(join_room))
        .route("/api/rooms/knock", post(knock_room))
        .route("/api/rooms/create-space", post(create_space))
        .route("/api/rooms/{room_id}", get(get_room_details))
        .route("/api/rooms/{room_id}/members", get(get_room_members))
        .route(
            "/api/rooms/{room_id}/member-list",
            get(get_room_member_list),
        )
        .route("/api/rooms/{room_id}/timeline", get(get_timeline_page))
        .route("/api/rooms/{room_id}/invite/accept", post(accept_invite))
        .route("/api/rooms/{room_id}/invite/decline", post(decline_invite))
        .route("/api/rooms/{room_id}/hierarchy", get(list_space_hierarchy))
        .route("/api/rooms/{room_id}/leave", post(leave_room))
        .route(
            "/api/rooms/{room_id}/space-children/{child_room_id}",
            post(add_existing_space_child).delete(remove_space_child),
        )
        .route(
            "/api/rooms/{room_id}/space-children/{child_room_id}/suggested",
            put(set_space_child_suggested),
        )
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
        .route("/api/rooms/{room_id}/can-redact", get(can_redact))
        .route(
            "/api/rooms/{room_id}/events/{event_id}/react",
            post(toggle_reaction),
        )
        .route(
            "/api/rooms/{room_id}/send-queue/{transaction_id}/resend",
            post(resend_message),
        )
        .route(
            "/api/rooms/{room_id}/send-queue/{transaction_id}/discard",
            post(discard_failed_message),
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
        .route(
            "/api/rooms/{room_id}/avatar",
            put(set_room_avatar).delete(remove_room_avatar).layer(
                axum::extract::DefaultBodyLimit::max(AVATAR_UPLOAD_MAX_BYTES),
            ),
        )
        .route("/api/rooms/{room_id}/join-rule", put(set_room_join_rule))
        .route(
            "/api/rooms/{room_id}/aliases",
            get(get_room_local_aliases).put(add_room_alias),
        )
        .route(
            "/api/rooms/aliases/check-availability",
            post(check_room_alias_available),
        )
        .route("/api/rooms/aliases/{alias}", delete(remove_room_alias))
        .route(
            "/api/rooms/{room_id}/canonical-alias",
            put(set_canonical_alias),
        )
        .route(
            "/api/rooms/{room_id}/alt-aliases/{alias}",
            delete(remove_alt_alias),
        )
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
        .route("/api/profile/display-name", put(set_display_name))
        .route(
            "/api/account/deactivate-url",
            get(get_account_deactivate_url),
        )
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
        .route("/api/media/avatar", get(resolve_avatar))
        .route("/api/media/preview_url", post(preview_url))
        .route(
            "/api/rooms/{room_id}/attachments",
            post(send_attachment).layer(axum::extract::DefaultBodyLimit::max(
                // `DefaultBodyLimit` is enforced on the *whole* request body
                // before the `Multipart` extractor ever yields the `file`
                // field, and multipart framing (boundary markers, per-part
                // headers, the optional `caption` field) adds bytes on top
                // of the file's own size — capping this at exactly
                // `MAX_ATTACHMENT_UPLOAD_BYTES` would reject a file *at* the
                // advertised limit purely because of that overhead, before
                // this handler's own `bytes.len() >
                // MAX_ATTACHMENT_UPLOAD_BYTES` check ever got a chance to
                // apply the real, precise limit to just the file bytes.
                MULTIPART_ATTACHMENT_BODY_LIMIT,
            )),
        )
        .route(
            "/api/profile/avatar",
            put(set_avatar)
                .delete(remove_avatar)
                .layer(axum::extract::DefaultBodyLimit::max(
                    AVATAR_UPLOAD_MAX_BYTES,
                )),
        )
        // -- verification --
        .route(
            "/api/verification/cross-signing",
            get(get_cross_signing_status).post(bootstrap_cross_signing),
        )
        .route(
            "/api/verification/cross-signing/reset-url",
            get(get_cross_signing_reset_url),
        )
        .route(
            "/api/verification/recovery",
            get(get_recovery_status).post(recover_from_key),
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
        .route(
            "/api/verification/devices/{device_id}/request",
            post(request_device_verification),
        )
        .route("/api/devices", get(list_devices))
        .route("/api/devices/{device_id}", delete(delete_device))
        .route(
            "/api/devices/{device_id}/delete-url",
            get(get_device_delete_url),
        )
        // -- live events --
        .route("/api/ws", get(ws_handler))
        .layer(axum::middleware::from_fn(record_request_metrics))
        // Continues a Sentry trace from the web frontend's `sentry-trace`/
        // `baggage` headers (see `src/observability/instrument.ts`'s
        // `tracePropagationTargets`) into a transaction spanning this
        // request — the HTTP-transport counterpart to
        // `observability_trace::continue_ipc_trace` on the desktop/Tauri
        // side. `axum` applies `.layer()` calls in the *opposite* order
        // `tower::ServiceBuilder` would (confirmed by `sentry-tower`'s own
        // docs), so `SentryHttpLayer` must come before `NewSentryLayer`
        // here, not after — the wrong order silently leaks memory instead
        // of failing loudly.
        .layer(sentry_tower::SentryHttpLayer::new().enable_transaction())
        // Added *after* `SentryHttpLayer` above — under axum's reversed
        // `.layer()` ordering (see that layer's comment) that makes this one
        // "outer", running before `SentryHttpLayer` sees the request. Must
        // stay outer: it rewrites `request.uri()` to the route template
        // before `SentryHttpLayer` reads the raw path into its transaction's
        // `request.url` (see `redact_request_uri_for_sentry`'s doc comment).
        .layer(axum::middleware::from_fn(redact_request_uri_for_sentry))
        .layer(sentry_tower::NewSentryLayer::<axum::extract::Request>::new_from_top())
        .layer(cors_layer())
        .with_state(state)
}

/// `axum::middleware::from_fn` layer emitting Sentry Application Metrics for
/// every HTTP request — the backend equivalent of the frontend's
/// `src/observability/ipc.ts` `invoke()` wrapper, which already instruments
/// every Tauri IPC call the desktop/mobile client makes. This crate has no
/// such single dispatch point of its own (routes are plain axum handlers,
/// not Tauri's `generate_handler!` macro), so a middleware layer is the
/// equivalent chokepoint for its HTTP surface.
///
/// Uses the *matched route template* (`MatchedPath`, e.g.
/// `/api/rooms/{room_id}/send`) rather than the raw request path as the
/// metric's `http.route` attribute — the raw path would embed a distinct
/// room/device/user ID per request, and Sentry bills/aggregates metrics by
/// their attribute cardinality, so every unique room would silently mint a
/// new metric series. Falls back to `"unmatched"` for a request that never
/// matched a route at all (e.g. a 404) rather than embedding the raw path.
async fn record_request_metrics(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|matched| matched.as_str().to_owned())
        .unwrap_or_else(|| "unmatched".to_owned());
    let started_at = std::time::Instant::now();
    let response = next.run(request).await;
    let duration_ms = started_at.elapsed().as_secs_f64() * 1000.0;
    crate::observability::record_http_request_metric(
        &route,
        response.status().as_u16(),
        duration_ms,
    );
    response
}

/// Replaces the request's URI (path *and* query — e.g. `resolve_avatar`'s
/// `?mxc=...` query param) with the matched route template before
/// `SentryHttpLayer` (added downstream of this in `router()`'s `.layer()`
/// chain, and therefore "outer"/earlier-executing than this middleware —
/// see that layer's own comment) ever reads it. Without this, Matrix room/
/// event/user IDs in the path reach Sentry's transaction (and, via
/// `SentryHttpLayer`'s request-fallback event processor, any error event
/// captured during the request) percent-encoded — `charm_lib::observability_scrub`'s
/// `MATRIX_ID_PATTERN` only matches a literal `:`, not `%3A`, so those IDs
/// silently bypass the scrubber `SENTRY.md` documents as unconditional.
/// Rewriting the URI at its one source (both `SentryHttpLayer`'s transaction
/// `request.url` and its event-fallback derive from the same
/// `get_url_from_request` call) fixes both in one place, rather than
/// patching each Sentry payload after the fact. Uses the same `MatchedPath`/
/// `"unmatched"` fallback shape as `record_request_metrics` just above, for
/// the same reason (cardinality there, PII here).
async fn redact_request_uri_for_sentry(
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let matched_path = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|matched| matched.as_str());
    *request.uri_mut() = redacted_route_uri(matched_path);
    next.run(request).await
}

/// Pure helper behind [`redact_request_uri_for_sentry`] — a route template
/// has no per-resource IDs to redact, so this is just a parse with a safe
/// fallback for the pathological case of a template that somehow isn't a
/// valid URI path (falls back to the same `"/unmatched"` this crate already
/// treats as its no-route placeholder), kept separate from the middleware so
/// it's unit-testable without spinning up a router.
fn redacted_route_uri(matched_path: Option<&str>) -> axum::http::Uri {
    matched_path
        .unwrap_or("/unmatched")
        .parse()
        .unwrap_or_else(|_| axum::http::Uri::from_static("/unmatched"))
}

/// Builds the router's CORS layer from the same `CHARM_WEB_SERVER_ALLOWED_ORIGIN`
/// allowlist `origin_is_allowed`/`require_allowed_origin` already use for the
/// WebSocket handshake and the raw-body mutating routes. Without this, the
/// frontend being served from a different origin than this API (exactly the
/// deployment `CHARM_WEB_SERVER_ALLOWED_ORIGIN` documents supporting) simply
/// can't call it: axum never adds `Access-Control-Allow-Origin`/
/// `Access-Control-Allow-Credentials` on its own, so the browser blocks every
/// cross-origin response, and any request that needs a preflight (most of
/// this API's JSON `POST`/`PUT`/`DELETE` routes) has no `OPTIONS` handler to
/// answer it with either.
///
/// With no allowlist configured, this grants no cross-origin CORS access at
/// all: same-origin requests (the common local-dev shape, and any
/// same-origin production deployment) need no CORS headers to work in the
/// first place, so "no configuration" still works out of the box for that
/// case. A genuinely cross-origin frontend needs
/// `CHARM_WEB_SERVER_ALLOWED_ORIGIN` set, exactly as the WebSocket check
/// requires for that same deployment shape.
fn cors_layer() -> tower_http::cors::CorsLayer {
    use axum::http::{header, Method};
    use tower_http::cors::{AllowOrigin, CorsLayer};

    // `Any` for methods/headers is a literal `*` on the wire — the CORS
    // spec (and browsers enforcing it) reject a wildcard
    // `Access-Control-Allow-Methods`/`-Headers` on a response that also
    // carries `Access-Control-Allow-Credentials: true`, silently breaking
    // every non-"simple" cross-origin request (any `PUT`/`DELETE`, or a
    // `POST` with `Content-Type: application/json`) instead of erroring
    // loudly. Listing exactly what this API actually uses avoids the
    // wildcard entirely: every route here is `GET`/`POST`/`PUT`/`DELETE`,
    // and the only non-default headers requests need to set are
    // `Content-Type` (JSON bodies, or `multipart/form-data` for uploads —
    // browsers set that one themselves, but it still needs to be allowed),
    // `x-charm-operation-id` (used to correlate upload progress), and
    // `sentry-trace`/`baggage` (attached by the browser SDK when this
    // origin is in `instrument.ts`'s `tracePropagationTargets` — without
    // allowing them here, the browser's CORS preflight rejects the request
    // before it ever reaches `SentryHttpLayer`, silently breaking every
    // cross-origin API call from a Sentry-enabled web client).
    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([
            header::CONTENT_TYPE,
            axum::http::HeaderName::from_static("x-charm-operation-id"),
            axum::http::HeaderName::from_static("sentry-trace"),
            axum::http::HeaderName::from_static("baggage"),
        ])
        .allow_credentials(true);

    let origins: Vec<String> = std::env::var(ALLOWED_ORIGIN_ENV)
        .map(|allowed| {
            allowed
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    layer.allow_origin(AllowOrigin::predicate(move |origin, _request_parts| {
        origin.to_str().ok().is_some_and(|origin| {
            origins
                .iter()
                .any(|allowed_origin| origin_matches_allowed_entry(allowed_origin, origin))
        })
    }))
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
async fn finish_login(
    state: &AppState,
    session: Session,
    homeserver_url: &str,
    initial_response: matrix_sdk::sync::SyncResponse,
) -> String {
    let matrix_session = session.client.matrix_auth().session();
    let token = state.sessions.create(session).await;
    // Re-fetch the now-stored `Arc<Session>` rather than holding onto the
    // owned `Session` from above — `sync_loop::spawn` needs the real,
    // now-known `token` to build a `PersistHandle` (so a later token
    // refresh mid-session re-saves under the *same* cookie, not a stale
    // one), which isn't minted until `create` runs.
    let stored = state
        .sessions
        .get(&token)
        .await
        .expect("session was just created under this token");

    // `initial_save_succeeded` tracks whether the save below actually
    // landed on disk — `PersistHandle::initial_access_token` must reflect
    // that, not just assume it, so a transient failure here doesn't leave
    // `sync_loop::spawn` believing this session is already safely
    // persisted (see that field's doc comment).
    let crypto = stored
        .persisted_crypto
        .as_ref()
        .map(|c| (c.store_key.as_str(), c.passphrase.as_str()));

    let mut initial_save_succeeded = false;
    if let (Some(persistence), Some(matrix_session)) = (&state.persistence, &matrix_session) {
        match persistence
            .save(&token, homeserver_url, matrix_session, crypto)
            .await
        {
            Ok(()) => {
                initial_save_succeeded = true;
                if let Err(error) = persistence
                    .snapshot_crypto_store(&token, matrix_session, crypto)
                    .await
                {
                    tracing::warn!("failed to create initial durable crypto snapshot: {error}");
                }
            }
            Err(e) => tracing::warn!("failed to persist session: {e}"),
        }
    }

    let persist = if let (Some(store), Some(matrix_session)) = (&state.persistence, &matrix_session)
    {
        Some(crate::sync_loop::PersistHandle {
            store: store.clone(),
            token: token.clone(),
            homeserver_url: homeserver_url.to_string(),
            initial_access_token: initial_save_succeeded
                .then(|| matrix_session.tokens.access_token.clone()),
            crypto: stored.persisted_crypto.clone(),
        })
    } else {
        None
    };
    let handle = crate::sync_loop::spawn(
        stored.client.clone(),
        stored.events.clone(),
        stored.sync_presence.clone(),
        persist,
        initial_response,
        stored.sync_snapshots(),
    );
    *stored.sync_handle.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);

    token
}

async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let homeserver_url = request.homeserver_url.clone();
    let (response, session, initial_response) =
        crate::auth::login(request, state.persistence.is_some())
            .await
            .map_err(ApiError::unauthorized)?;
    let token = finish_login(&state, session, &homeserver_url, initial_response).await;
    Ok((jar.add(session_cookie(token)), Json(response)))
}

async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<RegisterRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let homeserver_url = request.homeserver_url.clone();
    let (response, session, initial_response) =
        crate::auth::register(request, state.persistence.is_some())
            .await
            .map_err(ApiError::bad_request)?;
    let token = finish_login(&state, session, &homeserver_url, initial_response).await;
    Ok((jar.add(session_cookie(token)), Json(response)))
}

async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    // Bodyless `POST` — the same CORS "simple request" gap as
    // `mark_room_read`/etc, but here it's not just a nuisance mutation: an
    // untrusted same-site subdomain (still sends `SameSite=Strict`'s
    // cookie, per `require_allowed_origin`'s own doc comment) could log a
    // victim out and rip out their persisted session with a bodyless form
    // POST, with no need to ever read the response.
    require_allowed_origin(&headers)?;
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        let token = cookie.value().to_string();
        // Captured before the live-session branch below moves `session`
        // into a spawned task — this is the fallback `persistence.remove`
        // needs at the very end to still clean up this session's crypto
        // store even when no persisted blob exists to read it from (e.g.
        // `finish_login`'s own initial `persistence.save` failed, which it
        // explicitly tolerates — the live session still has an on-disk
        // crypto store in that case, just never a matching blob for
        // `PersistenceStore::remove`'s own `read_one` to find it through).
        let mut live_crypto = None;
        // Stop the live sync loop *before* removing the persisted entry
        // below, not after. Its `repersist_if_token_changed` can re-save a
        // refreshed token at any sync iteration — removing the persisted
        // entry first would leave a window where an in-flight sync
        // iteration resurrects it with a freshly "current" token right
        // before this handler gets to abort the loop that raced it.
        // Aborting first narrows that window (not eliminates it —
        // `abort()` cancels at the task's next await point, not
        // synchronously mid-poll — but from "the rest of this handler's
        // lifetime" down to "whatever's already in flight at this instant").
        if let Some(session) = state.sessions.remove(&token).await {
            live_crypto = session.persisted_crypto.clone();
            if let Some(handle) = session
                .sync_handle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
            {
                handle.abort();
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
            // See the matching call in the `else` branch below — harmless
            // even in the (normal) case where this token was never
            // idle-evicted and so never had an entry to begin with.
            state.sessions.forget_evicted_presence(&token);
        } else if let Some(persistence) = &state.persistence {
            // No live in-memory `Session` for this token — either it was
            // never loaded (a startup `restore_all` failure/timeout) or it
            // was idle-evicted (see `session::SessionStore::sweep_idle`).
            // Either way there's still a persisted access/refresh token that
            // would otherwise stay valid at the homeserver forever, since
            // nothing below this rebuilds a `Client` to revoke it — only
            // deletes the local persisted copy. Restore just far enough to
            // call `logout()` on the homeserver before that persisted copy
            // is gone. `restore_client_for_revocation`, not the full
            // `restore_by_token` — revoking a token needs no crypto identity
            // at all, and `restore_by_token` now deliberately fails closed
            // when a session's crypto store is missing/unopenable (to stop a
            // *live* session from silently continuing under a fresh, empty
            // crypto identity — see `build_client_for_restore`'s doc
            // comment), which would otherwise skip this homeserver
            // revocation entirely for exactly that session and leave its
            // token valid forever even though the browser's logout
            // succeeded. The restore itself is awaited (not spawned) and
            // *before* the unconditional `remove` below — it reads the same
            // persisted object `remove` is about to delete, so this has to
            // run first, not race it — and it's already bounded by
            // `RESTORE_TIMEOUT`, so a slow/unreachable homeserver can't hang
            // on *that* part. The actual `logout()` call is spawned rather
            // than awaited, same as the live-session branch above and for
            // the same reason: it's a second, independent network call with
            // no timeout of its own, so awaiting it inline here would let a
            // slow/unreachable homeserver hang this response even after the
            // bounded restore already succeeded. No presence to carry
            // forward here — this session is being logged out, not restored
            // for continued use.
            if let Some(client) = persistence.restore_client_for_revocation(&token).await {
                tokio::spawn(async move {
                    let _ = client.matrix_auth().logout().await;
                });
            }
            // This token's cached presence (if any — see
            // `SessionStore::evicted_presence`) is now meaningless: the
            // persisted session it would have restored into is about to be
            // deleted below. Drop it immediately instead of leaving it to
            // `EVICTED_PRESENCE_MAX_AGE`'s much longer backstop.
            state.sessions.forget_evicted_presence(&token);
        }
        // Removed unconditionally, whether or not a live in-memory session
        // was found above — not nested inside that `if let Some(session)`.
        // A persisted entry can outlive its `SessionStore` entry (e.g.
        // `restore_all` timed out or failed on it at startup — see
        // `PersistenceStore::restore_all`'s `RESTORE_TIMEOUT`), so a browser
        // can still hold a cookie for a token this process never actually
        // loaded a `Session` for. Skipping this removal in that case would
        // leave the cookie's session persisted indefinitely: a later restart
        // (once the homeserver/network issue that caused the earlier
        // restore failure has cleared) would restore and start syncing an
        // account the user believes they already logged out of.
        if let Some(persistence) = &state.persistence {
            let live_crypto = live_crypto
                .as_ref()
                .map(|c| (c.store_key.as_str(), c.passphrase.as_str()));
            if let Err(e) = persistence.remove(&token, live_crypto).await {
                tracing::warn!("failed to remove persisted session on logout: {e}");
            }
        }
    }
    // `remove` must be given a cookie matching the *original* cookie's
    // path — `Cookie::from(SESSION_COOKIE)` alone defaults to no path,
    // which doesn't match `session_cookie`'s explicit `path("/")` and would
    // leave some clients holding onto the (now server-side-invalid) cookie.
    let jar = jar.remove(Cookie::build(SESSION_COOKIE).path("/"));
    Ok((jar, StatusCode::NO_CONTENT))
}

async fn health() -> StatusCode {
    StatusCode::OK
}

#[derive(Serialize)]
struct MeResponse {
    user_id: String,
    device_id: String,
}

async fn me(State(state): State<AppState>, jar: CookieJar) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let device_id = session
        .client
        .device_id()
        .ok_or_else(|| ApiError::unauthorized("session has no device id"))?
        .to_string();
    Ok(Json(MeResponse {
        user_id: session.user_id.clone(),
        device_id,
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
    if let Some(session) = state.sessions.get(&token).await {
        session.touch();
        return Ok(session);
    }

    // Not in memory — either never logged in under this token, or this
    // session was idle-evicted (see `session::SessionStore::sweep_idle`)
    // while the cookie was still valid. Try restoring it from persistence
    // before giving up, so a browser that comes back after the eviction
    // window doesn't get forced into a full re-login for no reason other
    // than server-side memory pressure.
    //
    // Known race, accepted rather than solved here: two requests for the
    // same idle-evicted token arriving concurrently (e.g. a page load firing
    // several API calls at once right after the eviction window) can both
    // miss the `get` above and both restore + spawn their own `Client` and
    // sync loop, with the second `insert` silently winning and orphaning the
    // first's sync loop (never aborted, just abandoned — it'll keep polling
    // until the process restarts). Narrow in practice (only matters in the
    // instant right after an eviction, before either restore completes) and
    // no worse than today's behavior for the equivalent case elsewhere in
    // this file; closing it properly needs a per-token restore lock, which
    // isn't worth the added complexity unless it shows up in practice.
    let Some(persistence) = &state.persistence else {
        return Err(ApiError::unauthorized("unknown or expired session"));
    };
    // Read (not taken) *before* the restore call below — see
    // `persistence::PersistenceStore::restore_by_token`'s doc comment for
    // why it needs this to seed the freshly built session's presence before
    // its own initial `sync_once` runs, not merely before this function
    // returns. `peek_evicted_presence`, not `take`: `restore_by_token` can
    // fail (timeout, unreachable homeserver, a transient object-store
    // error), and taking the entry unconditionally up front would
    // permanently lose the user's `unavailable`/`offline` choice on that
    // first failed attempt — a *later*, successful retry with the same
    // still-valid cookie would then silently fall back to `Online` even
    // though the cached value was sitting right there the whole time. Only
    // consumed (`forget_evicted_presence`, below) once the restore this
    // presence was seeded into has actually succeeded.
    let evicted_presence = state.sessions.peek_evicted_presence(&token);
    let Some((homeserver_url, session, initial_response, initial_access_token)) =
        persistence.restore_by_token(&token, evicted_presence).await
    else {
        return Err(ApiError::unauthorized("unknown or expired session"));
    };
    if evicted_presence.is_some() {
        state.sessions.forget_evicted_presence(&token);
    }
    session.touch();
    let persist = Some(crate::sync_loop::PersistHandle {
        store: Arc::clone(persistence),
        token: token.clone(),
        homeserver_url,
        initial_access_token: Some(initial_access_token),
        crypto: session.persisted_crypto.clone(),
    });
    let handle = crate::sync_loop::spawn(
        session.client.clone(),
        session.events.clone(),
        session.sync_presence.clone(),
        persist,
        initial_response,
        session.sync_snapshots(),
    );
    *session
        .sync_handle
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(handle);
    state.sessions.insert(token.clone(), session).await;
    // `insert` takes the session by value and wraps it in its own `Arc`
    // internally (see `SessionStore::insert`) — re-fetch that shared `Arc`
    // rather than wrapping a second, disconnected one here, so every holder
    // of this session (this request, `sync_loop`'s spawned task, any other
    // concurrent request racing the same restore) is looking at the same
    // instance.
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
    // The `room_list_message_preview` flag isn't wired into web sessions yet
    // (no feature-flag evaluation exists in this crate at all), so this is
    // always `false` — a fresh, never-populated `Mutex` per call is
    // therefore correct: nothing ever registers with `LatestEvents` from
    // this path, so there's nothing to track across calls or forget.
    Ok(Json(
        snapshot_rooms(&session.client, None, false, &std::sync::Mutex::default()).await,
    ))
}

async fn accept_invite(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    accept_invite_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn decline_invite(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    decline_invite_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
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

async fn list_space_hierarchy(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let hierarchy = list_space_hierarchy_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(hierarchy))
}

#[derive(Debug, Deserialize)]
struct JoinRoomRequest {
    room_id_or_alias: String,
}

async fn join_room(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<JoinRoomRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let room_id = join_room_impl(&session.client, &request.room_id_or_alias)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(room_id))
}

#[derive(Debug, Deserialize)]
struct CreateSpaceRequest {
    name: String,
    topic: Option<String>,
    room_alias_name: Option<String>,
    public: bool,
}

async fn create_space(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<CreateSpaceRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let room_id = create_space_impl(
        &session.client,
        &request.name,
        request.topic.as_deref(),
        request.room_alias_name.as_deref(),
        request.public,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(room_id))
}

async fn leave_room(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    // No body extractor — same CORS "simple request" gap as `invite_member`.
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    leave_room_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn add_existing_space_child(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((room_id, child_room_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    // No body extractor — same CORS "simple request" gap as `invite_member`.
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    add_existing_space_child_impl(&session.client, &room_id, &child_room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_space_child(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((room_id, child_room_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    // No body extractor — same CORS "simple request" gap as `invite_member`.
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    remove_space_child_impl(&session.client, &room_id, &child_room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct SetSpaceChildSuggestedRequest {
    suggested: bool,
}

async fn set_space_child_suggested(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, child_room_id)): Path<(String, String)>,
    Json(request): Json<SetSpaceChildSuggestedRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_space_child_suggested_impl(&session.client, &room_id, &child_room_id, request.suggested)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct KnockRoomRequest {
    room_id_or_alias: String,
    reason: Option<String>,
}

async fn knock_room(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<KnockRoomRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    knock_room_impl(
        &session.client,
        &request.room_id_or_alias,
        request.reason.as_deref(),
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
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
    headers: axum::http::HeaderMap,
    Path((room_id, event_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    // Like `send_attachment`/`set_avatar`: a raw (non-JSON) `Bytes` body —
    // including an empty one, via `parse_optional_json` — is a CORS "simple
    // request", so a cross-*site* page can still trigger this `POST` without
    // ever needing a successful preflight the real allowlist could block.
    require_allowed_origin(&headers)?;
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
    Path(room_id): Path<String>,
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

async fn resend_message(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((room_id, transaction_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    // Zero-body POST, so (like `redact_event`) it's a CORS "simple request"
    // that never triggers a preflight the origin allowlist could otherwise
    // block — a cross-*site* page could still submit it with this session's
    // `SameSite=Strict` cookie attached if it knows a failed transaction id,
    // without this check.
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    resend_message_impl(&session.client, &room_id, &transaction_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn discard_failed_message(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((room_id, transaction_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    // See `resend_message`'s comment on the same guard.
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    let removed = discard_failed_message_impl(&session.client, &room_id, &transaction_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(removed))
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
    headers: axum::http::HeaderMap,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    // No body extractor at all — the plainest possible CORS "simple
    // request" shape, so this needs the same explicit `Origin` check the
    // raw-body routes already have.
    require_allowed_origin(&headers)?;
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

/// Reads the request body as raw room-avatar image bytes and uploads it in
/// one step — the bytes-based web equivalent of desktop's file-path-based
/// `room_admin::set_room_avatar` (`room_admin::set_room_avatar_impl` reads a
/// local file path, which a browser has none of; this mirrors `set_avatar`'s
/// own bytes-based approach instead).
async fn set_room_avatar(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(room_id): Path<String>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    let parsed_room_id =
        RoomId::parse(&room_id).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let room = session
        .client
        .get_room(&parsed_room_id)
        .ok_or_else(|| ApiError::not_found(format!("room {room_id} not found")))?;
    let mime = infer_image_mime(&body);
    room.upload_avatar(&mime, body.to_vec(), None)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_room_avatar(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    remove_room_avatar_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Server-published (room-directory) aliases for `room_id` — the web
/// equivalent of desktop's `get_room_local_aliases`.
async fn get_room_local_aliases(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let aliases = get_room_local_aliases_impl(&session.client, &room_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(aliases))
}

/// Advisory pre-check before [`add_room_alias`] — not room-scoped, matching
/// [`charm_lib::matrix::room_admin::check_room_alias_available`]'s own
/// signature (a candidate alias is checked against the whole homeserver's
/// directory, not a specific room).
async fn check_room_alias_available(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(alias): Json<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let available = check_room_alias_available_impl(&session.client, &alias)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(available))
}

/// Publishes `alias` in the homeserver's room directory pointing at
/// `room_id`. Does not touch `m.room.canonical_alias` — call
/// [`set_canonical_alias`] separately to make it canonical.
async fn add_room_alias(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(alias): Json<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    add_room_alias_impl(&session.client, &room_id, &alias)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Unpublishes `alias` from the homeserver's room directory. Not
/// room-scoped, matching
/// [`charm_lib::matrix::room_admin::remove_room_alias`]'s own signature.
async fn remove_room_alias(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(alias): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    remove_room_alias_impl(&session.client, &alias)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Sets or clears `m.room.canonical_alias`'s `alias` field. `None`/`null`
/// clears it.
async fn set_canonical_alias(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(room_id): Path<String>,
    Json(alias): Json<Option<String>>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    set_canonical_alias_impl(&session.client, &room_id, alias.as_deref())
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes `alias` from `m.room.canonical_alias`'s `alt_aliases` list
/// without touching the canonical `alias` field.
async fn remove_alt_alias(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((room_id, alias)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    remove_alt_alias_impl(&session.client, &room_id, &alias)
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
    headers: axum::http::HeaderMap,
    Path(room_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    // No body extractor — same CORS "simple request" gap as `mark_room_read`.
    require_allowed_origin(&headers)?;
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
    headers: axum::http::HeaderMap,
    Path((room_id, user_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    // No body extractor — same CORS "simple request" gap as `mark_room_read`.
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    invite_member_impl(&session.client, &room_id, &user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kick_member(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((room_id, user_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    // Raw/optional body — same CORS "simple request" gap as `redact_event`.
    require_allowed_origin(&headers)?;
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
    headers: axum::http::HeaderMap,
    Path((room_id, user_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    // Raw/optional body — same CORS "simple request" gap as `redact_event`.
    require_allowed_origin(&headers)?;
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
    headers: axum::http::HeaderMap,
    Path((room_id, user_id)): Path<(String, String)>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    // Raw/optional body — same CORS "simple request" gap as `redact_event`.
    require_allowed_origin(&headers)?;
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
    // Record it on the session too — the running sync loop reads this fresh
    // on every iteration (see `Session::sync_presence`'s doc comment) so
    // this explicit choice actually sticks across syncs instead of being
    // silently reverted to `Online` by the next long-poll.
    *session
        .sync_presence
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = request.presence;
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
    Ok(Json(OwnProfileResponse {
        profile,
        uses_oauth: session.client.oauth().user_session().is_some(),
    }))
}

#[derive(Serialize)]
struct OwnProfileResponse {
    #[serde(flatten)]
    profile: OwnProfile,
    uses_oauth: bool,
}

async fn get_account_deactivate_url(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Option<String>>, ApiError> {
    let session = require_session(&state, &jar).await?;
    Ok(Json(
        account_management_url(
            &session.client,
            AccountManagementActionData::AccountDeactivate,
        )
        .await,
    ))
}

async fn account_management_url(
    client: &matrix_sdk::Client,
    action: AccountManagementActionData<'_>,
) -> Option<String> {
    if client.matrix_auth().logged_in() {
        return None;
    }
    let metadata = client.oauth().server_metadata().await.ok()?;
    metadata
        .account_management_url_with_action(action)
        .map(|url| url.to_string())
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

/// Default square thumbnail size (px) for a resolved avatar — same value as
/// desktop's own `profiles::AVATAR_THUMBNAIL_SIZE` (not reusable directly:
/// it's `pub(crate)` there, and this is a plain literal rather than a
/// dependency worth exposing across the crate boundary for).
const DEFAULT_AVATAR_THUMBNAIL_SIZE: u32 = 96;

/// Upper bound on a caller-supplied `?size=` — an avatar has no legitimate
/// reason to be requested at more than a modest thumbnail resolution, and
/// this endpoint only requires a session cookie (not an Origin check the
/// way the state-changing raw-body routes have), so an untrusted same-site
/// page that can trigger this `GET` with a victim's cookie could otherwise
/// request an arbitrarily large dimension and make the server (and the
/// homeserver behind it) do expensive thumbnail work — buffering the full
/// result in memory before `MediaCache` ever gets to write it to disk — on
/// every request.
const MAX_AVATAR_THUMBNAIL_SIZE: u32 = 512;

/// Resolves a bare `mxc://` avatar URI (as carried, unresolved, by every
/// room/profile/sender DTO this crate's routes already return) to its
/// thumbnail bytes and streams them back — the room/profile-avatar
/// counterpart to `resolve_message_media`, which only covers event-attached
/// media. Reuses `resolve_avatar_thumbnail` against the same per-account
/// `MediaCache` `resolve_message_media` uses.
#[derive(Deserialize)]
struct ResolveAvatarQuery {
    mxc: String,
    #[serde(default)]
    size: Option<u32>,
}

async fn resolve_avatar(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Query(query): Query<ResolveAvatarQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let device_id = session
        .client
        .device_id()
        .ok_or_else(|| ApiError::bad_request("session has no device id"))?
        .to_string();
    let cache = crate::media_cache::for_session(&session.user_id, &device_id)
        .await
        .map_err(ApiError::bad_request)?;
    let size = query
        .size
        .unwrap_or(DEFAULT_AVATAR_THUMBNAIL_SIZE)
        .clamp(1, MAX_AVATAR_THUMBNAIL_SIZE);
    let path = charm_lib::matrix::media::resolve_avatar_thumbnail(
        cache,
        &session.client,
        &query.mxc,
        size,
    )
    .await
    .ok_or_else(|| ApiError::not_found("avatar could not be resolved"))?;

    // Same actual-bytes cap `resolve_message_media` applies below: the
    // `size` query param only clamps the *requested* thumbnail dimensions,
    // it doesn't bound what the homeserver/media repo actually hands back
    // for them. A logged-in tab (or an untrusted same-site page riding the
    // victim's cookie against this unauthenticated-by-body-size `GET`) could
    // otherwise make this route buffer/cache/serve an oversized body for a
    // single avatar URL.
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    if metadata.len() > charm_lib::matrix::send::MAX_ATTACHMENT_UPLOAD_BYTES {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(ApiError::bad_request(format!(
            "resolved avatar ({} bytes) exceeds the {} byte limit",
            metadata.len(),
            charm_lib::matrix::send::MAX_ATTACHMENT_UPLOAD_BYTES
        )));
    }

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    // Avatars are always bare (never encrypted) `mxc://` URIs resolved to a
    // server-generated thumbnail, which is always a plain image — no
    // declared-mimetype lookup or SVG exclusion needed here the way
    // `resolve_message_media` needs for arbitrary sender-controlled
    // attachments; sniffing is still worth it over guessing from
    // `MediaCache`'s extensionless filename.
    let content_type = sniff_content_type(&path, false)
        .await
        .unwrap_or_else(|| mime::IMAGE_PNG.to_string());
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file));
    Ok((
        [
            ("content-type", content_type),
            ("x-content-type-options", "nosniff".to_string()),
            (
                "cross-origin-resource-policy",
                media_corp_header(&headers).to_string(),
            ),
        ],
        body,
    ))
}

/// Spec 29 (link previews): the web companion's counterpart to desktop's
/// `get_url_preview` Tauri command, wrapping the same shared
/// `get_url_preview_impl` (homeserver `/preview_url` call, with legacy-path
/// fallback, mapped to a typed `UrlPreview`). `event_ts_ms` is optional and
/// forwarded as-is; a missing/unmapped preview is reported as `null` in the
/// JSON body rather than a 404 — matching desktop's "never a hard failure
/// for anything preview-shaped" contract (see `link_preview`'s module doc).
#[derive(Deserialize)]
struct PreviewUrlQuery {
    url: String,
    #[serde(default)]
    event_ts_ms: Option<i64>,
}

async fn preview_url(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(query): Json<PreviewUrlQuery>,
) -> Result<impl IntoResponse, ApiError> {
    require_web_transport_header(&headers)?;
    let session = require_session(&state, &jar).await?;
    let preview = get_url_preview_impl(&session.client, query.url, query.event_ts_ms).await;
    Ok(Json(preview))
}

/// Resolves an image/video/audio/file `m.room.message`'s attached media and
/// streams the resolved file back. Unlike desktop's `media::resolve_media`
/// (which hands the frontend a `file://`-loadable local cache path), a
/// browser has no such filesystem path to receive — so this reuses the same
/// `resolve_media_impl` (decryption, cache lookup/population, thumbnail vs.
/// full-size selection all included) against `crate::media_cache`'s
/// process-wide cache dir, then streams the resulting cached file back off
/// disk as the response body (never buffering the whole file into memory)
/// with a `Content-Type` guessed from its extension.
#[derive(Deserialize)]
struct ResolveMediaQuery {
    #[serde(default)]
    thumbnail: bool,
}

async fn resolve_message_media(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((room_id, event_id)): Path<(String, String)>,
    Query(query): Query<ResolveMediaQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let device_id = session
        .client
        .device_id()
        .ok_or_else(|| ApiError::bad_request("session has no device id"))?
        .to_string();
    let cache = crate::media_cache::for_session(&session.user_id, &device_id)
        .await
        .map_err(ApiError::bad_request)?;
    let declared = declared_media_info(&session.client, &room_id, &event_id).await;
    let path = charm_lib::matrix::media::resolve_media_impl(
        &session.client,
        cache,
        &room_id,
        &event_id,
        query.thumbnail,
    )
    .await
    .map_err(ApiError::bad_request)?;

    // `resolve_media_impl` downloads and caches the full file before we
    // ever see a path back — the declared `info.size` a sender attaches to
    // the event is untrusted and unchecked at download time, so a
    // malicious/misreporting sender can make this route (and the disk
    // behind `MediaCache`) download and cache arbitrarily large bytes
    // regardless of what it claimed. This can only catch it after the fact
    // — the real fix (capping bytes *during* download) belongs in
    // `charm_lib::matrix::media::resolve_media_impl` itself, shared with
    // desktop, and is out of scope for this route. Refusing to serve an
    // over-cap file at least stops this route from handing oversized bytes
    // back to the browser, and removes the now-useless cached copy rather
    // than leaving it on disk to be served by a later re-request.
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    if metadata.len() > charm_lib::matrix::send::MAX_ATTACHMENT_UPLOAD_BYTES {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(ApiError::bad_request(format!(
            "resolved media ({} bytes) exceeds the {} byte limit",
            metadata.len(),
            charm_lib::matrix::send::MAX_ATTACHMENT_UPLOAD_BYTES
        )));
    }

    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    // Sniff the actual resolved bytes first, falling back to the message's
    // declared mimetype, then a filename guess (always `octet-stream` here,
    // since `MediaCache` stores extensionless SHA-256 names — kept only as
    // a final, harmless fallback).
    //
    // Sniffing has to come *first*, not the declared mimetype: when a
    // thumbnail is requested, `resolve_media_impl` returns either a real
    // generated thumbnail (always a plain image, regardless of the full
    // media's type — e.g. a `video/mp4`'s thumbnail is a JPEG/PNG frame) or,
    // for encrypted media with no dedicated thumbnail source, silently falls
    // back to the *original* file — which could be non-image bytes
    // (`sniff_content_type` returning `None` for those correctly leaves the
    // declared mimetype in charge instead). Sniffing whichever one actually
    // came back, rather than assuming based on the `thumbnail` query flag,
    // handles both cases without needing to know which one
    // `resolve_media_impl` chose.
    let guessed_content_type = if let Some(sniffed) =
        sniff_content_type(std::path::Path::new(&path), declared.is_audio).await
    {
        sniffed
    } else if let Some(declared_mimetype) = declared.mimetype {
        declared_mimetype
    } else {
        mime_guess::from_path(&path)
            .first_or_octet_stream()
            .to_string()
    };
    // A `?thumbnail=true` request is only ever supposed to hand back a
    // small preview image — `resolve_media_impl` normally does exactly
    // that, but for *encrypted* media with no dedicated thumbnail source it
    // silently falls back to the original file instead (see the doc
    // comment above). Serving that fallback here — the full original
    // audio/video/file body, just mislabeled as a "thumbnail" response —
    // would hand a UI that treats every thumbnail URL as an `<img>` source
    // (video tiles in a room's media grid, say) something that can't
    // render as an image at all. Reject instead, the same "not found"
    // shape `resolve_avatar` already uses for an unresolvable avatar, so
    // the frontend's existing broken-image handling applies rather than a
    // multi-megabyte video download silently failing to paint.
    if query.thumbnail && !guessed_content_type.starts_with("image/") {
        return Err(ApiError::not_found(
            "no thumbnail available for this attachment",
        ));
    }
    // This route serves sender-controlled bytes under the browser's
    // authenticated API origin — reflecting an arbitrary declared mimetype
    // verbatim (e.g. `text/html`, or `image/svg+xml` — SVG is itself active
    // content, capable of embedding `<script>`, despite the `image/`
    // prefix) would let a malicious room member craft a "file" that the
    // browser executes same-origin if a user is ever linked straight to
    // this URL, with access to this origin's session cookie. Only
    // image/audio/video *excluding SVG* are safe to render inline; anything
    // else is downgraded to `application/octet-stream` with
    // `Content-Disposition: attachment` (forcing a download rather than
    // inline/same-origin execution) and `X-Content-Type-Options: nosniff`
    // blocks the browser from trying to sniff its way back to something
    // active anyway. Lowercased first — MIME types are case-insensitive and
    // sender-controlled (`Image/SVG+XML` is exactly as active as
    // `image/svg+xml`), so comparing against the raw declared casing would
    // let a trivially different-cased value skip this check entirely.
    let lower_content_type = guessed_content_type.to_ascii_lowercase();
    let is_safe_inline_type = !lower_content_type.contains("svg")
        && ["image/", "audio/", "video/"]
            .iter()
            .any(|prefix| lower_content_type.starts_with(prefix));
    let (content_type, content_disposition) = if is_safe_inline_type {
        (guessed_content_type, "inline")
    } else {
        ("application/octet-stream".to_string(), "attachment")
    };
    // `<audio>`/`<video>` elements commonly issue `Range` requests for
    // initial buffering and seeking — without honoring them, a browser has
    // to download a large file from the very start before playback (or any
    // seek) can begin, and every seek re-fetches the whole file. Only a
    // single range is handled (`parse_range` rejects a comma-separated
    // multi-range request by returning `None`), which is what every real
    // browser media element actually sends; an unsatisfiable/invalid Range
    // falls back to serving the full file as a plain `200`, same as if no
    // `Range` header had been sent at all, rather than erroring.
    let file_len = metadata.len();
    let range = headers
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_byte_range(v, file_len));
    let (status, start, response_len, content_range) = match range {
        Some((start, end)) => (
            StatusCode::PARTIAL_CONTENT,
            start,
            end - start + 1,
            Some(format!("bytes {start}-{end}/{file_len}")),
        ),
        None => (StatusCode::OK, 0, file_len, None),
    };
    if start > 0 {
        use tokio::io::AsyncSeekExt;
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|e| ApiError::bad_request(e.to_string()))?;
    }
    let limited = tokio::io::AsyncReadExt::take(file, response_len);
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(limited));

    let mut response = axum::response::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("content-disposition", content_disposition)
        .header("x-content-type-options", "nosniff")
        .header("accept-ranges", "bytes")
        .header("content-length", response_len.to_string())
        // Same-site subdomains attach this session's cookie automatically
        // (`SameSite=Strict` only blocks cross-*site*), so without this a
        // subdomain page could embed this URL as an `<img>`/`<video>` and
        // — even unable to read the bytes directly — learn whether the
        // victim can access this private attachment at all (load succeeds
        // vs. errors) purely from `onload`/`onerror`/media-metadata timing,
        // and render it inside the attacker's own page. `same-origin`
        // refuses to load this response as a subresource from any origin
        // but this one — relaxed to `cross-origin` only when
        // `CHARM_WEB_SERVER_ALLOWED_ORIGIN` is configured, see
        // `media_corp_header`'s doc comment.
        .header("cross-origin-resource-policy", media_corp_header(&headers));
    if let Some(content_range) = content_range {
        response = response.header("content-range", content_range);
    }
    response
        .body(body)
        .map_err(|e| ApiError::bad_request(e.to_string()))
}

/// Parses a single-range `Range: bytes=...` header value against a known
/// file length, returning the inclusive `(start, end)` byte offsets to
/// serve. `None` for anything this doesn't confidently understand — a
/// missing/malformed header, a multi-range request (`bytes=0-10,20-30`,
/// vanishingly rare from a real media element and not worth the added
/// complexity of a multipart/byteranges response), or a range starting at
/// or past the end of the file — callers treat `None` the same as "no Range
/// header was sent" and serve the full file rather than erroring.
fn parse_byte_range(header: &str, file_len: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start_str, end_str) = spec.split_once('-')?;
    if start_str.is_empty() {
        // Suffix range (`bytes=-500` = "the last 500 bytes").
        let suffix_len: u64 = end_str.parse().ok()?;
        if suffix_len == 0 || file_len == 0 {
            return None;
        }
        return Some((file_len.saturating_sub(suffix_len), file_len - 1));
    }
    let start: u64 = start_str.parse().ok()?;
    if start >= file_len {
        return None;
    }
    let end = if end_str.is_empty() {
        file_len - 1
    } else {
        end_str.parse::<u64>().ok()?.min(file_len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

/// Best-effort lookup of an image/video/audio/file message's declared
/// `mimetype`, `None` on any failure (unparsed ids, non-message event,
/// missing `info`) — callers fall back to a filename-based guess rather than
/// failing the whole media request over a missing/malformed content-type.
/// The declared `info.mimetype` (optional, per the Matrix spec — a sender
/// can omit it) plus whether the event's `msgtype` is `m.audio`. The latter
/// is a hard signal straight from the event itself, not a heuristic, and
/// covers ambiguous containers (WebM/Matroska's magic bytes alone can't
/// distinguish audio-only from video — see `sniffed_av_mime`) even when
/// `mimetype` itself is missing.
#[derive(Default)]
struct DeclaredMediaInfo {
    mimetype: Option<String>,
    is_audio: bool,
}

async fn declared_media_info(
    client: &matrix_sdk::Client,
    room_id: &str,
    event_id: &str,
) -> DeclaredMediaInfo {
    try_declared_media_info(client, room_id, event_id)
        .await
        .unwrap_or_default()
}

async fn try_declared_media_info(
    client: &matrix_sdk::Client,
    room_id: &str,
    event_id: &str,
) -> Option<DeclaredMediaInfo> {
    use matrix_sdk::ruma::events::room::message::MessageType;
    use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncTimelineEvent};

    let parsed_room_id = RoomId::parse(room_id).ok()?;
    let room = client.get_room(&parsed_room_id)?;
    let parsed_event_id = matrix_sdk::ruma::EventId::parse(event_id).ok()?;
    let event = room.event(&parsed_event_id, None).await.ok()?;
    let deserialized: AnySyncTimelineEvent = event.kind.raw().deserialize().ok()?;
    let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(msg)) = deserialized
    else {
        return None;
    };
    let original = msg.as_original()?;
    let is_audio = matches!(original.content.msgtype, MessageType::Audio(_));
    let mimetype = match &original.content.msgtype {
        MessageType::Image(c) => c.info.as_ref().and_then(|i| i.mimetype.clone()),
        MessageType::Video(c) => c.info.as_ref().and_then(|i| i.mimetype.clone()),
        MessageType::Audio(c) => c.info.as_ref().and_then(|i| i.mimetype.clone()),
        MessageType::File(c) => c.info.as_ref().and_then(|i| i.mimetype.clone()),
        _ => None,
    };
    Some(DeclaredMediaInfo { mimetype, is_audio })
}

/// Uploads a room attachment as `multipart/form-data` (a browser has no
/// local file path to hand over the way desktop's `send_attachment` takes
/// one) and pushes `upload:progress` over this session's WebSocket channel
/// as the upload progresses — same `SharedObservable`-subscribing forwarder
/// pattern as desktop's `send::spawn_progress_forwarder`, just pushing onto
/// this session's broadcast channel instead of `app.emit`.
///
/// Expected fields: `file` (the attachment bytes, with its filename and
/// `Content-Type` carried by the part itself — not a manually-set request
/// header, per multipart's own encoding), `txn_id` (opaque caller-generated
/// correlation id), and an optional `caption`. Multipart, not raw
/// bytes-plus-query/headers (an earlier version of this route used
/// base64-encoded `x-attachment-filename`/`x-attachment-caption` headers):
/// a header value has to fit within the browser/reverse-proxy/server's
/// header-size limits, which a caption of even a few KB — inflated further
/// by base64 — could blow past well before Matrix's own event-size limits
/// ever came into play, rejecting an upload the underlying protocol would
/// have accepted just fine.
#[derive(Debug, Deserialize)]
struct AttachmentQuery {
    txn_id: String,
}

async fn send_attachment(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(room_id): Path<String>,
    Query(query): Query<AttachmentQuery>,
    mut multipart: axum::extract::Multipart,
) -> Result<impl IntoResponse, ApiError> {
    // A `multipart/form-data` body is itself one of the CORS-safelisted
    // "simple" content types, so — same as the raw-bytes version this
    // replaced — this still needs its own explicit Origin check rather
    // than relying on a preflight to have gated it.
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    let parsed_room_id =
        RoomId::parse(&room_id).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let room = session
        .client
        .get_room(&parsed_room_id)
        .ok_or_else(|| ApiError::not_found(format!("room {room_id} not found")))?;

    let mut filename = None;
    let mut declared_mime: Option<mime::Mime> = None;
    let mut data: Option<Vec<u8>> = None;
    let mut caption = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?
    {
        match field.name() {
            Some("file") => {
                filename = field.file_name().map(str::to_string);
                declared_mime = field.content_type().and_then(|ct| ct.parse().ok());
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::bad_request(e.to_string()))?;
                if bytes.len() as u64 > charm_lib::matrix::send::MAX_ATTACHMENT_UPLOAD_BYTES {
                    return Err(ApiError::bad_request(format!(
                        "attachment is {} bytes, over the {}-byte limit",
                        bytes.len(),
                        charm_lib::matrix::send::MAX_ATTACHMENT_UPLOAD_BYTES
                    )));
                }
                data = Some(bytes.to_vec());
            }
            Some("caption") => {
                caption = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| ApiError::bad_request(e.to_string()))?,
                );
            }
            _ => {}
        }
    }
    let filename = filename.ok_or_else(|| ApiError::bad_request("missing file field"))?;
    let data = data.ok_or_else(|| ApiError::bad_request("missing file field"))?;
    let total_bytes = data.len() as u64;

    // Prefer the part's own `Content-Type` (a `File` object's `.type`,
    // sniffed from its actual bytes/extension by the browser itself — more
    // reliable than re-guessing server-side from just the filename, which
    // misses a camera photo with no or a misleading extension) over a
    // filename-only guess. Falls back to the filename guess when the part
    // either omits `Content-Type` or sends one of the generic defaults a
    // browser sets automatically when it *doesn't* know the real type —
    // those carry no more information than not sending it at all, so they
    // shouldn't override the guess.
    let mime = declared_mime
        .filter(|m| *m != mime::APPLICATION_OCTET_STREAM && *m != mime::TEXT_PLAIN)
        .unwrap_or_else(|| mime_guess::from_path(&filename).first_or_octet_stream());
    let info = attachment_info_for(&mime, &data, total_bytes);

    let ruma_txn_id: matrix_sdk::ruma::OwnedTransactionId = query.txn_id.clone().into();
    let mut config = AttachmentConfig::new().txn_id(ruma_txn_id).info(info);
    if let Some(caption) = caption {
        config = config.caption(Some(
            matrix_sdk::ruma::events::room::message::TextMessageEventContent::plain(caption),
        ));
    }

    let progress =
        eyeball::SharedObservable::<matrix_sdk::TransmissionProgress>::new(Default::default());
    let forwarder = spawn_progress_forwarder(
        session.events.clone(),
        progress.clone(),
        query.txn_id.clone(),
        room_id.clone(),
        total_bytes,
    );

    let send = room
        .send_attachment(filename, &mime, data, config)
        .with_send_progress_observable(progress);
    let result = send.await;
    // The forwarder holds its own clone of `progress`, so it doesn't close
    // on its own when this function's binding is dropped — abort it
    // explicitly once the upload settles, same as desktop's
    // `send_attachment` does with its own forwarder handle.
    forwarder.abort();
    result.map_err(|e| ApiError::bad_request(e.to_string()))?;

    // A terminal 100% event, in case the observable's last tick didn't land
    // exactly on completion — lets the frontend's progress bar clear
    // deterministically, same as desktop's post-upload emit.
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

/// Subscribes to `progress` and forwards each update as an `upload:progress`
/// `ServerEvent`, for as long as the upload is in flight — see desktop's
/// `send::spawn_progress_forwarder` for the equivalent `app.emit` version
/// this mirrors.
fn spawn_progress_forwarder(
    events: tokio::sync::broadcast::Sender<crate::events::ServerEvent>,
    progress: eyeball::SharedObservable<matrix_sdk::TransmissionProgress>,
    txn_id: String,
    room_id: String,
    total_bytes: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut subscriber = progress.subscribe();
        while let Some(update) = subscriber.next().await {
            let _ = events.send(crate::events::ServerEvent::UploadProgress(
                charm_lib::matrix::send::UploadProgress {
                    txn_id: txn_id.clone(),
                    room_id: room_id.clone(),
                    sent: update.current as u64,
                    total: if update.total > 0 {
                        update.total as u64
                    } else {
                        total_bytes
                    },
                },
            ));
        }
    })
}

/// Reads the request body as raw avatar image bytes and uploads it as the
/// account avatar in one step — the bytes-based web equivalent of desktop's
/// file-path-based `account::set_avatar`.
async fn set_avatar(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    // Same rationale as `send_attachment`: a raw, non-JSON body means no
    // automatic CORS preflight, so this needs its own explicit Origin check.
    require_allowed_origin(&headers)?;
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

async fn set_display_name(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(display_name): Json<Option<String>>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    session
        .client
        .account()
        .set_display_name(display_name.as_deref())
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Sniffs the real content type from the image bytes themselves (the `image`
/// crate's own format-detection, not a hand-rolled magic-byte match — this
/// crate already depends on it for `attachment_info_for`'s dimension
/// probing) rather than defaulting to `image/png` for anything it doesn't
/// recognize, which silently mislabeled every WebP/AVIF/BMP/etc. avatar
/// upload as PNG. Falls back to `application/octet-stream` (not
/// `image/png`) when the bytes aren't a recognized image format at all —
/// `set_avatar_impl`'s caller has already decided this is meant to be an
/// avatar, but mislabeling unrecognized bytes as a specific image type is
/// worse than an honest "unknown" content type.
fn infer_image_mime(bytes: &[u8]) -> mime::Mime {
    sniffed_image_mime(bytes).unwrap_or(mime::APPLICATION_OCTET_STREAM)
}

/// `None` when the bytes aren't a recognized image format at all — as
/// opposed to [`infer_image_mime`]'s `Mime`-always contract, callers here
/// (`sniff_content_type`) need to distinguish "definitely not an image" from
/// "unrecognized, default to octet-stream" so they can fall through to a
/// different source of truth (the message's declared mimetype) instead of
/// prematurely committing to octet-stream.
fn sniffed_image_mime(bytes: &[u8]) -> Option<mime::Mime> {
    // `guess_format` only inspects magic bytes to identify the format — it
    // works regardless of whether this crate's `image` build actually has
    // the matching *decode* feature enabled (e.g. `avif` pulls in a heavy
    // `dav1d`-based decoder this crate doesn't otherwise need), so every
    // format `guess_format` can recognize is safe to map here even though
    // only a subset would successfully decode.
    match image::guess_format(bytes) {
        Ok(image::ImageFormat::Png) => Some(mime::IMAGE_PNG),
        Ok(image::ImageFormat::Jpeg) => Some(mime::IMAGE_JPEG),
        Ok(image::ImageFormat::Gif) => Some(mime::IMAGE_GIF),
        Ok(image::ImageFormat::WebP) => Some("image/webp".parse().expect("valid mime")),
        Ok(image::ImageFormat::Bmp) => Some(mime::IMAGE_BMP),
        Ok(image::ImageFormat::Avif) => Some("image/avif".parse().expect("valid mime")),
        Ok(image::ImageFormat::Tiff) => Some("image/tiff".parse().expect("valid mime")),
        Ok(image::ImageFormat::Ico) => Some("image/x-icon".parse().expect("valid mime")),
        Ok(_) | Err(_) => None,
    }
}

/// Reads a small prefix of the file at `path` and sniffs its content type —
/// `None` if the bytes aren't a recognized image format (audio/video/other
/// binary formats have no cheap universal magic-byte sniff this crate
/// already depends on, so those fall through to the caller's next source of
/// truth rather than being guessed at here). `is_audio_hint` is a hard
/// signal from the message's own `msgtype` (see `DeclaredMediaInfo`), used
/// only to disambiguate a container format (WebM) whose magic bytes alone
/// can't tell audio-only from video-carrying — callers resolving an
/// avatar/thumbnail (always a plain image, no such ambiguity) pass `false`.
async fn sniff_content_type(path: &std::path::Path, is_audio_hint: bool) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let mut prefix = [0u8; 64];
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let read = file.read(&mut prefix).await.ok()?;
    let prefix = &prefix[..read];
    sniffed_image_mime(prefix)
        .map(|mime| mime.to_string())
        .or_else(|| sniffed_av_mime(prefix, is_audio_hint))
}

/// A small, hand-rolled magic-byte sniff for the common audio/video
/// container formats — unlike images, this crate has no existing dependency
/// that already does A/V format detection, so this only covers the formats
/// actually likely to show up as Matrix attachments rather than being
/// exhaustive. `None` (not a guess) for anything unrecognized; callers fall
/// through to a filename-based guess from there.
fn sniffed_av_mime(bytes: &[u8], is_audio_hint: bool) -> Option<String> {
    // MP4-family containers (mp4/mov/m4a/3gp/heic, ...): a 4-byte size
    // field, then the literal ASCII `ftyp` box type at offset 4, then a
    // 4-byte "major brand" at offset 8 — the size varies per file, so this
    // can't be a fixed-offset prefix match against the whole box like the
    // others below. `M4A `/`M4B ` are audio-only brands (a plain audio
    // track in an MP4 container, e.g. iTunes/podcast downloads) — labeling
    // them `video/mp4` would have a browser render a black video player for
    // audio-only content. HEIC/HEIF brands are ISO-BMFF *images* (the
    // default photo format on recent iPhones) sharing the same `ftyp` box
    // structure as MP4 — labeling those `video/mp4` would make a browser
    // try to play a still photo as video and fail to render it at all, so
    // this crate's own `sniff_content_type` (this function's only caller)
    // must recognize them as `None`/not-A/V here and let the message's
    // declared `image/heic` mimetype win instead, rather than this function
    // ever claiming they're video. Every other brand (`isom`, `mp41`/
    // `mp42`, `qt  `, `3gp*`, ...) does carry video, so that's still the
    // reasonable default for anything not explicitly listed.
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return match &bytes[8..12] {
            b"M4A " | b"M4B " => Some("audio/mp4".to_string()),
            b"heic" | b"heix" | b"heim" | b"heis" | b"hevc" | b"hevx" | b"mif1" | b"msf1" => None,
            _ => Some("video/mp4".to_string()),
        };
    }
    match bytes {
        // EBML (Matroska/WebM's container format) has no fixed-offset
        // signal distinguishing an audio-only WebM/Opus file from one that
        // also carries video — that requires parsing into the EBML tree
        // itself, well beyond a magic-byte sniff. Unlike the MP4 case
        // above (where the `ftyp` major brand *does* cheaply disambiguate
        // audio-only), guessing wrong here would mislabel a legitimate
        // attachment (audio rendered as an unplayable video, or vice
        // versa) — so this defers to `is_audio_hint`, the message's own
        // `msgtype` (a hard signal, not a guess; see `DeclaredMediaInfo`),
        // rather than assuming either way from the magic bytes alone.
        [0x1A, 0x45, 0xDF, 0xA3, ..] => Some(if is_audio_hint {
            "audio/webm".to_string()
        } else {
            "video/webm".to_string()
        }),
        [b'O', b'g', b'g', b'S', ..] => Some("audio/ogg".to_string()),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'A', b'V', b'E', ..] => {
            Some("audio/wav".to_string())
        }
        [b'I', b'D', b'3', ..] | [0xFF, 0xFB, ..] | [0xFF, 0xF3, ..] | [0xFF, 0xF2, ..] => {
            Some("audio/mpeg".to_string())
        }
        [b'f', b'L', b'a', b'C', ..] => Some("audio/flac".to_string()),
        _ => None,
    }
}

async fn remove_avatar(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    // DELETE isn't a CORS "simple method", so this is already preflighted —
    // checked anyway for defense in depth and consistency with `set_avatar`.
    require_allowed_origin(&headers)?;
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
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    // Bodyless/optional-body POST — same CSRF exposure as `send_attachment`.
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    let request: BootstrapCrossSigningRequest = parse_optional_json(&body)?;
    bootstrap_cross_signing_impl(&session.client, request.password)
        .await
        .map_err(|error| match error {
            UiaCommandError::UiaChallenge => ApiError::uia_challenge(),
            UiaCommandError::Other { message } => ApiError::uia_other(message),
        })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_cross_signing_reset_url(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    Ok(Json(
        get_cross_signing_reset_url_impl(&session.client).await,
    ))
}

async fn get_recovery_status(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    Ok(Json(recovery_status_impl(&session.client)))
}

#[derive(Debug, Deserialize)]
struct RecoverFromKeyRequest {
    recovery_key: String,
}

async fn recover_from_key(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(request): Json<RecoverFromKeyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let token = jar
        .get(SESSION_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or_else(|| ApiError::unauthorized("no session cookie"))?;
    let session = require_session(&state, &jar).await?;
    recover_from_key_impl(&session.client, &request.recovery_key)
        .await
        .map_err(ApiError::bad_request)?;
    if let (Some(persistence), Some(matrix_session), Some(crypto)) = (
        &state.persistence,
        session.client.matrix_auth().session(),
        session.persisted_crypto.as_ref(),
    ) {
        if let Err(error) = persistence
            .snapshot_crypto_store(
                &token,
                &matrix_session,
                Some((crypto.store_key.as_str(), crypto.passphrase.as_str())),
            )
            .await
        {
            tracing::error!("recovery succeeded but the durable crypto snapshot failed: {error}");
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn accept_verification(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((other_user_id, flow_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    accept_verification_request_impl(&session.client, &other_user_id, &flow_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn cancel_verification(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path((other_user_id, flow_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    require_allowed_origin(&headers)?;
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
    headers: axum::http::HeaderMap,
    Path((other_user_id, flow_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    crate::sync_loop::start_sas_verification(
        &session.client,
        session.events.clone(),
        session.pending_verification_events.clone(),
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
    headers: axum::http::HeaderMap,
    Path((other_user_id, flow_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    confirm_sas_verification_impl(&session.client, &other_user_id, &flow_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Starts an outgoing self-verification of another of this account's own
/// devices — see `sync_loop::request_device_verification`.
async fn request_device_verification(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(device_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    let flow_id = crate::sync_loop::request_device_verification(
        &session.client,
        session.events.clone(),
        session.pending_verification_events.clone(),
        &device_id,
    )
    .await
    .map_err(ApiError::bad_request)?;
    Ok(Json(flow_id))
}

async fn list_devices(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    let devices = list_devices_impl(&session.client)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(devices))
}

#[derive(Debug, Deserialize, Default)]
struct DeleteDeviceRequest {
    password: Option<String>,
}

async fn delete_device(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(device_id): Path<String>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    require_allowed_origin(&headers)?;
    let session = require_session(&state, &jar).await?;
    let request: DeleteDeviceRequest = parse_optional_json(&body)?;
    delete_device_impl(&session.client, device_id, request.password)
        .await
        .map_err(|error| match error {
            UiaCommandError::UiaChallenge => ApiError::uia_challenge(),
            UiaCommandError::Other { message } => ApiError::uia_other(message),
        })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_device_delete_url(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(device_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = require_session(&state, &jar).await?;
    Ok(Json(
        get_device_delete_url_impl(&session.client, device_id).await,
    ))
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
/// Env var naming the frontend origin(s) allowed to open `/api/ws`
/// (comma-separated for more than one, e.g. a staging + prod frontend). The
/// session cookie alone doesn't defend against this: `SameSite=Strict`
/// blocks a cookie from being sent on a cross-*site* request, but a
/// same-*site* subdomain (a different origin, same registrable domain — the
/// exact case this env var exists to reject) still gets the cookie sent
/// automatically, since `SameSite` never distinguishes between an app's own
/// subdomains. A WebSocket handshake is still an ordinary HTTP request the
/// browser attaches cookies to, so without an explicit `Origin` check here,
/// any page on any subdomain of this deployment's registrable domain could
/// open this socket and read another logged-in user's room list, timeline,
/// profile, and verification events.
const ALLOWED_ORIGIN_ENV: &str = "CHARM_WEB_SERVER_ALLOWED_ORIGIN";

/// Logged at most once per process — `origin_is_allowed` runs on every WS
/// handshake, and warning on every single rejected handshake while a
/// deployment is misconfigured would be pure noise.
static WARNED_NO_ALLOWED_ORIGIN: std::sync::OnceLock<()> = std::sync::OnceLock::new();

fn origin_is_allowed(origin: Option<&str>) -> bool {
    let Ok(allowed) = std::env::var(ALLOWED_ORIGIN_ENV) else {
        WARNED_NO_ALLOWED_ORIGIN.get_or_init(|| {
            tracing::warn!(
                "{ALLOWED_ORIGIN_ENV} not set — rejecting WebSocket and raw-body requests with \
                 an Origin header. Set it explicitly before deploying charm-web-server."
            );
        });
        return false;
    };
    let Some(origin) = origin else {
        return false;
    };
    allowed
        .split(',')
        .map(str::trim)
        .any(|allowed_origin| origin_matches_allowed_entry(allowed_origin, origin))
}

fn origin_matches_allowed_entry(allowed_origin: &str, origin: &str) -> bool {
    let Some(wildcard_index) = allowed_origin.find('*') else {
        return allowed_origin == origin;
    };
    if allowed_origin[wildcard_index + 1..].contains('*') {
        return false;
    }

    let (prefix, suffix_with_wildcard) = allowed_origin.split_at(wildcard_index);
    let suffix = &suffix_with_wildcard[1..];
    if prefix.is_empty() || suffix.is_empty() || prefix.ends_with("://") {
        return false;
    }

    origin.starts_with(prefix)
        && origin.ends_with(suffix)
        && origin.len() > prefix.len() + suffix.len()
}

/// Shared guard for the state-changing routes that accept a raw (non-JSON)
/// body and so don't get an automatic CORS preflight — see
/// `send_attachment`'s call site for the full rationale.
fn require_allowed_origin(headers: &axum::http::HeaderMap) -> Result<(), ApiError> {
    let Some(origin) = headers.get(axum::http::header::ORIGIN) else {
        return Ok(());
    };
    let origin = origin.to_str().map_err(|_| ApiError {
        status: StatusCode::FORBIDDEN,
        message: "origin not allowed".to_string(),
        kind: None,
    })?;
    if origin_is_allowed(Some(origin)) {
        Ok(())
    } else {
        Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "origin not allowed".to_string(),
            kind: None,
        })
    }
}

/// Requires the non-simple header that Charm's web transport adds to API
/// requests. A browser cannot attach this header to an `<img>` or other
/// no-CORS subresource request, while cross-origin script requests that do
/// attach it must first pass the allowlisted CORS preflight. This is request
/// shape validation, not authentication; handlers must still require the
/// session cookie separately.
fn require_web_transport_header(headers: &axum::http::HeaderMap) -> Result<(), ApiError> {
    if headers.contains_key("x-charm-operation-id") {
        Ok(())
    } else {
        Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "web transport header required".to_string(),
            kind: None,
        })
    }
}

/// `Cross-Origin-Resource-Policy` value for the media/avatar routes below.
/// A blanket `same-origin` (what both routes originally sent unconditionally)
/// is what protects sender-controlled media from being embedded by an
/// arbitrary third-party page — but it also blocks the browser from loading
/// it as a subresource (`<img>`/`<video>`/`<audio src>`) from a *legitimate*
/// cross-origin frontend deployment, exactly the deployment shape
/// `CHARM_WEB_SERVER_ALLOWED_ORIGIN` exists to support: that frontend can
/// call the JSON API (CORS now allows it) but couldn't render any resolved
/// attachment or avatar. Relaxing to `cross-origin` only when the request's
/// own `Origin` header is actually on that same allowlist keeps every
/// still-untrusted origin blocked (including same-site subdomains
/// `SameSite=Strict` doesn't stop) while unblocking the one frontend this
/// deployment is actually configured to trust. When
/// `CHARM_WEB_SERVER_ALLOWED_ORIGIN` is unset, this keeps the stricter
/// `same-origin` policy rather than silently loosening protection for the
/// common same-origin/local-dev case that never needed it relaxed in the
/// first place.
/// Extracts just the `scheme://host[:port]` portion of a `Referer` header
/// value — enough to compare against an `Origin`-shaped allowlist entry,
/// without pulling in a full URL-parsing crate for one field.
fn origin_from_referer(referer: &str) -> Option<String> {
    let scheme_end = referer.find("://")?;
    let after_scheme = &referer[scheme_end + 3..];
    let path_start = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    Some(format!(
        "{}://{}",
        &referer[..scheme_end],
        &after_scheme[..path_start]
    ))
}

/// `same-origin` unconditionally relaxing to `cross-origin` deployment-wide
/// whenever `CHARM_WEB_SERVER_ALLOWED_ORIGIN` is merely *configured* (an
/// earlier version of this function did exactly that) is a real hole, not
/// just an over-broad default: CORP is **not** redundant with
/// `require_session`'s cookie check the way that earlier version assumed —
/// `SameSite=Strict` still attaches this session's cookie to a request from
/// an untrusted *same-site* subdomain (see `ALLOWED_ORIGIN_ENV`'s own doc
/// comment on the WS handshake for the identical concern), so relaxing CORP
/// for literally every requester once the env var is set would let any such
/// subdomain embed/probe private media, not just the deployer's actual
/// trusted frontend.
///
/// So this has to identify the *specific* requesting page, not just "is
/// cross-origin support turned on". `Origin` is authoritative when present
/// (real CORS-mode `fetch`/XHR calls always send it) but a plain
/// `<img>`/`<video>`/`<audio src>` subresource load is a "no-cors" fetch
/// and omits `Origin` entirely — for those this falls back to `Referer`
/// (still sent by default under the common `strict-origin-when-cross-origin`
/// referrer policy, at least enough to recover the origin) and checks that
/// against the same allowlist. If neither header identifies an allowed
/// origin — including the "header simply wasn't sent" case, e.g. a stricter
/// referrer-policy or a privacy-focused browser — this fails closed to
/// `same-origin`, consistent with every other allowlist check in this
/// crate.
fn media_corp_header(headers: &axum::http::HeaderMap) -> &'static str {
    let Ok(allowed) = std::env::var(ALLOWED_ORIGIN_ENV) else {
        return "same-origin";
    };
    let allowed_origins: Vec<&str> = allowed
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .collect();

    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        return if allowed_origins
            .iter()
            .any(|allowed_origin| origin_matches_allowed_entry(allowed_origin, origin))
        {
            "cross-origin"
        } else {
            "same-origin"
        };
    }

    if let Some(referer_origin) = headers
        .get(axum::http::header::REFERER)
        .and_then(|v| v.to_str().ok())
        .and_then(origin_from_referer)
    {
        if allowed_origins
            .iter()
            .any(|allowed_origin| origin_matches_allowed_entry(allowed_origin, &referer_origin))
        {
            return "cross-origin";
        }
    }

    "same-origin"
}

async fn ws_handler(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, ApiError> {
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if !origin_is_allowed(origin) {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "origin not allowed".to_string(),
            kind: None,
        });
    }
    let session = require_session(&state, &jar).await?;
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, session)))
}

/// How often the server sends an unsolicited `Ping` to keep this connection
/// alive. Without this, a room the user hasn't touched in a while can go
/// long stretches with nothing to push (`sync:state`/`room_list:update`
/// only fire on an actual sync response, and matrix-sdk's long-poll can
/// itself run tens of seconds between them) — well within the idle timeout
/// window most reverse proxies/load balancers enforce (commonly 30-90s),
/// which would otherwise silently drop the TCP connection out from under a
/// perfectly healthy WebSocket, leaving the browser unaware it's no longer
/// receiving live updates until it next tries to send something.
const WS_KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);

/// Re-buffers `failed_event` plus the rest of `remaining` (the events
/// `handle_socket` hadn't yet attempted to send when its `socket.send`
/// call failed/errored) back onto `session.pending_verification_events`,
/// preserving FIFO order against anything that arrived concurrently.
///
/// Not a plain `buffer.push(failed_event); buffer.extend(remaining)` — the
/// original drain (`std::mem::take` in `handle_socket`) releases the lock
/// immediately, and this function's own re-buffering only reacquires it
/// after the `.await` on `socket.send` that determined `failed_event`. In
/// that gap, `sync_loop::buffer_verification_event` can push a genuinely
/// newer event onto the (now-empty) buffer from a concurrent task; a plain
/// push+extend would then append these older, not-yet-delivered events
/// *after* that newer one, reversing the order a reconnecting client
/// replays them in. Reading the buffer's current contents fresh under this
/// same lock and prepending the older events ahead of them keeps delivery
/// order correct regardless of what raced in during the gap.
fn requeue_pending_verification_events(
    session: &Session,
    failed_event: crate::events::ServerEvent,
    remaining: impl Iterator<Item = crate::events::ServerEvent>,
) {
    let mut buffer = session
        .pending_verification_events
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut requeued: Vec<crate::events::ServerEvent> =
        std::iter::once(failed_event).chain(remaining).collect();
    requeued.extend(std::mem::take(&mut *buffer));
    *buffer = requeued;
}

/// Keeps `Session::ws_connections` accurate across every exit path out of
/// `handle_socket` (clean close, a failed `socket.send`, the lag-induced
/// forced close) — see that field's doc comment for why an open connection
/// must always count as active for `SessionStore::sweep_idle`, regardless
/// of how long ago this session's last HTTP request was.
struct WsConnectionGuard(Arc<Session>);

impl WsConnectionGuard {
    fn new(session: Arc<Session>) -> Self {
        session
            .ws_connections
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self(session)
    }
}

impl Drop for WsConnectionGuard {
    fn drop(&mut self) {
        self.0
            .ws_connections
            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

async fn handle_socket(mut socket: WebSocket, session: Arc<Session>) {
    let _connection_guard = WsConnectionGuard::new(Arc::clone(&session));
    let mut receiver = session.events.subscribe();
    // Drain (not just peek) any verification requests that arrived before a
    // client was connected to receive them — see
    // `Session::pending_verification_requests`'s doc comment. Taken, not
    // cloned, so a second tab connecting later doesn't re-deliver the same
    // already-seen request; if this socket fails to send one it's dropped,
    // same as any other transient send failure elsewhere in this loop.
    let pending = std::mem::take(
        &mut *session
            .pending_verification_events
            .lock()
            .unwrap_or_else(|e| e.into_inner()),
    );
    let mut pending = pending.into_iter();
    for event in pending.by_ref() {
        let json = match serde_json::to_string(&event) {
            Ok(json) => json,
            // `ServerEvent`'s variants are all plain, always-serializable
            // data (strings, bools, small structs) — this realistically
            // never fails — but treating a hypothetical failure the same
            // as a send failure (below), instead of silently dropping the
            // event via `continue`, costs nothing and keeps this loop's
            // only two outcomes for a pending event "delivered" or
            // "still buffered", never "silently lost".
            Err(_) => {
                requeue_pending_verification_events(&session, event, pending);
                return;
            }
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            // This socket died mid-flush — the entries not yet sent
            // (including this one) go back into the buffer rather than
            // being dropped, so the *next* connection attempt (this
            // browser's automatic reconnect, or another tab) still finds
            // them instead of the flow being lost for good.
            requeue_pending_verification_events(&session, event, pending);
            return;
        }
    }

    // Replay the current `sync:state`/`room_list:update`/`badge:update`
    // snapshot — see `Session::last_snapshot`'s doc comment. Login/restore's
    // sync loop has almost always already produced these by the time a
    // browser can open this socket, and `broadcast` never replays to a
    // subscriber that joins after the fact, so without this a freshly
    // connected tab would see a blank room list/badge until the *next* sync
    // iteration happened to change something.
    let snapshot = session
        .last_snapshot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    for event in snapshot {
        let Ok(json) = serde_json::to_string(&event) else {
            continue;
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }

    // Replay each open room's latest `timeline:update` too — see
    // `Session::room_snapshots`'s doc comment. Otherwise a room already
    // open before this connection (or before a reconnect) would show
    // nothing new until its *next* live diff, silently missing whatever
    // arrived during the gap.
    let room_snapshots: Vec<_> = session
        .room_snapshots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|(_, event)| event.clone())
        .collect();
    for event in room_snapshots {
        let Ok(json) = serde_json::to_string(&event) else {
            continue;
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }

    // Replay each room's latest `room_details:update` too — see
    // `Session::room_details_snapshots`'s doc comment. The frontend's
    // `useRoomDetails` expects this push to keep its cache current rather
    // than polling, so without this a disconnect/reconnect gap during a
    // room-name/power-level/membership change would leave the details
    // panel and member list stale.
    let room_details_snapshots: Vec<_> = session
        .room_details_snapshots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    for event in room_details_snapshots {
        let Ok(json) = serde_json::to_string(&event) else {
            continue;
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }

    // Replay each room's accumulated read-receipt state too — see
    // `Session::receipt_snapshots`'s doc comment. Unlike the two replays
    // above, `receipts:update` is a delta-only stream the frontend applies
    // incrementally with no refetch path, so this sends one synthetic
    // "catch-up" update per room carrying every receipt currently known,
    // rather than trying to replay the individual deltas that produced it.
    let receipt_snapshots: Vec<_> = session
        .receipt_snapshots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(_, receipts)| !receipts.is_empty())
        .map(|(room_id, receipts)| {
            crate::events::ServerEvent::Receipts(charm_lib::matrix::ephemeral::ReceiptUpdate {
                room_id: room_id.to_string(),
                receipts: receipts.clone(),
            })
        })
        .collect();
    for event in receipt_snapshots {
        let Ok(json) = serde_json::to_string(&event) else {
            continue;
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }

    // Replay each room's latest `typing:update` too — see
    // `Session::typing_snapshots`'s doc comment. Unlike receipts, `m.typing`
    // is always a full replace, so (like room details) this is a plain
    // overwrite-in-place replay, not an accumulation.
    let typing_snapshots: Vec<_> = session
        .typing_snapshots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    for event in typing_snapshots {
        let Ok(json) = serde_json::to_string(&event) else {
            continue;
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }

    // Replay the signed-in user's latest `profile:self` update too — see
    // `Session::profile_snapshot`'s doc comment.
    let profile_snapshot = session
        .profile_snapshot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(event) = profile_snapshot {
        if let Ok(json) = serde_json::to_string(&event) {
            if socket.send(Message::Text(json.into())).await.is_err() {
                return;
            }
        }
    }

    // Replay each known user's latest `presence:update` too — see
    // `Session::presence_snapshots`'s doc comment.
    let presence_snapshots: Vec<_> = session
        .presence_snapshots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    for event in presence_snapshots {
        let Ok(json) = serde_json::to_string(&event) else {
            continue;
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }

    let mut keepalive = tokio::time::interval(WS_KEEPALIVE_INTERVAL);
    // The first `tick()` fires immediately, not after the first interval —
    // skip it so this doesn't send a redundant ping the instant a client
    // connects, on top of whatever event traffic is already flowing.
    keepalive.tick().await;
    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            event = receiver.recv() => {
                match event {
                    Ok(event) => {
                        let Ok(json) = serde_json::to_string(&event) else { continue };
                        if socket.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    // A slow consumer fell more than `EVENT_CHANNEL_CAPACITY`
                    // events behind and the broadcast channel dropped the
                    // gap. Skipping ahead (an earlier version of this did
                    // exactly that) is only safe for events a later one
                    // fully supersedes — true for `room_list:update`/
                    // `badge:update`/`timeline:update`, but not for
                    // `verification:request`, a `verification:sas_update`
                    // mid-flow, or the terminal `upload:progress` tick: none
                    // of those are replayed or reissued by anything later,
                    // so silently skipping past one leaves the frontend
                    // permanently unaware a verification flow exists, or an
                    // upload's progress bar stuck mid-way forever. There's
                    // no way to tell from here which kind(s) of event were
                    // actually dropped, so the only correct move is to close
                    // the connection and force the client to reconnect and
                    // reload current state from scratch, rather than risk
                    // silently losing a not-safely-droppable event.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(
                            "WebSocket client lagged {skipped} events behind; closing so it reconnects"
                        );
                        let _ = socket
                            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                                code: axum::extract::ws::close_code::AGAIN,
                                reason: "lagged behind; reconnect".into(),
                            })))
                            .await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                // This channel is server-push only — no client message
                // carries any meaning to this handler — except a `Ping`,
                // which axum surfaces here rather than answering
                // automatically; skipping it would let proxies/clients that
                // rely on a timely `Pong` decide the connection is dead and
                // close it out from under us.
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
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
    kind: Option<&'static str>,
}

impl ApiError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
            kind: None,
        }
    }
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
            kind: None,
        }
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
            kind: None,
        }
    }
    fn uia_challenge() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: "UIA challenge required".to_owned(),
            kind: Some("UiaChallenge"),
        }
    }
    fn uia_other(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
            kind: Some("Other"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let body = match self.kind {
            Some("Other") => serde_json::json!({ "kind": "Other", "message": self.message }),
            Some(kind) => serde_json::json!({ "kind": kind, "error": self.message }),
            None => serde_json::json!({ "error": self.message }),
        };
        (self.status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod range_tests {
    use super::parse_byte_range;

    #[test]
    fn a_plain_range_returns_the_requested_inclusive_bounds() {
        assert_eq!(parse_byte_range("bytes=0-499", 1000), Some((0, 499)));
        assert_eq!(parse_byte_range("bytes=500-999", 1000), Some((500, 999)));
    }

    #[test]
    fn an_open_ended_range_extends_to_the_end_of_the_file() {
        assert_eq!(parse_byte_range("bytes=900-", 1000), Some((900, 999)));
    }

    #[test]
    fn a_suffix_range_returns_the_last_n_bytes() {
        assert_eq!(parse_byte_range("bytes=-500", 1000), Some((500, 999)));
    }

    #[test]
    fn an_end_past_the_file_length_is_clamped() {
        assert_eq!(parse_byte_range("bytes=0-9999", 1000), Some((0, 999)));
    }

    #[test]
    fn a_start_at_or_past_the_file_length_is_rejected() {
        assert_eq!(parse_byte_range("bytes=1000-", 1000), None);
    }

    #[test]
    fn a_multi_range_request_is_rejected() {
        assert_eq!(parse_byte_range("bytes=0-10,20-30", 1000), None);
    }

    #[test]
    fn a_malformed_header_is_rejected() {
        assert_eq!(parse_byte_range("not a range", 1000), None);
        assert_eq!(parse_byte_range("bytes=abc-def", 1000), None);
    }
}

#[cfg(test)]
mod referer_origin_tests {
    use super::origin_from_referer;

    #[test]
    fn strips_the_path_query_and_fragment() {
        assert_eq!(
            origin_from_referer("https://app.example.com/rooms/!abc:example.com?x=1#y"),
            Some("https://app.example.com".to_string())
        );
    }

    #[test]
    fn preserves_a_non_default_port() {
        assert_eq!(
            origin_from_referer("http://localhost:5173/"),
            Some("http://localhost:5173".to_string())
        );
    }

    #[test]
    fn a_bare_origin_with_no_trailing_path_round_trips() {
        assert_eq!(
            origin_from_referer("https://app.example.com"),
            Some("https://app.example.com".to_string())
        );
    }

    #[test]
    fn a_malformed_value_is_rejected() {
        assert_eq!(origin_from_referer("not a url"), None);
    }
}

#[cfg(test)]
mod origin_allowlist_tests {
    use super::origin_matches_allowed_entry;

    #[test]
    fn exact_origin_entries_match_only_the_same_origin() {
        assert!(origin_matches_allowed_entry(
            "https://charm.example.test",
            "https://charm.example.test"
        ));
        assert!(!origin_matches_allowed_entry(
            "https://charm.example.test",
            "https://other.example.test"
        ));
    }

    #[test]
    fn constrained_wildcard_entries_match_dynamic_preview_origins() {
        assert!(origin_matches_allowed_entry(
            "https://pr-*-charm-preview.example.workers.dev",
            "https://pr-112-charm-preview.example.workers.dev"
        ));
        assert!(!origin_matches_allowed_entry(
            "https://pr-*-charm-preview.example.workers.dev",
            "https://manual-main-charm-preview.example.workers.dev"
        ));
        assert!(!origin_matches_allowed_entry(
            "https://pr-*-charm-preview.example.workers.dev",
            "https://pr-112-other-preview.example.workers.dev"
        ));
    }

    #[test]
    fn broad_or_ambiguous_wildcard_entries_do_not_match() {
        assert!(!origin_matches_allowed_entry(
            "*.workers.dev",
            "https://anything.workers.dev"
        ));
        assert!(!origin_matches_allowed_entry(
            "https://*.workers.dev",
            "https://preview.workers.dev"
        ));
        assert!(!origin_matches_allowed_entry(
            "https://pr-**-preview.example.workers.dev",
            "https://pr-112-preview.example.workers.dev"
        ));
    }
}

#[cfg(test)]
mod web_transport_header_tests {
    use axum::http::{HeaderMap, HeaderValue, StatusCode};

    use super::require_web_transport_header;

    #[test]
    fn rejects_requests_without_the_non_simple_transport_header() {
        let error = require_web_transport_header(&HeaderMap::new()).unwrap_err();

        assert_eq!(error.status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn accepts_requests_with_the_non_simple_transport_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-charm-operation-id",
            HeaderValue::from_static("ipc-test-1"),
        );

        assert!(require_web_transport_header(&headers).is_ok());
    }
}

#[cfg(test)]
mod redact_request_uri_for_sentry_tests {
    use tower::ServiceExt;

    use super::redacted_route_uri;
    use crate::AppState;

    #[test]
    fn a_matched_route_template_has_no_room_or_event_id_left() {
        let uri = redacted_route_uri(Some("/api/rooms/{room_id}/events/{event_id}/edit"));

        assert_eq!(uri.path(), "/api/rooms/{room_id}/events/{event_id}/edit");
        assert_eq!(uri.query(), None);
    }

    #[test]
    fn no_matched_path_falls_back_to_the_same_unmatched_placeholder_as_metrics() {
        assert_eq!(redacted_route_uri(None).path(), "/unmatched");
    }

    /// Regression test for the actual review finding: a request whose real
    /// path/query carries percent-encoded Matrix identifiers (the shape
    /// `matrixTransport.ts`'s `encodeSegment`/`query` helpers produce) must
    /// never reach a route handler with those identifiers still attached to
    /// `request.uri()` — this is what `SentryHttpLayer` would otherwise
    /// read into the transaction's `request.url`.
    #[tokio::test]
    async fn a_real_request_with_encoded_matrix_ids_is_rewritten_to_the_route_template() {
        let app = super::router(AppState::default());

        // `/api/rooms/{room_id}` (get_room_details) requires a session, so
        // this 401s before reaching the handler body — but `Path<String>`
        // extraction (and thus route *matching*) happens before session
        // resolution, so a 401 here (rather than some other rejection)
        // already proves the request was successfully routed and matched
        // despite this middleware's URI rewrite happening first.
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method("GET")
                    .uri("/api/rooms/!secretroom%3Aexample.org")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
    }
}

#[cfg(test)]
mod cors_preflight_tests {
    use tower::ServiceExt;

    use super::ALLOWED_ORIGIN_ENV;
    use crate::AppState;

    const TEST_ALLOWED_ORIGIN: &str = "https://charm.example.test";

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
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    /// Regression test: a Sentry-enabled cross-origin web client attaches
    /// `sentry-trace`/`baggage` on every fetch matched by
    /// `instrument.ts`'s `tracePropagationTargets` (see that file's
    /// `apiBase`-origin handling), which forces a browser CORS preflight for
    /// those non-safelisted headers. If `cors_layer` doesn't explicitly
    /// allow them, the preflight fails and the browser blocks the actual
    /// request before it ever reaches `SentryHttpLayer` — silently breaking
    /// every cross-origin API call from such a client, trace or no trace.
    #[tokio::test]
    async fn preflight_allows_sentry_trace_and_baggage_headers() {
        let _lock = crate::ENV_TEST_LOCK.lock().await;
        let _allowed_origin = EnvVarGuard::set(ALLOWED_ORIGIN_ENV, TEST_ALLOWED_ORIGIN);

        let app = super::router(AppState::default());

        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method("OPTIONS")
                    .uri("/api/rooms")
                    .header("origin", TEST_ALLOWED_ORIGIN)
                    .header("access-control-request-method", "GET")
                    .header(
                        "access-control-request-headers",
                        "sentry-trace,baggage,content-type",
                    )
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        let allow_headers = response
            .headers()
            .get("access-control-allow-headers")
            .expect("preflight response must list allowed headers")
            .to_str()
            .unwrap()
            .to_ascii_lowercase();

        assert!(
            allow_headers.contains("sentry-trace"),
            "expected sentry-trace in Access-Control-Allow-Headers, got: {allow_headers}"
        );
        assert!(
            allow_headers.contains("baggage"),
            "expected baggage in Access-Control-Allow-Headers, got: {allow_headers}"
        );
    }
}
