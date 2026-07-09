//! Cross-platform remote-push transport (Spec 11): a pluggable
//! [`NotificationTransport`] with an Android (UnifiedPush) and an iOS (APNs)
//! implementation, homeserver pusher registration via matrix-sdk's
//! `client.pusher()`, and the push-triggered background decrypt pipeline that
//! turns an `event_id_only` push into a real notification built from the
//! *decrypted* event — the capability the matrix-js-sdk-based Charm 1.0
//! couldn't offer in a background/killed state (see this spec's "Problem &
//! why now").
//!
//! Desktop has no transport (`active_transport` returns `None` there): it
//! relies on the always-on sync loop + local notifications from Spec 10
//! instead (this spec's "Non-goals").

#[cfg(target_os = "android")]
pub mod android;
#[cfg(target_os = "ios")]
pub mod ios;

use std::sync::Arc;

use matrix_sdk::ruma::api::client::push::{Pusher, PusherIds, PusherInit};
use matrix_sdk::ruma::events::room::message::MessageType;
use matrix_sdk::ruma::events::{
    AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
};
use matrix_sdk::ruma::push::{HttpPusherData, PushFormat};
use matrix_sdk::ruma::RoomId;
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use ts_rs::TS;

use crate::matrix::auth;
use crate::matrix::persistence;
use crate::matrix::shell;
use crate::matrix::MatrixState;

/// The push-gateway `/_matrix/push/v1/notify` endpoint every platform
/// registers its pusher against. A Sygnal gateway already exists for Charm
/// (see this spec's "Risks & open questions") — parameterized here as a
/// single constant so swapping it (e.g. for a self-hosted gateway later) is a
/// one-line change, not a hunt across every registration call site.
pub const PUSH_GATEWAY_URL: &str = "https://sygnal.cloudhub.social/_matrix/push/v1/notify";

/// Reverse-DNS app ids Sygnal is configured to route — one per transport
/// path (see this spec's context: the UnifiedPush external-distributor path
/// and the embedded-FCM fallback are registered as distinct pushers so
/// Sygnal can pick the right delivery mechanism for each).
pub const ANDROID_UNIFIED_PUSH_APP_ID: &str = "social.cloudhub.charm.android.up";
pub const ANDROID_FCM_APP_ID: &str = "social.cloudhub.charm.android";
pub const IOS_APP_ID: &str = "social.cloudhub.charm.ios";

/// Every fallible operation in this module reports failure as a plain
/// message — same convention as every other `matrix::*` module
/// (`Result<_, String>` throughout), not a dedicated error enum.
pub type PushError = String;

/// Which transport (if any) currently backs push delivery — the ts-rs IPC
/// enum the frontend uses to render transport-specific settings UI (e.g. the
/// Android distributor picker).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum PusherKind {
    UnifiedPush,
    Fcm,
    Apns,
    #[default]
    None,
}

/// What a [`NotificationTransport::register`] call hands back: enough to
/// build the `set_pusher` request (`pushkey` + `app_id` + which gateway data
/// kind to use), with no `Client` or transport-specific type leaking into
/// `handle_push`'s pusher-registration path.
#[derive(Debug, Clone)]
pub struct PushEndpoint {
    /// The transport-issued pushkey: a UnifiedPush endpoint URL, an FCM
    /// registration token, or an APNs device token (hex-encoded).
    pub url_or_token: String,
    pub app_id: String,
    pub kind: PusherKind,
}

/// A normalized incoming push, after each transport strips its own
/// envelope — an `event_id_only` gateway payload's `notification` object, at
/// minimum a room + event id to fetch and decrypt.
#[derive(Debug, Clone)]
pub struct PushMessage {
    pub room_id: String,
    pub event_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PushNotification {
    pub event_id: String,
    pub title: String,
    pub body: String,
}

/// A pluggable push transport: obtain an endpoint/token from the platform's
/// push mechanism, register/unregister it, and report whatever endpoint is
/// currently active. `register_push`/`unregister_push` (below) and
/// `handle_push` are the only things that touch a transport — everything
/// else in this module is transport-agnostic, so adding a third platform
/// only means a new `impl NotificationTransport` plus a branch in
/// [`active_transport`].
#[async_trait::async_trait]
pub trait NotificationTransport: Send + Sync {
    async fn register(&self) -> Result<PushEndpoint, PushError>;
    async fn unregister(&self) -> Result<(), PushError>;
    fn endpoint(&self) -> Option<PushEndpoint>;
}

/// The running app's handle, stashed once at startup ([`set_global_app_handle`])
/// so a platform push callback that arrives on a raw JNI/Obj-C thread — with
/// no Tauri command context to pull one from — can still reach
/// [`handle_push`]. Desktop never needs this (no transport calls into it).
static GLOBAL_APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// Called once from `lib.rs`'s `setup()` on mobile targets, before any push
/// could plausibly arrive.
pub fn set_global_app_handle(app: AppHandle) {
    let _ = GLOBAL_APP_HANDLE.set(app);
}

#[cfg(target_os = "android")]
pub(crate) fn global_app_handle() -> Option<AppHandle> {
    GLOBAL_APP_HANDLE.get().cloned()
}

/// Selects the platform transport by `cfg`. Returns `None` on desktop (no
/// remote-push transport there — see this module's doc comment).
///
/// Also returns `None` on iOS for now, even though `ios::ApnsTransport`
/// exists: it's currently a documented stub whose `register()` always
/// returns an error (see that module's doc comment for why — it needs real
/// Tauri mobile-plugin scaffolding this environment couldn't safely
/// produce). Advertising it as `available` would show a "Turn on push
/// notifications" button on every iOS install that can only ever fail.
/// Flip this back on once `ApnsTransport::register` actually works.
pub fn active_transport(
    #[allow(unused_variables)] app: &AppHandle,
) -> Option<Arc<dyn NotificationTransport>> {
    #[cfg(target_os = "android")]
    {
        Some(Arc::new(android::UnifiedPushTransport::new()) as Arc<dyn NotificationTransport>)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        None
    }
}

/// ts-rs mirror of one endpoint's registration state — the `register_push`/
/// `unregister_push` command return value. See [`PushStatus`] for the
/// `push:status` event payload, which additionally carries `last_error` for
/// the settings-panel diagnostics this spec's "New commands + events" calls
/// for.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct PushRegistration {
    pub transport: PusherKind,
    pub registered: bool,
    pub endpoint_present: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct PushStatus {
    pub transport: PusherKind,
    pub registered: bool,
    pub endpoint_present: bool,
    pub last_error: Option<String>,
    /// Whether *some* platform transport exists on this device at all
    /// (`active_transport(&app).is_some()`), independent of whether it's
    /// currently registered. Distinguishes "this is desktop, push will never
    /// be available" from "this is mobile, but nothing has registered yet" —
    /// before the first `register_push` call, `transport` reads `none` in
    /// both cases, and the settings panel needs to tell them apart to know
    /// whether to offer a "turn on" button at all.
    pub available: bool,
}

impl From<&PushStatus> for PushRegistration {
    fn from(status: &PushStatus) -> Self {
        Self {
            transport: status.transport,
            registered: status.registered,
            endpoint_present: status.endpoint_present,
        }
    }
}

/// Freshly recomputes `available` (never trusted from a stored/cached
/// `PushStatus` — see that field's doc comment) and emits `push:status`.
fn finalize_and_emit(app: &AppHandle, mut status: PushStatus) -> PushStatus {
    status.available = active_transport(app).is_some();
    let _ = app.emit("push:status", status.clone());
    status
}

/// On-disk record of the last endpoint successfully registered with the
/// homeserver — plain JSON (a pushkey/app_id pair isn't secret, unlike
/// `persistence`'s keychain-backed session material), one file per account,
/// mirroring `notifications.rs`'s `notification_prefs` shape. Exists so
/// `unregister_push` can still find and delete the homeserver pusher after
/// an app restart, when `MatrixState::push_transport`'s in-memory `Arc` is
/// gone (see that command's doc comment), and so `get_push_status` can
/// reconstruct `registered`/`transport` after a restart instead of reporting
/// the in-memory-only default.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedPushEndpoint {
    url_or_token: String,
    app_id: String,
    kind: PusherKind,
}

impl From<&PushEndpoint> for PersistedPushEndpoint {
    fn from(endpoint: &PushEndpoint) -> Self {
        Self {
            url_or_token: endpoint.url_or_token.clone(),
            app_id: endpoint.app_id.clone(),
            kind: endpoint.kind,
        }
    }
}

fn persisted_endpoint_path(
    app: &AppHandle,
    account_key: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("push_endpoint");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{account_key}.json")))
}

fn save_persisted_endpoint(app: &AppHandle, account_key: &str, endpoint: &PushEndpoint) {
    let Ok(path) = persisted_endpoint_path(app, account_key) else {
        return;
    };
    if let Ok(json) = serde_json::to_string(&PersistedPushEndpoint::from(endpoint)) {
        let _ = std::fs::write(path, json);
    }
}

fn load_persisted_endpoint(app: &AppHandle, account_key: &str) -> Option<PersistedPushEndpoint> {
    let path = persisted_endpoint_path(app, account_key).ok()?;
    let json = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&json).ok()
}

fn clear_persisted_endpoint(app: &AppHandle, account_key: &str) {
    if let Ok(path) = persisted_endpoint_path(app, account_key) {
        let _ = std::fs::remove_file(path);
    }
}

/// Builds the `PusherInit` every platform's registration converges on: an
/// HTTP pusher pointed at [`PUSH_GATEWAY_URL`], `event_id_only` format (see
/// this spec's acceptance criteria — the gateway payload must never carry
/// message content), keyed by whatever `endpoint` the transport obtained.
fn build_pusher_init(endpoint: &PushEndpoint, device_display_name: &str) -> PusherInit {
    let mut data = HttpPusherData::new(PUSH_GATEWAY_URL.to_string());
    data.format = Some(PushFormat::EventIdOnly);

    PusherInit {
        ids: PusherIds::new(endpoint.url_or_token.clone(), endpoint.app_id.clone()),
        kind: matrix_sdk::ruma::api::client::push::PusherKind::Http(data),
        app_display_name: "Charm".to_string(),
        device_display_name: device_display_name.to_string(),
        profile_tag: None,
        lang: "en".to_string(),
    }
}

/// Registers this device for remote push: obtains an endpoint from the
/// active platform transport (see [`active_transport`]) and registers it as
/// an HTTP pusher with the homeserver via `client.pusher().set(...)`.
/// Re-registering (e.g. after a token rotation, or simply calling this again)
/// is safe — `set_pusher` upserts by `(pushkey, app_id)`.
#[tauri::command]
pub async fn register_push(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<PushRegistration, PushError> {
    let client = state.require_client().await?;
    let account_key = client
        .user_id()
        .map(|id| persistence::account_key(id.as_str()));

    let Some(transport) = active_transport(&app) else {
        let status = finalize_and_emit(&app, PushStatus::default());
        *state.push_status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
        return Ok((&status).into());
    };

    let status = match transport.register().await {
        Ok(endpoint) => {
            let device_display_name = client
                .device_id()
                .map(|id| id.to_string())
                .unwrap_or_else(|| "Charm".to_string());
            let pusher: Pusher = build_pusher_init(&endpoint, &device_display_name).into();
            match client.pusher().set(pusher, false).await {
                Ok(()) => {
                    *state
                        .push_transport
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&transport));
                    if let Some(account_key) = &account_key {
                        save_persisted_endpoint(&app, account_key, &endpoint);
                    }
                    PushStatus {
                        transport: endpoint.kind,
                        registered: true,
                        endpoint_present: true,
                        last_error: None,
                        available: false, // set fresh by finalize_and_emit
                    }
                }
                Err(e) => {
                    // The OS/distributor already registered this endpoint —
                    // it's the homeserver call that failed, so roll the
                    // platform-level registration back too rather than
                    // leaving a stray registration the user can neither see
                    // nor clean up (there's nothing in `push_transport` for
                    // `unregister_push` to act on otherwise).
                    let _ = transport.unregister().await;
                    PushStatus {
                        transport: endpoint.kind,
                        registered: false,
                        endpoint_present: false,
                        last_error: Some(e.to_string()),
                        available: false,
                    }
                }
            }
        }
        Err(e) => PushStatus {
            transport: PusherKind::None,
            registered: false,
            endpoint_present: false,
            last_error: Some(e),
            available: false,
        },
    };

    let status = finalize_and_emit(&app, status);
    *state.push_status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
    Ok((&status).into())
}

/// Unregisters this device from remote push: tells the transport to drop its
/// endpoint/token and removes the corresponding pusher from the homeserver
/// (`pushkey`/`app_id` — a delete is a no-op if the homeserver already has no
/// matching pusher, e.g. it was never registered).
///
/// Falls back to the on-disk [`PersistedPushEndpoint`] when
/// `state.push_transport` is empty (e.g. this is a fresh process since the
/// last `register_push`, so the in-memory `Arc` from that call is gone) —
/// without this, turning push off after an app restart would silently do
/// nothing and leave both the homeserver pusher and the platform
/// registration active. Every step here is best-effort: a homeserver/network
/// failure must not block the user from turning push off locally, since
/// that's often exactly when they'd want to (see PR review).
///
/// Thin wrapper over [`unregister_push_impl`], which `matrix::account`'s
/// logout/deactivate cleanup also calls directly (before its own client goes
/// away) rather than duplicating this logic.
#[tauri::command]
pub async fn unregister_push(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<(), PushError> {
    unregister_push_impl(&app, &state).await
}

pub(crate) async fn unregister_push_impl(
    app: &AppHandle,
    state: &MatrixState,
) -> Result<(), PushError> {
    let client = state.require_client().await?;
    let account_key = client
        .user_id()
        .map(|id| persistence::account_key(id.as_str()));

    let existing_transport = state
        .push_transport
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    let endpoint_ids = existing_transport
        .as_ref()
        .and_then(|t| t.endpoint())
        .map(|e| PusherIds::new(e.url_or_token, e.app_id))
        .or_else(|| {
            account_key
                .as_ref()
                .and_then(|key| load_persisted_endpoint(app, key))
                .map(|e| PusherIds::new(e.url_or_token, e.app_id))
        });

    if let Some(ids) = endpoint_ids {
        if let Err(e) = client.pusher().delete(ids).await {
            eprintln!("failed to delete homeserver pusher during unregister_push: {e}");
        }
    }

    let transport = existing_transport.or_else(|| active_transport(app));
    if let Some(transport) = transport {
        let _ = transport.unregister().await;
    }

    if let Some(account_key) = &account_key {
        clear_persisted_endpoint(app, account_key);
    }

    *state
        .push_transport
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    let status = finalize_and_emit(app, PushStatus::default());
    *state.push_status.lock().unwrap_or_else(|e| e.into_inner()) = status;
    Ok(())
}

/// Re-registers `endpoint` with the homeserver directly, bypassing
/// `NotificationTransport::register()` — used when a transport hands over a
/// *new* endpoint unprompted (e.g. `push::android`'s JNI bridge observing a
/// UnifiedPush/FCM token rotation with no `register_push` call waiting on
/// it), rather than in response to a user action. Best-effort: there's no
/// command invocation here for a caller to propagate an error back to, so
/// failures are just logged.
#[cfg(target_os = "android")]
pub(crate) async fn reregister_endpoint(app: &AppHandle, endpoint: PushEndpoint) {
    let state = app.state::<MatrixState>();
    let client = match state.require_client().await {
        Ok(client) => client,
        Err(e) => {
            eprintln!("cannot re-register rotated push endpoint, not logged in: {e}");
            return;
        }
    };

    let Some(account_key) = client
        .user_id()
        .map(|id| persistence::account_key(id.as_str()))
    else {
        return;
    };

    // A real rotation only ever follows a *previously successful*
    // registration — if there's no persisted endpoint for this account yet,
    // this is instead a late `onNewEndpoint` for an attempt that was already
    // reported to the user as timed-out/failed (see `android::register`'s
    // timeout path, which clears `PENDING_REGISTRATION` and gives up before
    // the distributor necessarily has). Silently registering with the
    // homeserver here would turn push back on behind the user's back after
    // they already saw a failure and may have moved on. Ignore it instead.
    let Some(previous) = load_persisted_endpoint(app, &account_key) else {
        eprintln!(
            "ignoring an unprompted push endpoint with no prior registration for this account \
             (likely a late callback for an already-timed-out attempt)"
        );
        return;
    };

    let device_display_name = client
        .device_id()
        .map(|id| id.to_string())
        .unwrap_or_else(|| "Charm".to_string());
    let pusher: Pusher = build_pusher_init(&endpoint, &device_display_name).into();

    let status = match client.pusher().set(pusher, false).await {
        Ok(()) => {
            save_persisted_endpoint(app, &account_key, &endpoint);
            // Matrix pushers are keyed by (pushkey, app_id) — `set_pusher`
            // above upserts the *new* one but never removes whatever the
            // stale pushkey was registered under, so without this the
            // homeserver keeps a dead pusher (and can keep sending to it)
            // for as long as the account exists.
            if previous.url_or_token != endpoint.url_or_token || previous.app_id != endpoint.app_id
            {
                let ids = PusherIds::new(previous.url_or_token, previous.app_id);
                if let Err(e) = client.pusher().delete(ids).await {
                    eprintln!("failed to delete the stale pusher after endpoint rotation: {e}");
                }
            }
            PushStatus {
                transport: endpoint.kind,
                registered: true,
                endpoint_present: true,
                last_error: None,
                available: false,
            }
        }
        Err(e) => {
            eprintln!("failed to re-register rotated push endpoint: {e}");
            PushStatus {
                transport: endpoint.kind,
                registered: false,
                endpoint_present: true,
                last_error: Some(e.to_string()),
                available: false,
            }
        }
    };

    let status = finalize_and_emit(app, status);
    *state.push_status.lock().unwrap_or_else(|e| e.into_inner()) = status;
}

/// Called when the platform transport reports this app was unregistered by
/// the distributor itself, out-of-band from anything `unregister_push`
/// triggered (e.g. the user removed the UnifiedPush distributor app, or
/// picked a different one in its own UI) — per
/// `org.unifiedpush.android.connector.MessagingReceiver.onUnregistered`'s own
/// contract, this means the registration will no longer receive pushes and
/// should be removed from the application server. Without this, the
/// homeserver pusher and the on-disk persisted endpoint both go stale: the
/// settings panel keeps reporting "registered" and the homeserver keeps
/// (uselessly) sending to a dead endpoint.
#[cfg(target_os = "android")]
pub(crate) async fn handle_transport_unregistered(app: &AppHandle) {
    let state = app.state::<MatrixState>();
    let Ok(client) = state.require_client().await else {
        return;
    };
    let Some(account_key) = client
        .user_id()
        .map(|id| persistence::account_key(id.as_str()))
    else {
        return;
    };

    if let Some(persisted) = load_persisted_endpoint(app, &account_key) {
        let ids = PusherIds::new(persisted.url_or_token, persisted.app_id);
        if let Err(e) = client.pusher().delete(ids).await {
            eprintln!("failed to delete homeserver pusher after distributor unregister: {e}");
        }
    }
    clear_persisted_endpoint(app, &account_key);

    *state
        .push_transport
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    let status = finalize_and_emit(app, PushStatus::default());
    *state.push_status.lock().unwrap_or_else(|e| e.into_inner()) = status;
}

/// Current push registration state, for the settings panel to read on mount
/// without waiting for a `push:status` event. `available` is always
/// recomputed fresh (see its doc comment), never read from the cached
/// `last_error`/`registered`/etc. snapshot.
///
/// `state.push_status` only reflects what *this process* has done since it
/// started — after a restart it's back to `PushStatus::default()` even
/// though the homeserver still has a pusher on file (see
/// `PersistedPushEndpoint`'s doc comment). When the in-memory status shows
/// unregistered, this falls back to the on-disk record so the panel shows
/// "turn off" (and `unregister_push` stays reachable) instead of wrongly
/// offering "turn on" for a device that's already registered.
#[tauri::command]
pub async fn get_push_status(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<PushStatus, PushError> {
    let mut status = state
        .push_status
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    if !status.registered {
        if let Some(client) = state.client.lock().await.clone() {
            let account_key = client
                .user_id()
                .map(|id| persistence::account_key(id.as_str()));
            if let Some(persisted) = account_key.and_then(|key| load_persisted_endpoint(&app, &key))
            {
                status = PushStatus {
                    transport: persisted.kind,
                    registered: true,
                    endpoint_present: true,
                    last_error: None,
                    available: false, // set fresh below
                };
            }
        }
    }

    status.available = active_transport(&app).is_some();
    Ok(status)
}

/// A short, non-reversible correlation id for `room_id` safe to send to
/// Sentry — a full Matrix room id embeds the homeserver's server name and,
/// combined with other breadcrumbs, can be identifying; this still lets
/// repeated UTD failures in the *same* room be correlated in Sentry without
/// exposing which room that is.
fn hash_room_id(room_id: &RoomId) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(room_id.as_str().as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Extracts a plaintext `(sender, body)` preview from a (possibly decrypted)
/// timeline event, if it's a non-redacted `m.room.message`. Anything else —
/// a still-encrypted (UTD) event, a state event, a redaction — yields `None`
/// so the caller falls back to a generic body rather than fabricating a
/// preview for content that was never a plain message.
fn message_preview(
    raw: &matrix_sdk::ruma::serde::Raw<AnySyncTimelineEvent>,
) -> Option<(String, String)> {
    let event = raw.deserialize().ok()?;
    let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
        SyncMessageLikeEvent::Original(original),
    )) = event
    else {
        return None;
    };
    if matches!(
        original.content.msgtype,
        MessageType::VerificationRequest(_)
    ) {
        return None;
    }
    Some((
        original.sender.to_string(),
        original.content.body().to_string(),
    ))
}

/// The push-triggered background decrypt pipeline (this spec's core
/// differentiator): fetches the event a push referenced, decrypts it against
/// the existing SQLCipher/megolm store (working even with the app fully
/// killed — the capability the matrix-js-sdk-based Charm 1.0 lacked),
/// evaluates `m.push_rules` to decide notify/highlight/mute, and fires a
/// notification built from the plaintext via the exact same
/// [`shell::build_notification`] shaping Spec 10's local notifications use.
///
/// Never surfaces ciphertext: a decryption failure (missing megolm key, most
/// commonly) falls back to a generic body and is logged, rather than either
/// showing raw content or silently dropping the notification outright.
///
/// Reuses the app's already-running `Client` (`MatrixState::client`) when one
/// exists rather than always building a fresh one via `restore_any_client`:
/// matrix-sdk-sqlite opens its SQLCipher store in WAL mode, which allows
/// multiple reader connections but still serializes writers, so a second
/// `Client` for the same account competing with the live sync loop's writes
/// (received-key storage, sync-token updates, etc.) risks `SQLITE_BUSY`/lock
/// contention for no benefit — the running client already has everything
/// this needs. `restore_any_client` (a fresh headless client, no sync loop)
/// remains the fallback for the actual "app was killed" case this spec
/// exists for, where nothing is running yet.
pub async fn handle_push(app: &AppHandle, message: PushMessage) -> Result<(), PushError> {
    let running_client = app.state::<MatrixState>().client.lock().await.clone();
    // Held for the rest of this function whenever `restore_any_client` had
    // to build a fresh headless client: that client's use below (fetching
    // and decrypting a room event, both store-backed) is exactly the same
    // open-handle hazard an interactive login's relocation needs protection
    // from — see `restore_session_for_push`'s doc comment for why the lock
    // has to span *use*, not just the build. Not needed for the
    // `running_client` fast path — that's the already-adopted client, whose
    // ongoing use by commands generally is a separate, broader concern (see
    // the PR discussion on quiescing in-flight command clients).
    let matrix_state = app.state::<MatrixState>();
    let (client, _completion_guard) = match running_client {
        Some(client) => (client, None),
        None => {
            let guard = matrix_state.login_completion_lock.lock().await;
            let client = restore_any_client(app)
                .await?
                .ok_or_else(|| "no restorable session to handle this push against".to_string())?;
            (client, Some(guard))
        }
    };

    let Some(notification) = build_push_notification(
        &client,
        message,
        |room_id| {
            let focused_room_id = app
                .state::<MatrixState>()
                .focused_room_id
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            focused_room_id.as_deref() == Some(room_id.as_str())
        },
        |event_id| app.state::<MatrixState>().mark_notified(event_id),
    )
    .await?
    else {
        return Ok(());
    };

    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(notification.title)
        .body(notification.body)
        .show();

    Ok(())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) async fn handle_headless_push(
    store_root: &std::path::Path,
    message: PushMessage,
) -> Result<Option<PushNotification>, PushError> {
    let client = restore_any_client_at(store_root)
        .await?
        .ok_or_else(|| "no restorable session to handle this push against".to_string())?;

    build_push_notification(&client, message, |_| false, |_| true).await
}

async fn build_push_notification(
    client: &Client,
    message: PushMessage,
    should_suppress_for_room: impl FnOnce(&RoomId) -> bool,
    mark_notified: impl FnOnce(&str) -> bool,
) -> Result<Option<PushNotification>, PushError> {
    let room_id = RoomId::parse(&message.room_id).map_err(|e| e.to_string())?;
    let event_id =
        matrix_sdk::ruma::EventId::parse(&message.event_id).map_err(|e| e.to_string())?;

    let Some(room) = client.get_room(&room_id) else {
        return Err(format!("room {room_id} not found in local store"));
    };

    let mode = room.notification_mode().await;
    if matches!(
        mode,
        Some(matrix_sdk::notification_settings::RoomNotificationMode::Mute)
    ) {
        return Ok(None);
    }

    // No further notify/suppress re-derivation here beyond the mute check
    // above (a client-side safety net against a stale/racy local push-rules
    // cache): the homeserver only sent this push because one of its own
    // `m.push_rules` already matched and decided to notify — including
    // keyword rules, which don't populate `m.mentions` and so can't be
    // independently re-verified client-side. An earlier version of this
    // function re-checked `m.mentions` for a `MentionsAndKeywordsOnly` room
    // and suppressed anything that wasn't a direct mention, which silently
    // dropped every keyword-triggered push — trusting the server's decision
    // instead of re-deriving it fixes that.
    let timeline_event = room
        .event(&event_id, None)
        .await
        .map_err(|e| e.to_string())?;

    // Dedup *after* the fetch succeeds, not before: marking earlier (an
    // earlier version of this function did, right after the mute check)
    // would burn this event's dedup slot even on a transient fetch failure
    // (`?` above returns before we ever got anything to react to), wrongly
    // suppressing a later retry or the normal sync-path notification for an
    // event that was never actually shown. Still unconditional otherwise — a
    // UTD/generic-fallback notification needs the same guard a successfully
    // decrypted one gets.
    if !mark_notified(&message.event_id) {
        return Ok(None);
    }

    let is_utd = timeline_event.kind.is_utd();
    let own_user_id = client.user_id().map(|id| id.as_str().to_string());

    let (sender, body) = match message_preview(timeline_event.kind.raw()) {
        Some((sender, body)) => {
            if own_user_id.as_deref() == Some(sender.as_str()) {
                return Ok(None);
            }
            (sender, body)
        }
        None => {
            if is_utd {
                let room_hash = hash_room_id(&room_id);
                tracing::warn!(
                    pipeline = "push_decrypt",
                    status = "utd",
                    room_hash,
                    "Push decrypt failed"
                );
                sentry::capture_message(
                    &format!(
                        "push decrypt failed: unable to decrypt event in room {}",
                        room_hash
                    ),
                    sentry::Level::Warning,
                );
            }
            // Never leak ciphertext (acceptance criterion #4): a UTD or any
            // non-message event falls back to a generic body rather than
            // formatting whatever raw content was fetched.
            (String::new(), "New message".to_string())
        }
    };

    let sender_display_name = if sender.is_empty() {
        None
    } else {
        match matrix_sdk::ruma::UserId::parse(&sender) {
            Ok(user_id) => room
                .get_member(&user_id)
                .await
                .ok()
                .flatten()
                .and_then(|member| member.display_name().map(|name| name.to_string())),
            Err(_) => None,
        }
    };

    let display_name = match room.cached_display_name() {
        Some(name) => name,
        None => room
            .display_name()
            .await
            .unwrap_or(matrix_sdk::RoomDisplayName::Empty),
    };
    let room_name = match display_name {
        matrix_sdk::RoomDisplayName::Empty => None,
        other => Some(other.to_string()),
    };

    let sender_label = if sender.is_empty() { "Charm" } else { &sender };
    let (title, notif_body) = shell::build_notification(
        room_name.as_deref(),
        sender_display_name.as_deref(),
        sender_label,
        &body,
    );

    // Suppress only for whichever room the user is already looking at right
    // now — the same signal `shell::should_notify` uses for Spec 10's local
    // notifications (a push can still arrive while the app is foregrounded).
    // Read this at the final decision point so a user who opens the room
    // while fetch/decrypt/display-name work is pending does not still get
    // notified for the now-focused room.
    if should_suppress_for_room(&room_id) {
        return Ok(None);
    }

    Ok(Some(PushNotification {
        event_id: message.event_id,
        title,
        body: notif_body,
    }))
}

/// Tries every known account's saved session (headlessly — no `MatrixState`
/// mutation, no sync loop spawned) and returns the first that restores.
/// Single-account for now, same "first match wins" rationale as
/// `auth::try_restore_session`; a push always targets whichever account is
/// currently signed in on this device.
async fn restore_any_client(app: &AppHandle) -> Result<Option<Client>, PushError> {
    for account_key in persistence::known_account_keys(app)? {
        if let Some(client) = auth::restore_session_for_push(app, &account_key).await? {
            return Ok(Some(client));
        }
    }
    Ok(None)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn restore_any_client_at(store_root: &std::path::Path) -> Result<Option<Client>, PushError> {
    for account_key in persistence::known_account_keys_at(store_root)? {
        if let Some(client) = auth::restore_session_for_push_at(store_root, &account_key).await? {
            return Ok(Some(client));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(kind: PusherKind) -> PushEndpoint {
        PushEndpoint {
            url_or_token: "https://up.example.org/endpoint".to_string(),
            app_id: "social.cloudhub.charm.android.up".to_string(),
            kind,
        }
    }

    #[test]
    fn build_pusher_init_uses_event_id_only_format() {
        let init = build_pusher_init(&endpoint(PusherKind::UnifiedPush), "Pixel 9");
        let matrix_sdk::ruma::api::client::push::PusherKind::Http(data) = &init.kind else {
            panic!("expected an Http pusher kind");
        };
        assert_eq!(data.url, PUSH_GATEWAY_URL);
        assert_eq!(
            data.format,
            Some(matrix_sdk::ruma::push::PushFormat::EventIdOnly)
        );
        assert_eq!(init.ids.app_id, "social.cloudhub.charm.android.up");
        assert_eq!(init.device_display_name, "Pixel 9");
    }

    #[test]
    fn message_preview_extracts_sender_and_body_from_a_text_message() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::ALICE;

        let raw = EventFactory::new()
            .room(matrix_sdk::ruma::room_id!("!test:example.org"))
            .text_msg("see you at 6")
            .sender(&ALICE)
            .event_id(matrix_sdk::ruma::event_id!("$text"))
            .into_raw_sync();

        let (sender, body) = message_preview(&raw).expect("a text message has a preview");
        assert_eq!(sender, ALICE.to_string());
        assert_eq!(body, "see you at 6");
    }

    #[tokio::test]
    async fn headless_client_construction_uses_explicit_store_root() {
        let root =
            std::env::temp_dir().join(format!("charm-headless-push-store-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let store_key = "headless-client-construction";
        let store_path = persistence::store_path_at(&root, store_key).unwrap();

        let client = auth::build_persisted_client_with_store_passphrase(
            "https://example.invalid",
            &store_path,
            "headless-push-test-passphrase",
        )
        .await
        .expect("client builds directly against the explicit SQLCipher store path");

        assert_eq!(client.homeserver().as_str(), "https://example.invalid/");
        assert!(store_path.is_dir());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn message_preview_is_none_for_a_non_message_event() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::ALICE;

        let raw = EventFactory::new()
            .room(matrix_sdk::ruma::room_id!("!test:example.org"))
            .member(&ALICE)
            .event_id(matrix_sdk::ruma::event_id!("$member"))
            .into_raw_sync();

        assert!(message_preview(&raw).is_none());
    }

    #[test]
    fn push_registration_mirrors_status_fields() {
        let status = PushStatus {
            transport: PusherKind::Apns,
            registered: true,
            endpoint_present: true,
            last_error: Some("ignored".to_string()),
            available: true,
        };
        let registration: PushRegistration = (&status).into();
        assert_eq!(registration.transport, PusherKind::Apns);
        assert!(registration.registered);
        assert!(registration.endpoint_present);
    }
}
