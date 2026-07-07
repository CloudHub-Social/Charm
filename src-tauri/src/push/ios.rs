//! iOS transport: APNs via Tauri v2 mobile push. Structurally complete and
//! gated on an Apple Developer account — **no APNs certificate exists yet**
//! (see this spec's "Risks & open questions"), so nothing here can be
//! exercised end-to-end (no real device token, no gateway round-trip) until
//! that lands. It compiles (mobile-target compilation is unverified in this
//! environment — no Xcode toolchain available; CI's platform-build-verification
//! job is the real check) and the registration/pusher path is real; only live
//! verification is blocked.
//!
//! Registering for remote notifications
//! (`UIApplication.registerForRemoteNotifications()`) and receiving the
//! resulting device-token delegate callback are Objective-C runtime APIs
//! Rust can't call directly, and Tauri's Rust-driven iOS application delegate
//! (via `tao`) leaves no hand-editable `AppDelegate.swift` to hook into
//! directly. Tauri v2's supported extension point for exactly this —
//! native lifecycle callbacks plus an async Rust<->Swift round trip — is a
//! **mobile plugin**: a Swift `Plugin` subclass
//! (`gen/apple/Sources/charm/PushPlugin.swift`) that Tauri's iOS runtime
//! forwards `UIApplicationDelegate` callbacks to, registered from Rust via
//! `register_ios_plugin`. See [`init`] for the Rust-side half.
//!
//! The Notification Service Extension is a separate process with no Tauri
//! runtime at all, so it doesn't go through this plugin — see
//! `gen/apple/PushNotificationServiceExtension/NotificationService.swift`,
//! which calls a bare C entrypoint into the same Rust static lib instead.

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

use super::{PushEndpoint, PushError, PusherKind, IOS_APP_ID};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_charm_push);

/// Registers the `PushPlugin` Swift class (see this module's doc comment)
/// and stashes its `PluginHandle` in Tauri's managed state so
/// [`ApnsTransport`] can reach it without threading one through the trait.
/// Called once from `lib.rs`'s builder chain, mirroring every other
/// `tauri_plugin_*::init()` call there.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("charm-push")
        .setup(|app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_charm_push)?;
                app.manage(PushPluginHandle::<R>(handle));
            }
            let _ = app;
            Ok(())
        })
        .build()
}

#[cfg(target_os = "ios")]
struct PushPluginHandle<R: Runtime>(PluginHandle<R>);

#[derive(Debug, Serialize, Deserialize)]
struct RegisterResponse {
    token: String,
}

pub struct ApnsTransport {
    app: AppHandle,
}

impl ApnsTransport {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

static CURRENT_ENDPOINT: OnceLock<Mutex<Option<PushEndpoint>>> = OnceLock::new();

fn current_endpoint_cell() -> &'static Mutex<Option<PushEndpoint>> {
    CURRENT_ENDPOINT.get_or_init(|| Mutex::new(None))
}

#[async_trait::async_trait]
impl super::NotificationTransport for ApnsTransport {
    async fn register(&self) -> Result<PushEndpoint, PushError> {
        let handle = self
            .app
            .try_state::<PushPluginHandle<tauri::Wry>>()
            .ok_or_else(|| "charm-push plugin not initialized".to_string())?;
        let response: RegisterResponse = handle
            .0
            .run_mobile_plugin("register", ())
            .map_err(|e| e.to_string())?;
        let endpoint = PushEndpoint {
            url_or_token: response.token,
            app_id: IOS_APP_ID.to_string(),
            kind: PusherKind::Apns,
        };
        *current_endpoint_cell()
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(endpoint.clone());
        Ok(endpoint)
    }

    /// APNs has no server-side "unregister" call — a device simply stops
    /// receiving pushes once its token is dropped from the homeserver pusher
    /// list (done by `push::unregister_push`'s `client.pusher().delete(...)`
    /// call, not here). This only clears the locally cached endpoint.
    async fn unregister(&self) -> Result<(), PushError> {
        *current_endpoint_cell()
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        Ok(())
    }

    fn endpoint(&self) -> Option<PushEndpoint> {
        current_endpoint_cell()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_starts_empty() {
        // `AppHandle` has no public no-op constructor, so this only checks
        // the module-level static rather than constructing a transport —
        // the register/unregister round trip is exercised by the mock
        // `NotificationTransport` in `push::mod`'s own tests instead.
        assert!(current_endpoint_cell().lock().unwrap().clone().is_none());
    }
}
