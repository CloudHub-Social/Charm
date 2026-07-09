//! Cross-platform secret storage for [`persistence`](super::persistence) —
//! the SQLCipher store passphrase and session/OAuth-session tokens.
//!
//! macOS/Windows/Linux delegate straight to the `keyring` crate (unchanged
//! behavior from before this module existed). `keyring` has no Android
//! backend: there's no OS-level "secret service"/credential-manager API for
//! it to wrap there the way there is on desktop — Android's equivalent,
//! the Keystore system, is only reachable via JNI. The Android
//! implementation below calls into a small Kotlin helper
//! (`gen/android/.../SecureStorage.kt`) that wraps `androidx.security`'s
//! `EncryptedSharedPreferences`, whose values are encrypted with an
//! AES-256-GCM key generated and held inside the Android Keystore — real
//! Keystore-backed secure storage, not a plaintext file.
//!
//! This intentionally mirrors `keyring::Entry`'s own shape (`new`,
//! `get_password`, `set_password`, `delete_credential`, plus a `NotFound`
//! error variant standing in for `keyring::Error::NoEntry`) so callers in
//! `persistence.rs` only need a mechanical `keyring::` -> `secret_store::`
//! rename, not a behavioral rewrite.

use std::fmt;

#[cfg(target_os = "android")]
use jni::objects::GlobalRef;
#[cfg(target_os = "android")]
use jni::JavaVM;

#[derive(Debug)]
pub(crate) enum SecretStoreError {
    /// No entry exists for this service/account — stands in for
    /// `keyring::Error::NoEntry` so existing match arms on that variant
    /// port over unchanged.
    NotFound,
    Other(String),
}

impl fmt::Display for SecretStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => write!(f, "no entry found for the given service/account"),
            Self::Other(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for SecretStoreError {}

#[cfg(not(target_os = "android"))]
fn map_keyring_error(error: keyring::Error) -> SecretStoreError {
    match error {
        keyring::Error::NoEntry => SecretStoreError::NotFound,
        other => SecretStoreError::Other(other.to_string()),
    }
}

/// A single named secret (service + account), reachable via the platform's
/// secure-storage backend. See the module doc comment for what that is on
/// each platform.
pub(crate) struct SecretEntry {
    #[cfg(not(target_os = "android"))]
    inner: keyring::Entry,
    #[cfg(target_os = "android")]
    service: String,
    #[cfg(target_os = "android")]
    account: String,
}

impl SecretEntry {
    pub(crate) fn new(service: &str, account: &str) -> Result<Self, SecretStoreError> {
        #[cfg(not(target_os = "android"))]
        {
            let inner = keyring::Entry::new(service, account).map_err(map_keyring_error)?;
            Ok(Self { inner })
        }
        #[cfg(target_os = "android")]
        {
            Ok(Self {
                service: service.to_string(),
                account: account.to_string(),
            })
        }
    }

    pub(crate) fn get_password(&self) -> Result<String, SecretStoreError> {
        #[cfg(not(target_os = "android"))]
        {
            self.inner.get_password().map_err(map_keyring_error)
        }
        #[cfg(target_os = "android")]
        {
            android::get(&self.service, &self.account)
        }
    }

    pub(crate) fn set_password(&self, password: &str) -> Result<(), SecretStoreError> {
        #[cfg(not(target_os = "android"))]
        {
            self.inner.set_password(password).map_err(map_keyring_error)
        }
        #[cfg(target_os = "android")]
        {
            android::set(&self.service, &self.account, password)
        }
    }

    pub(crate) fn delete_credential(&self) -> Result<(), SecretStoreError> {
        #[cfg(not(target_os = "android"))]
        {
            self.inner.delete_credential().map_err(map_keyring_error)
        }
        #[cfg(target_os = "android")]
        {
            android::delete(&self.service, &self.account)
        }
    }
}

#[cfg(target_os = "android")]
mod android {
    //! JNI bridge to `SecureStorage.kt` (bundled at
    //! `gen/android/app/src/main/java/social/cloudhub/charm/SecureStorage.kt`),
    //! which does the actual `EncryptedSharedPreferences` read/write. Uses
    //! `ndk_context::android_context()` — the same global JavaVM/Activity
    //! handle Tauri itself sets up on Android — rather than threading a JNI
    //! context through every `persistence.rs` call site.

    use super::SecretStoreError;
    use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
    use jni::JavaVM;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    };

    const SECURE_STORAGE_CLASS: &str = "social/cloudhub/charm/SecureStorage";

    /// Cached `GlobalRef` to the `SecureStorage` `Class` object, resolved
    /// once via the Activity's own classloader (see [`secure_storage_class`])
    /// rather than looked up by name on every call.
    static SECURE_STORAGE_CLASS_REF: OnceLock<GlobalRef> = OnceLock::new();

    struct ContextOverride {
        id: u64,
        vm: JavaVM,
        context: GlobalRef,
    }

    static CONTEXT_OVERRIDE: Mutex<Option<ContextOverride>> = Mutex::new(None);
    static NEXT_CONTEXT_OVERRIDE_ID: AtomicU64 = AtomicU64::new(1);

    pub(crate) struct ContextOverrideGuard {
        id: u64,
    }

    impl Drop for ContextOverrideGuard {
        fn drop(&mut self) {
            let mut current = CONTEXT_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner());
            if current
                .as_ref()
                .is_some_and(|context| context.id == self.id)
            {
                *current = None;
            }
        }
    }

    pub(crate) fn install_context_override(vm: JavaVM, context: GlobalRef) -> ContextOverrideGuard {
        let id = NEXT_CONTEXT_OVERRIDE_ID.fetch_add(1, Ordering::Relaxed);
        *CONTEXT_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(ContextOverride { id, vm, context });
        ContextOverrideGuard { id }
    }

    /// Maps a JNI call's result to `SecretStoreError`, and — if it failed —
    /// clears any pending Java exception first.
    ///
    /// The `jni` crate's exception-checking macros (used internally by
    /// `call_method`/`call_static_method`/etc.) convert a pending exception
    /// into `Err(Error::JavaException)` but never call `ExceptionClear`
    /// themselves (confirmed against the jni 0.21.1 source: `check_exception!`
    /// returns the error without clearing). Per the JNI spec, almost no JNI
    /// function may be called with an exception still pending — including
    /// implicitly on thread detach — so leaving one set here could crash the
    /// JVM the next time this (or another) call reuses the thread.
    fn jni_result<T>(
        env: &mut jni::JNIEnv,
        context: &str,
        result: Result<T, jni::errors::Error>,
    ) -> Result<T, SecretStoreError> {
        result.map_err(|e| {
            let _ = env.exception_clear();
            SecretStoreError::Other(format!("{context}: {e}"))
        })
    }

    /// Attaches the calling thread to the JVM and hands back an `env` plus
    /// the Android `Context` (the running `Activity`) `SecureStorage`'s
    /// methods need to open `EncryptedSharedPreferences`.
    fn with_env<T>(
        f: impl FnOnce(&mut jni::JNIEnv, &JObject) -> Result<T, SecretStoreError>,
    ) -> Result<T, SecretStoreError> {
        let override_guard = CONTEXT_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(override_context) = override_guard.as_ref() {
            let mut env = override_context
                .vm
                .attach_current_thread()
                .map_err(|e| SecretStoreError::Other(format!("attach current thread: {e}")))?;
            let result = env.new_local_ref(override_context.context.as_obj());
            let context = jni_result(&mut env, "new_local_ref(headless Context)", result)?;
            return f(&mut env, &context);
        }
        drop(override_guard);

        let ctx = ndk_context::android_context();
        // SAFETY: `ctx.vm()`/`ctx.context()` are raw JNI pointers Tauri's own
        // Android runtime already established and keeps alive for the life
        // of the process — the same handle every Android-targeting Tauri
        // plugin uses to reach the JVM from native code.
        //
        // No `env` exists yet at this point, so there's nothing to clear a
        // pending exception on — neither of these can leave one pending
        // anyway (they attach/describe the JVM itself, not a Java call).
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| SecretStoreError::Other(format!("attach to JVM: {e}")))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| SecretStoreError::Other(format!("attach current thread: {e}")))?;
        // SAFETY: `ctx.context()` is a valid `jobject` for the app's
        // `Activity`/`Context` for the lifetime of this call.
        let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
        f(&mut env, &activity)
    }

    /// Resolves the `SecureStorage` class via the Activity's own classloader
    /// rather than `JNIEnv::find_class`/a by-name `call_static_method`.
    ///
    /// A thread attached to the JVM from native code (as `with_env` does for
    /// every call here, since these run on Tokio worker threads, not the
    /// thread Android started the app on) resolves plain class-name lookups
    /// against the *system* classloader, which only knows the Android
    /// framework — not app-defined classes like this one. That lookup would
    /// intermittently throw `ClassNotFoundException` (in practice, on
    /// whichever call happens to land on a freshly-attached thread first).
    /// Going through `activity.getClassLoader()` instead resolves against the
    /// app's own classloader, same as a normal Kotlin/Java call site would.
    fn secure_storage_class<'a>(
        env: &mut jni::JNIEnv<'a>,
        activity: &JObject,
    ) -> Result<JClass<'a>, SecretStoreError> {
        if let Some(cached) = SECURE_STORAGE_CLASS_REF.get() {
            // `JObject` doesn't implement `Clone` in jni 0.21 (local/global
            // refs are tracked resources, not freely copyable values) — a
            // new local ref onto the same underlying object is the correct
            // way to hand out another usable reference to it.
            let result = env.new_local_ref(cached.as_obj());
            let local = jni_result(env, "new_local_ref(cached SecureStorage class)", result)?;
            return Ok(JClass::from(local));
        }
        let result = env.call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[]);
        let class_loader = jni_result(env, "activity.getClassLoader()", result)?;
        let result = class_loader.l();
        let class_loader = jni_result(env, "getClassLoader() return value", result)?;
        let result = env.new_string(SECURE_STORAGE_CLASS.replace('/', "."));
        let class_name = jni_result(env, "new_string(class name)", result)?;
        let result = env.call_method(
            &class_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::from(&class_name)],
        );
        let class_obj = jni_result(env, "classLoader.loadClass(SecureStorage)", result)?;
        let result = class_obj.l();
        let class_obj = jni_result(env, "loadClass() return value", result)?;
        let result = env.new_global_ref(&class_obj);
        let global = jni_result(env, "new_global_ref(SecureStorage class)", result)?;
        // Another thread may have raced us here; either ref works, so keep
        // whichever `OnceLock::set` actually won and use that one.
        let cached = SECURE_STORAGE_CLASS_REF.get_or_init(|| global);
        let result = env.new_local_ref(cached.as_obj());
        let local = jni_result(env, "new_local_ref(cached SecureStorage class)", result)?;
        Ok(JClass::from(local))
    }

    pub(super) fn get(service: &str, account: &str) -> Result<String, SecretStoreError> {
        with_env(|env, activity| {
            let class = secure_storage_class(env, activity)?;
            let result = env.new_string(service);
            let service_j = jni_result(env, "new_string(service)", result)?;
            let result = env.new_string(account);
            let account_j = jni_result(env, "new_string(account)", result)?;
            let result = env.call_static_method(
                class,
                "get",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[
                    JValue::from(activity),
                    JValue::from(&service_j),
                    JValue::from(&account_j),
                ],
            );
            let return_value = jni_result(env, "call SecureStorage.get", result)?;
            let result = return_value.l();
            let obj = jni_result(env, "SecureStorage.get return value", result)?;
            if obj.is_null() {
                return Err(SecretStoreError::NotFound);
            }
            let value_str = JString::from(obj);
            let result = env.get_string(&value_str);
            let value: String = jni_result(env, "read SecureStorage.get result", result)?.into();
            Ok(value)
        })
    }

    pub(super) fn set(
        service: &str,
        account: &str,
        password: &str,
    ) -> Result<(), SecretStoreError> {
        with_env(|env, activity| {
            let class = secure_storage_class(env, activity)?;
            let result = env.new_string(service);
            let service_j = jni_result(env, "new_string(service)", result)?;
            let result = env.new_string(account);
            let account_j = jni_result(env, "new_string(account)", result)?;
            let result = env.new_string(password);
            let password_j = jni_result(env, "new_string(password)", result)?;
            let result = env.call_static_method(
                class,
                "set",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
                &[
                    JValue::from(activity),
                    JValue::from(&service_j),
                    JValue::from(&account_j),
                    JValue::from(&password_j),
                ],
            );
            jni_result(env, "call SecureStorage.set", result)?;
            Ok(())
        })
    }

    pub(super) fn delete(service: &str, account: &str) -> Result<(), SecretStoreError> {
        with_env(|env, activity| {
            let class = secure_storage_class(env, activity)?;
            let result = env.new_string(service);
            let service_j = jni_result(env, "new_string(service)", result)?;
            let result = env.new_string(account);
            let account_j = jni_result(env, "new_string(account)", result)?;
            let result = env.call_static_method(
                class,
                "delete",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
                &[
                    JValue::from(activity),
                    JValue::from(&service_j),
                    JValue::from(&account_j),
                ],
            );
            jni_result(env, "call SecureStorage.delete", result)?;
            Ok(())
        })
    }
}

#[cfg(target_os = "android")]
pub(crate) type AndroidContextOverrideGuard = android::ContextOverrideGuard;

#[cfg(target_os = "android")]
pub(crate) fn install_android_context_override(
    vm: JavaVM,
    context: GlobalRef,
) -> AndroidContextOverrideGuard {
    android::install_context_override(vm, context)
}
