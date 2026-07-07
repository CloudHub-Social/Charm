//! Android transport: UnifiedPush-first, falling back to the embedded FCM
//! distributor when no external UnifiedPush distributor is installed (see
//! this spec's "UnifiedPush fork scope" risk). Bridges into
//! `PushBridge.kt`/`PushMessagingReceiver.kt`
//! (`gen/android/app/src/main/java/social/cloudhub/charm/`) the same way
//! `secret_store::android` bridges into `SecureStorage.kt` — same
//! `with_env`/classloader-resolution shape, reused here rather than
//! reinvented.
//!
//! UnifiedPush's own registration call (`UnifiedPush.register`) is
//! fire-and-forget: the actual endpoint (or a failure) arrives later via the
//! `MessagingReceiver` callbacks Android delivers on its own schedule. This
//! module bridges that back into an `async fn register()` with a one-shot
//! channel that the JNI callback entrypoints
//! ([`native_on_new_endpoint`]/[`native_on_registration_failed`]) complete.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::JNIEnv;
use jni::JavaVM;
use tokio::sync::oneshot;

use super::{PushEndpoint, PushError, PusherKind, ANDROID_FCM_APP_ID, ANDROID_UNIFIED_PUSH_APP_ID};

const PUSH_BRIDGE_CLASS: &str = "social/cloudhub/charm/PushBridge";

/// How long `register()` waits for a `MessagingReceiver` callback before
/// giving up — UnifiedPush registration against a local distributor is
/// normally near-instant, but a slow/hung distributor app shouldn't hang the
/// settings panel's "Enable notifications" action forever.
const REGISTER_TIMEOUT: Duration = Duration::from_secs(20);

/// The instance id this app registers under — UnifiedPush supports multiple
/// named registrations per app (e.g. per-account); Charm is single-account
/// per install for now (same Day-2 note as `MatrixState`'s own doc comment),
/// so one fixed instance id is enough.
const INSTANCE_ID: &str = "charm";

static CLASS_REF: OnceLock<GlobalRef> = OnceLock::new();

/// Whichever `register()` call is currently waiting on a callback — `None`
/// once it's been resolved (either via a callback or the timeout), so a
/// callback that arrives late (after `register()` already timed out) is
/// dropped rather than sent into a channel nothing is listening on anymore.
static PENDING_REGISTRATION: Mutex<Option<oneshot::Sender<Result<PushEndpoint, PushError>>>> =
    Mutex::new(None);

/// The endpoint/token this transport last obtained — read by `endpoint()`
/// (used by `unregister_push` to know what to delete) and updated by the JNI
/// callbacks as the source of truth, since registration genuinely happens on
/// the Kotlin side, not in this struct.
static CURRENT_ENDPOINT: Mutex<Option<PushEndpoint>> = Mutex::new(None);

pub struct UnifiedPushTransport;

impl UnifiedPushTransport {
    pub fn new() -> Self {
        Self
    }
}

impl Default for UnifiedPushTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl super::NotificationTransport for UnifiedPushTransport {
    async fn register(&self) -> Result<PushEndpoint, PushError> {
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = PENDING_REGISTRATION
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            *pending = Some(tx);
        }

        if let Err(e) = with_env(|env, activity| {
            let instance = env.new_string(INSTANCE_ID).map_err(jni_err)?;
            let class = push_bridge_class(env, activity).map_err(jni_err)?;
            env.call_static_method(
                class,
                "register",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[JValue::from(activity), JValue::from(&instance)],
            )
            .map_err(jni_err)?;
            Ok(())
        }) {
            *PENDING_REGISTRATION
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
            return Err(e);
        }

        match tokio::time::timeout(REGISTER_TIMEOUT, rx).await {
            Ok(Ok(result)) => {
                if let Ok(endpoint) = &result {
                    *CURRENT_ENDPOINT.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(endpoint.clone());
                }
                result
            }
            Ok(Err(_)) => Err("push registration channel closed unexpectedly".to_string()),
            Err(_) => {
                *PENDING_REGISTRATION
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                Err("timed out waiting for a UnifiedPush/FCM endpoint".to_string())
            }
        }
    }

    async fn unregister(&self) -> Result<(), PushError> {
        with_env(|env, activity| {
            let instance = env.new_string(INSTANCE_ID).map_err(jni_err)?;
            let class = push_bridge_class(env, activity).map_err(jni_err)?;
            env.call_static_method(
                class,
                "unregister",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[JValue::from(activity), JValue::from(&instance)],
            )
            .map_err(jni_err)?;
            Ok(())
        })?;
        *CURRENT_ENDPOINT.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(())
    }

    fn endpoint(&self) -> Option<PushEndpoint> {
        CURRENT_ENDPOINT
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

fn jni_err(e: jni::errors::Error) -> PushError {
    e.to_string()
}

/// Attaches the calling thread to the JVM and hands back the app's
/// `Activity`/`Context` — identical shape to
/// `secret_store::android::with_env`, duplicated rather than shared because
/// pulling it into a common module for two call sites isn't worth the extra
/// indirection yet; revisit if a third Android JNI bridge shows up.
fn with_env<T>(
    f: impl FnOnce(&mut JNIEnv, &JObject) -> Result<T, PushError>,
) -> Result<T, PushError> {
    let ctx = ndk_context::android_context();
    // SAFETY: see `secret_store::android::with_env` — same Tauri-managed
    // JavaVM/Activity handle.
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    f(&mut env, &activity)
}

fn push_bridge_class<'a>(
    env: &mut JNIEnv<'a>,
    activity: &JObject,
) -> Result<JClass<'a>, jni::errors::Error> {
    if let Some(cached) = CLASS_REF.get() {
        let local = env.new_local_ref(cached.as_obj())?;
        return Ok(JClass::from(local));
    }
    let class_loader = env
        .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
        .l()?;
    let class_name = env.new_string(PUSH_BRIDGE_CLASS.replace('/', "."))?;
    let class_obj = env
        .call_method(
            &class_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::from(&class_name)],
        )?
        .l()?;
    let global = env.new_global_ref(&class_obj)?;
    let cached = CLASS_REF.get_or_init(|| global);
    let local = env.new_local_ref(cached.as_obj())?;
    Ok(JClass::from(local))
}

/// Whichever pending [`PENDING_REGISTRATION`] sender is waiting, resolved
/// with `result` and cleared — shared by every JNI callback entrypoint below
/// so "deliver this result and stop waiting" isn't duplicated four times.
fn resolve_pending(result: Result<PushEndpoint, PushError>) {
    if let Some(tx) = PENDING_REGISTRATION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        let _ = tx.send(result);
    }
}

fn jstring_to_string(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(|s| s.into()).unwrap_or_default()
}

/// Called from `PushMessagingReceiver.onNewEndpoint` once UnifiedPush (or the
/// embedded FCM fallback distributor) has an endpoint for `instance`. `via_fcm`
/// distinguishes which Sygnal `app_id` this endpoint should be registered
/// under (see this spec's two Android app ids).
#[no_mangle]
pub extern "system" fn Java_social_cloudhub_charm_PushMessagingReceiver_nativeOnNewEndpoint<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    endpoint: JString<'local>,
    via_fcm: jni::sys::jboolean,
) {
    let endpoint_str = jstring_to_string(&mut env, &endpoint);
    let app_id = if via_fcm != 0 {
        ANDROID_FCM_APP_ID
    } else {
        ANDROID_UNIFIED_PUSH_APP_ID
    };
    let kind = if via_fcm != 0 {
        PusherKind::Fcm
    } else {
        PusherKind::UnifiedPush
    };
    resolve_pending(Ok(PushEndpoint {
        url_or_token: endpoint_str,
        app_id: app_id.to_string(),
        kind,
    }));
}

/// Called from `PushMessagingReceiver.onRegistrationFailed`.
#[no_mangle]
pub extern "system" fn Java_social_cloudhub_charm_PushMessagingReceiver_nativeOnRegistrationFailed<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    reason: JString<'local>,
) {
    let reason = jstring_to_string(&mut env, &reason);
    resolve_pending(Err(format!("UnifiedPush registration failed: {reason}")));
}

/// Called from `PushMessagingReceiver.onUnregistered` — best-effort local
/// state cleanup; the Rust-side `unregister()` call path already clears
/// `CURRENT_ENDPOINT` itself, but the distributor can also unregister this
/// app out-of-band (e.g. the user removed it from the distributor's own UI).
#[no_mangle]
pub extern "system" fn Java_social_cloudhub_charm_PushMessagingReceiver_nativeOnUnregistered<
    'local,
>(
    _env: JNIEnv<'local>,
    _class: JClass<'local>,
) {
    *CURRENT_ENDPOINT.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Called from `PushMessagingReceiver.onMessage` with the raw push bytes
/// (an `event_id_only` Sygnal payload's JSON body) — parses `room_id`/
/// `event_id` and hands off to [`super::handle_push`] on a spawned task, since
/// JNI callbacks run synchronously on whatever thread Android delivers them
/// on and must return quickly.
#[no_mangle]
pub extern "system" fn Java_social_cloudhub_charm_PushMessagingReceiver_nativeOnMessage<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    payload_json: JString<'local>,
) {
    let payload = jstring_to_string(&mut env, &payload_json);
    let Some(app) = super::global_app_handle() else {
        eprintln!("push received before the app handle was initialized; dropping");
        return;
    };
    let Some(message) = parse_event_id_only_payload(&payload) else {
        eprintln!("push payload missing room_id/event_id; dropping");
        return;
    };
    tauri::async_runtime::spawn(async move {
        if let Err(e) = super::handle_push(&app, message).await {
            eprintln!("handle_push failed: {e}");
        }
    });
}

/// Parses the `notification.room_id`/`notification.event_id` fields out of a
/// Sygnal-style `event_id_only` push payload
/// (`{"notification":{"room_id":"!x:y","event_id":"$z","counts":{...}}}`).
fn parse_event_id_only_payload(payload: &str) -> Option<super::PushMessage> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let notification = value.get("notification")?;
    let room_id = notification.get("room_id")?.as_str()?.to_string();
    let event_id = notification.get("event_id")?.as_str()?.to_string();
    Some(super::PushMessage { room_id, event_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_well_formed_event_id_only_payload() {
        let payload = r#"{"notification":{"room_id":"!abc:example.org","event_id":"$xyz","counts":{"unread":1}}}"#;
        let message = parse_event_id_only_payload(payload).expect("should parse");
        assert_eq!(message.room_id, "!abc:example.org");
        assert_eq!(message.event_id, "$xyz");
    }

    #[test]
    fn rejects_a_payload_missing_event_id() {
        let payload = r#"{"notification":{"room_id":"!abc:example.org"}}"#;
        assert!(parse_event_id_only_payload(payload).is_none());
    }

    #[test]
    fn rejects_non_json_payload() {
        assert!(parse_event_id_only_payload("not json").is_none());
    }
}
