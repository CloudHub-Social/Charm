//! iOS transport: APNs via Tauri v2 mobile push.
//!
//! **Not wired up yet — `register`/`unregister` return an explicit error
//! rather than pretending to work.** Registering for remote notifications
//! (`UIApplication.registerForRemoteNotifications()`) and receiving the
//! resulting device-token delegate callback are Objective-C runtime APIs
//! Rust can't call directly, and Tauri's Rust-driven iOS application delegate
//! (via `tao`) leaves no hand-editable `AppDelegate.swift` to hook into
//! directly. Tauri v2's supported extension point for exactly this is a
//! **mobile plugin** (a Swift `Plugin` subclass Tauri's iOS runtime forwards
//! `UIApplicationDelegate` callbacks to, registered from Rust via
//! `tauri::ios_plugin_binding!`/`register_ios_plugin`) — a first attempt at
//! that here broke CI: `ios_plugin_binding!` emits an `extern "C"` reference
//! Rust expects resolved at `cargo build --lib`'s *own* link step (not later,
//! when Xcode links the full app with the Swift plugin's `@_cdecl` symbol),
//! and this project's `Sources/charm` isn't wired through the Tauri CLI's
//! `tauri plugin ios init`-generated scaffolding that normally makes that
//! work — reproducing that scaffolding by hand, with no Xcode available in
//! this environment to iterate against, risked shipping something that
//! looked done but silently never linked. Removed rather than left half-broken.
//!
//! What it would take to finish this: run `pnpm tauri ios init` (or the
//! equivalent plugin scaffolding step) in a real Xcode environment to
//! generate the correct plugin crate/Swift-package wiring, reimplement
//! `PushPlugin.swift`'s `register`/`didRegisterForRemoteNotificationsWithDeviceToken`
//! against that scaffolding, and verify a real `cargo build --target
//! aarch64-apple-ios-sim` + `xcodebuild` round-trip before relying on it.
//! Android is unaffected — its JNI bridge (`push::android`) resolves symbols
//! at JVM runtime via `System.loadLibrary`, not at Rust link time, so it
//! doesn't have this problem.

use tauri::{AppHandle, Runtime};

use super::{PushEndpoint, PushError};

/// Intentionally not a real Tauri plugin yet — see this module's doc
/// comment. Kept as a plain `Builder` with no `.setup()` so `lib.rs` has a
/// stable `push::ios::init()` call site to swap the real implementation into
/// later, without another `lib.rs` edit.
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("charm-push").build()
}

pub struct ApnsTransport {
    #[allow(dead_code)]
    app: AppHandle,
}

impl ApnsTransport {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait::async_trait]
impl super::NotificationTransport for ApnsTransport {
    async fn register(&self) -> Result<PushEndpoint, PushError> {
        Err("APNs registration is not wired up yet — see push::ios's doc comment".to_string())
    }

    async fn unregister(&self) -> Result<(), PushError> {
        Ok(())
    }

    fn endpoint(&self) -> Option<PushEndpoint> {
        None
    }
}
