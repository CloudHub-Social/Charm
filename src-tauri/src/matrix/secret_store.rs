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
    use std::sync::OnceLock;

    const SECURE_STORAGE_CLASS: &str = "social/cloudhub/charm/SecureStorage";

    /// Cached `GlobalRef` to the `SecureStorage` `Class` object, resolved
    /// once via the Activity's own classloader (see [`secure_storage_class`])
    /// rather than looked up by name on every call.
    static SECURE_STORAGE_CLASS_REF: OnceLock<GlobalRef> = OnceLock::new();

    fn jni_error(context: &str) -> impl Fn(jni::errors::Error) -> SecretStoreError + '_ {
        move |e| SecretStoreError::Other(format!("{context}: {e}"))
    }

    /// Attaches the calling thread to the JVM and hands back an `env` plus
    /// the Android `Context` (the running `Activity`) `SecureStorage`'s
    /// methods need to open `EncryptedSharedPreferences`.
    fn with_env<T>(
        f: impl FnOnce(&mut jni::JNIEnv, &JObject) -> Result<T, SecretStoreError>,
    ) -> Result<T, SecretStoreError> {
        let ctx = ndk_context::android_context();
        // SAFETY: `ctx.vm()`/`ctx.context()` are raw JNI pointers Tauri's own
        // Android runtime already established and keeps alive for the life
        // of the process — the same handle every Android-targeting Tauri
        // plugin uses to reach the JVM from native code.
        let vm =
            unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(jni_error("attach to JVM"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(jni_error("attach current thread"))?;
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
            let local = env
                .new_local_ref(cached.as_obj())
                .map_err(jni_error("new_local_ref(cached SecureStorage class)"))?;
            return Ok(JClass::from(local));
        }
        let class_loader = env
            .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(jni_error("activity.getClassLoader()"))?
            .l()
            .map_err(jni_error("getClassLoader() return value"))?;
        let class_name = env
            .new_string(SECURE_STORAGE_CLASS.replace('/', "."))
            .map_err(jni_error("new_string(class name)"))?;
        let class_obj = env
            .call_method(
                &class_loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::from(&class_name)],
            )
            .map_err(jni_error("classLoader.loadClass(SecureStorage)"))?
            .l()
            .map_err(jni_error("loadClass() return value"))?;
        let global = env
            .new_global_ref(&class_obj)
            .map_err(jni_error("new_global_ref(SecureStorage class)"))?;
        // Another thread may have raced us here; either ref works, so keep
        // whichever `OnceLock::set` actually won and use that one.
        let cached = SECURE_STORAGE_CLASS_REF.get_or_init(|| global);
        let local = env
            .new_local_ref(cached.as_obj())
            .map_err(jni_error("new_local_ref(cached SecureStorage class)"))?;
        Ok(JClass::from(local))
    }

    pub(super) fn get(service: &str, account: &str) -> Result<String, SecretStoreError> {
        with_env(|env, activity| {
            let class = secure_storage_class(env, activity)?;
            let service_j = env
                .new_string(service)
                .map_err(jni_error("new_string(service)"))?;
            let account_j = env
                .new_string(account)
                .map_err(jni_error("new_string(account)"))?;
            let result = env
                .call_static_method(
                    class,
                    "get",
                    "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                    &[
                        JValue::from(activity),
                        JValue::from(&service_j),
                        JValue::from(&account_j),
                    ],
                )
                .map_err(jni_error("call SecureStorage.get"))?;
            let obj = result
                .l()
                .map_err(jni_error("SecureStorage.get return value"))?;
            if obj.is_null() {
                return Err(SecretStoreError::NotFound);
            }
            let value_str = JString::from(obj);
            let value: String = env
                .get_string(&value_str)
                .map_err(jni_error("read SecureStorage.get result"))?
                .into();
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
            let service_j = env
                .new_string(service)
                .map_err(jni_error("new_string(service)"))?;
            let account_j = env
                .new_string(account)
                .map_err(jni_error("new_string(account)"))?;
            let password_j = env
                .new_string(password)
                .map_err(jni_error("new_string(password)"))?;
            env.call_static_method(
                class,
                "set",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
                &[
                    JValue::from(activity),
                    JValue::from(&service_j),
                    JValue::from(&account_j),
                    JValue::from(&password_j),
                ],
            )
            .map_err(jni_error("call SecureStorage.set"))?;
            Ok(())
        })
    }

    pub(super) fn delete(service: &str, account: &str) -> Result<(), SecretStoreError> {
        with_env(|env, activity| {
            let class = secure_storage_class(env, activity)?;
            let service_j = env
                .new_string(service)
                .map_err(jni_error("new_string(service)"))?;
            let account_j = env
                .new_string(account)
                .map_err(jni_error("new_string(account)"))?;
            env.call_static_method(
                class,
                "delete",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
                &[
                    JValue::from(activity),
                    JValue::from(&service_j),
                    JValue::from(&account_j),
                ],
            )
            .map_err(jni_error("call SecureStorage.delete"))?;
            Ok(())
        })
    }
}
