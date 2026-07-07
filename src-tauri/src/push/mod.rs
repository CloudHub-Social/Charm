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
/// remote-push transport there — see this module's doc comment) and, for
/// now, on any mobile target without a concrete impl yet. Takes `app` only
/// because the iOS impl needs it to reach its registered plugin handle
/// (Android's JNI bridge instead reaches the JVM via the global
/// `ndk_context` handle, so it ignores this).
pub fn active_transport(
    #[allow(unused_variables)] app: &AppHandle,
) -> Option<Arc<dyn NotificationTransport>> {
    #[cfg(target_os = "android")]
    {
        Some(Arc::new(android::UnifiedPushTransport::new()) as Arc<dyn NotificationTransport>)
    }
    #[cfg(target_os = "ios")]
    {
        Some(Arc::new(ios::ApnsTransport::new(app.clone())) as Arc<dyn NotificationTransport>)
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
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
}

impl PushStatus {
    fn none() -> Self {
        Self::default()
    }
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

fn emit_push_status(app: &AppHandle, status: &PushStatus) {
    let _ = app.emit("push:status", status.clone());
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

    let Some(transport) = active_transport(&app) else {
        let status = PushStatus::none();
        emit_push_status(&app, &status);
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
                    PushStatus {
                        transport: endpoint.kind,
                        registered: true,
                        endpoint_present: true,
                        last_error: None,
                    }
                }
                Err(e) => PushStatus {
                    transport: endpoint.kind,
                    registered: false,
                    endpoint_present: true,
                    last_error: Some(e.to_string()),
                },
            }
        }
        Err(e) => PushStatus {
            transport: PusherKind::None,
            registered: false,
            endpoint_present: false,
            last_error: Some(e),
        },
    };

    *state.push_status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
    emit_push_status(&app, &status);
    Ok((&status).into())
}

/// Unregisters this device from remote push: tells the transport to drop its
/// endpoint/token and removes the corresponding pusher from the homeserver
/// (`pushkey`/`app_id` — a delete is a no-op if the homeserver already has no
/// matching pusher, e.g. it was never registered).
#[tauri::command]
pub async fn unregister_push(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<(), PushError> {
    let client = state.require_client().await?;

    let existing_endpoint = state
        .push_transport
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    if let Some(transport) = existing_endpoint.clone() {
        if let Some(endpoint) = transport.endpoint() {
            let ids = PusherIds::new(endpoint.url_or_token, endpoint.app_id);
            client
                .pusher()
                .delete(ids)
                .await
                .map_err(|e| e.to_string())?;
        }
        transport.unregister().await?;
    }

    *state
        .push_transport
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    let status = PushStatus::none();
    *state.push_status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
    emit_push_status(&app, &status);
    Ok(())
}

/// Current push registration state, for the settings panel to read on mount
/// without waiting for a `push:status` event.
#[tauri::command]
pub fn get_push_status(state: State<'_, MatrixState>) -> PushStatus {
    state
        .push_status
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
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
pub async fn handle_push(app: &AppHandle, message: PushMessage) -> Result<(), PushError> {
    let Some(client) = restore_any_client(app).await? else {
        return Err("no restorable session to handle this push against".to_string());
    };

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
        return Ok(());
    }
    let mentions_only = matches!(
        mode,
        Some(matrix_sdk::notification_settings::RoomNotificationMode::MentionsAndKeywordsOnly)
    );

    let timeline_event = room
        .event(&event_id, None)
        .await
        .map_err(|e| e.to_string())?;
    let is_utd = timeline_event.kind.is_utd();
    let own_user_id = client.user_id().map(|id| id.as_str().to_string());

    let (sender, body, is_highlighted) = match message_preview(timeline_event.kind.raw()) {
        Some((sender, body)) => {
            if own_user_id.as_deref() == Some(sender.as_str()) {
                return Ok(());
            }
            let mentions = if mentions_only {
                match timeline_event.kind.raw().deserialize() {
                    Ok(AnySyncTimelineEvent::MessageLike(
                        AnySyncMessageLikeEvent::RoomMessage(SyncMessageLikeEvent::Original(
                            original,
                        )),
                    )) => original.content.mentions.clone(),
                    _ => None,
                }
            } else {
                None
            };
            let highlighted = own_user_id
                .as_deref()
                .is_some_and(|me| shell::is_highlighted_mentions(mentions.as_ref(), me));
            (sender, body, highlighted)
        }
        None => {
            if is_utd {
                sentry::capture_message(
                    &format!("push decrypt failed: unable to decrypt event in room {room_id}"),
                    sentry::Level::Warning,
                );
            }
            // Never leak ciphertext (acceptance criterion #4): a UTD or any
            // non-message event falls back to a generic body rather than
            // formatting whatever raw content was fetched.
            (String::new(), "New message".to_string(), false)
        }
    };

    if mentions_only && !is_highlighted && !sender.is_empty() {
        return Ok(());
    }

    if !sender.is_empty() && !app.state::<MatrixState>().mark_notified(&message.event_id) {
        return Ok(());
    }

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

    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(notif_body)
        .show();

    Ok(())
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
        };
        let registration: PushRegistration = (&status).into();
        assert_eq!(registration.transport, PusherKind::Apns);
        assert!(registration.registered);
        assert!(registration.endpoint_present);
    }
}
