import Tauri
import UIKit
import Foundation

/// Rust-side half: `src-tauri/src/push/ios.rs`'s `ApnsTransport` (via
/// `register_ios_plugin(init_plugin_charm_push)` / `run_mobile_plugin`).
///
/// `UIApplication.registerForRemoteNotifications()` and its device-token
/// delegate callback are Objective-C runtime APIs Rust can't reach directly,
/// and Tauri's iOS runtime owns the actual `UIApplicationDelegate` (via
/// `tao`) rather than exposing a hand-editable `AppDelegate.swift` — a
/// **mobile plugin** is Tauri v2's supported extension point for exactly
/// this: native lifecycle callbacks plus an async Rust<->Swift round trip.
/// Tauri's iOS plugin runtime forwards select `UIApplicationDelegate`
/// callbacks (including the two below) to every registered `Plugin`, the
/// same way Capacitor's plugin bridge does (Tauri's mobile plugin API was
/// explicitly modeled on it).
class PushPlugin: Plugin {
    /// The in-flight `register` command, resolved once a device token (or a
    /// failure) arrives. `UIApplication` only supports one outstanding
    /// registration at a time, so a single stored `Invoke` — not a
    /// queue/map — is the right shape here.
    private var pendingRegisterInvoke: Invoke?

    @objc public func register(_ invoke: Invoke) {
        pendingRegisterInvoke = invoke
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// APNs has no server-side "unregister" — see `ApnsTransport::unregister`'s
    /// doc comment. `unregisterForRemoteNotifications()` just stops this
    /// device from getting new tokens locally.
    @objc public func unregister(_ invoke: Invoke) {
        DispatchQueue.main.async {
            UIApplication.shared.unregisterForRemoteNotifications()
        }
        invoke.resolve()
    }

    public override func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let tokenHex = deviceToken.map { String(format: "%02x", $0) }.joined()
        pendingRegisterInvoke?.resolve(["token": tokenHex])
        pendingRegisterInvoke = nil
    }

    public override func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        pendingRegisterInvoke?.reject(error.localizedDescription)
        pendingRegisterInvoke = nil
    }
}

@_cdecl("init_plugin_charm_push")
func initPlugin() -> Plugin {
    return PushPlugin()
}
