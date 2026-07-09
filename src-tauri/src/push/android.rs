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

use std::ffi::{c_char, CString};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::JNIEnv;
use jni::JavaVM;
use tokio::sync::oneshot;

use super::{PushEndpoint, PushError, PusherKind, ANDROID_FCM_APP_ID, ANDROID_UNIFIED_PUSH_APP_ID};

const PUSH_BRIDGE_CLASS: &str = "social/cloudhub/charm/PushBridge";
const ANDROID_LOG_WARN: i32 = 5;
const ANDROID_LOG_TAG: &str = "CharmPush";

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

#[link(name = "log")]
extern "C" {
    fn __android_log_write(prio: i32, tag: *const c_char, text: *const c_char) -> i32;
}

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
            // A second concurrent `register()` call (e.g. a double-tapped
            // "turn on" button) would otherwise silently orphan whichever
            // sender was here first — its `rx` never gets resolved by a
            // real callback (only the newest sender is fed the next
            // `onNewEndpoint`/`onRegistrationFailed`) and just times out
            // 20s later instead of returning a prompt, clear error now.
            if pending.is_some() {
                return Err("a push registration is already in progress".to_string());
            }
            *pending = Some(tx);
        }

        if let Err(e) = with_env(|env, activity| {
            let new_string_result = env.new_string(INSTANCE_ID);
            let instance = jni_result(env, "new_string(instance)", new_string_result)?;
            let class = push_bridge_class(env, activity)?;
            let result = env.call_static_method(
                class,
                "register",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[JValue::from(activity), JValue::from(&instance)],
            );
            jni_result(env, "PushBridge.register", result)?;
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
            let new_string_result = env.new_string(INSTANCE_ID);
            let instance = jni_result(env, "new_string(instance)", new_string_result)?;
            let class = push_bridge_class(env, activity)?;
            let result = env.call_static_method(
                class,
                "unregister",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[JValue::from(activity), JValue::from(&instance)],
            );
            jni_result(env, "PushBridge.unregister", result)?;
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

/// Maps a JNI call's result to [`PushError`], and — if it failed — clears
/// any pending Java exception first. Same rationale as
/// `secret_store::android::jni_result` (which this mirrors): the `jni`
/// crate's `call_method`/`call_static_method`/etc. surface a pending
/// exception as `Err(Error::JavaException)` but never clear it themselves,
/// and per the JNI spec almost no JNI call is valid with one still pending
/// — including implicitly on thread detach — so leaving it set here could
/// crash the JVM the next time this (or another) call reuses the thread.
fn jni_result<T>(
    env: &mut JNIEnv,
    context: &str,
    result: Result<T, jni::errors::Error>,
) -> Result<T, PushError> {
    result.map_err(|e| {
        let _ = env.exception_clear();
        format!("{context}: {e}")
    })
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

/// Resolves the `PushBridge` class via the Activity's own classloader —
/// same rationale as `secret_store::android::secure_storage_class`'s doc
/// comment: a thread attached to the JVM from native code (as every call
/// here is, since these run on Tokio worker threads) resolves plain
/// class-name lookups against the *system* classloader, which doesn't know
/// app-defined classes like this one.
fn push_bridge_class<'a>(
    env: &mut JNIEnv<'a>,
    activity: &JObject,
) -> Result<JClass<'a>, PushError> {
    if let Some(cached) = CLASS_REF.get() {
        let result = env.new_local_ref(cached.as_obj());
        let local = jni_result(env, "new_local_ref(cached PushBridge class)", result)?;
        return Ok(JClass::from(local));
    }
    let result = env.call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[]);
    let class_loader = jni_result(env, "activity.getClassLoader()", result)?;
    let result = class_loader.l();
    let class_loader = jni_result(env, "getClassLoader() return value", result)?;
    let result = env.new_string(PUSH_BRIDGE_CLASS.replace('/', "."));
    let class_name = jni_result(env, "new_string(class name)", result)?;
    let result = env.call_method(
        &class_loader,
        "loadClass",
        "(Ljava/lang/String;)Ljava/lang/Class;",
        &[JValue::from(&class_name)],
    );
    let class_obj = jni_result(env, "classLoader.loadClass(PushBridge)", result)?;
    let result = class_obj.l();
    let class_obj = jni_result(env, "loadClass() return value", result)?;
    let result = env.new_global_ref(&class_obj);
    let global = jni_result(env, "new_global_ref(PushBridge class)", result)?;
    let cached = CLASS_REF.get_or_init(|| global);
    let result = env.new_local_ref(cached.as_obj());
    let local = jni_result(env, "new_local_ref(cached PushBridge class)", result)?;
    Ok(JClass::from(local))
}

/// Whichever pending [`PENDING_REGISTRATION`] sender is waiting, resolved
/// with `result` and cleared — shared by every JNI callback entrypoint below
/// so "deliver this result and stop waiting" isn't duplicated four times.
/// Returns whether a sender was actually waiting, so
/// `nativeOnNewEndpoint` can tell a user-initiated `register()` completing
/// apart from an unprompted endpoint rotation with nothing waiting on it.
fn resolve_pending(result: Result<PushEndpoint, PushError>) -> bool {
    if let Some(tx) = PENDING_REGISTRATION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        let _ = tx.send(result);
        true
    } else {
        false
    }
}

fn jstring_to_string(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(|s| s.into()).unwrap_or_default()
}

fn warn_before_tracing_setup(message: &str) {
    let Ok(tag) = CString::new(ANDROID_LOG_TAG) else {
        return;
    };
    let Ok(text) = CString::new(message) else {
        return;
    };

    // This JNI path can run before Tauri `setup()` installs Rust tracing, so
    // write directly to Android's log buffer instead of relying on a subscriber.
    unsafe {
        let _ = __android_log_write(ANDROID_LOG_WARN, tag.as_ptr(), text.as_ptr());
    }
}

/// Called from `PushMessagingReceiver.onNewEndpoint` once UnifiedPush (or the
/// embedded FCM fallback distributor) has an endpoint for `instance`. `via_fcm`
/// distinguishes which Sygnal `app_id` this endpoint should be registered
/// under (see this spec's two Android app ids).
///
/// This is an *instance* method on `PushMessagingReceiver` (declared as a
/// bare `external fun` inside the class body, not in a `companion object`),
/// so the JVM passes a `this` reference as the second native argument, not a
/// `jclass` — the parameter here must be `JObject`, matching that calling
/// convention, or every call from Kotlin is undefined behavior.
#[no_mangle]
pub extern "system" fn Java_social_cloudhub_charm_PushMessagingReceiver_nativeOnNewEndpoint<
    'local,
>(
    mut env: JNIEnv<'local>,
    _this: JObject<'local>,
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
    let push_endpoint = PushEndpoint {
        url_or_token: endpoint_str,
        app_id: app_id.to_string(),
        kind,
    };

    // Always keep this current — a rotation (the distributor issuing a
    // replacement endpoint) can arrive with no `register()` waiting on it
    // at all (see below), and `endpoint()` (what `unregister_push` deletes
    // from the homeserver) must never read a stale value in that case.
    *CURRENT_ENDPOINT.lock().unwrap_or_else(|e| e.into_inner()) = Some(push_endpoint.clone());

    if !resolve_pending(Ok(push_endpoint.clone())) {
        // Nothing was waiting: this wasn't a response to a user-initiated
        // `register()` call, so the homeserver still has the *old* pushkey
        // on file. Re-register the new one directly — without this, a
        // rotation silently breaks push delivery until the user happens to
        // manually toggle it off and back on.
        let Some(app) = super::global_app_handle() else {
            eprintln!("endpoint rotation received before the app handle was initialized; dropping");
            return;
        };
        tauri::async_runtime::spawn(async move {
            super::reregister_endpoint(&app, push_endpoint).await;
        });
    }
}

/// Called from `PushMessagingReceiver.onRegistrationFailed`. See
/// `nativeOnNewEndpoint`'s doc comment for why this takes `JObject`, not
/// `JClass`.
#[no_mangle]
pub extern "system" fn Java_social_cloudhub_charm_PushMessagingReceiver_nativeOnRegistrationFailed<
    'local,
>(
    mut env: JNIEnv<'local>,
    _this: JObject<'local>,
    reason: JString<'local>,
) {
    let reason = jstring_to_string(&mut env, &reason);
    resolve_pending(Err(format!("UnifiedPush registration failed: {reason}")));
}

/// Called from `PushMessagingReceiver.onUnregistered` — the distributor
/// unregistered this app out-of-band (e.g. the user removed it from the
/// distributor's own UI, or the Rust-side `unregister()` call path's own
/// `UnifiedPush.unregister()` triggered it). Clears the local endpoint
/// immediately, then spawns `super::handle_transport_unregistered` to also
/// delete the homeserver pusher — per UnifiedPush's own contract for this
/// callback, see that function's doc comment. See `nativeOnNewEndpoint`'s
/// doc comment for why this takes `JObject`, not `JClass`.
#[no_mangle]
pub extern "system" fn Java_social_cloudhub_charm_PushMessagingReceiver_nativeOnUnregistered<
    'local,
>(
    _env: JNIEnv<'local>,
    _this: JObject<'local>,
) {
    *CURRENT_ENDPOINT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let Some(app) = super::global_app_handle() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        super::handle_transport_unregistered(&app).await;
    });
}

/// Called from `PushMessagingReceiver.onMessage` with the raw push bytes
/// (an `event_id_only` Sygnal payload's JSON body) — parses `room_id`/
/// `event_id` and hands off to [`super::handle_push`] on a spawned task, since
/// JNI callbacks run synchronously on whatever thread Android delivers them
/// on and must return quickly. See `nativeOnNewEndpoint`'s doc comment for
/// why this takes `JObject`, not `JClass`.
///
/// If Android cold-started this process purely to deliver this broadcast
/// (the app was fully killed), `lib.rs`'s `setup()` hasn't run yet and
/// `global_app_handle()` is empty — this push is dropped rather than
/// handled. Making the killed-app path work fully requires a headless
/// bootstrap that doesn't depend on Tauri's own `setup()` lifecycle; that's
/// a larger follow-up, not attempted here.
#[no_mangle]
pub extern "system" fn Java_social_cloudhub_charm_PushMessagingReceiver_nativeOnMessage<'local>(
    mut env: JNIEnv<'local>,
    _this: JObject<'local>,
    payload_json: JString<'local>,
) {
    let payload = jstring_to_string(&mut env, &payload_json);
    let Some(app) = super::global_app_handle() else {
        warn_before_tracing_setup(
            "android_push no_app_handle: push received before the app handle was initialized; dropping",
        );
        return;
    };
    let Some(message) = parse_event_id_only_payload(&payload) else {
        tracing::warn!(
            command = "android_push",
            status = "missing_fields",
            "Push payload missing room_id/event_id; dropping"
        );
        return;
    };
    tauri::async_runtime::spawn(async move {
        if let Err(e) = super::handle_push(&app, message).await {
            tracing::error!(
                command = "android_push",
                status = "failed",
                error = %e,
                "handle_push failed"
            );
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
