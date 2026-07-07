import UserNotifications

/// Spec 11's iOS background-decrypt path — the counterpart to Android's
/// `PushMessagingReceiver` JNI bridge, but structurally different: an NSE
/// runs as a **separate process** in its own sandbox with no Tauri runtime
/// at all (no `AppHandle`, no running Rust `Client`), so it can't go through
/// `push::handle_push` or the `PushPlugin` mobile-plugin bridge the main app
/// uses. It links the same Rust static lib directly and calls into it via a
/// bare C entrypoint instead — same "native code calls a C-exported Rust
/// function" shape as `push::ios`'s `charm_ios_on_device_token`, just from a
/// different binary.
///
/// **This file is a structural placeholder, not yet wired to a working Rust
/// entrypoint.** What's real: the APNs registration/pusher-registration path
/// in `push::ios` (main app process, no App Group needed). What's still
/// missing before this NSE can actually decrypt anything:
///
/// 1. A Rust C entrypoint (e.g. `charm_ios_nse_decrypt`) that takes an App
///    Group container path + room id + event id, restores a client
///    (`persistence::known_account_keys_at` / `store_path_at` /
///    `get_or_create_passphrase` are already `AppHandle`-free and reusable
///    as-is), fetches+decrypts the event, evaluates push rules, and returns
///    a title/body pair (or a generic-fallback signal) — essentially
///    `push::handle_push`'s logic minus the `tauri_plugin_notification` fire
///    at the end, since here the *caller* (this file) mutates
///    `UNMutableNotificationContent` instead.
/// 2. `persistence::matrix_store_root` needs an iOS-specific override to put
///    the main app's SQLCipher store under the shared App Group container
///    (`FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:)`)
///    instead of the app's own sandboxed `app_data_dir` — otherwise this
///    extension has no store to open at all. Today it does not; the main
///    app's `com.apple.security.application-groups` entitlement is in place
///    (`charm_iOS.entitlements`) but nothing writes into that container yet.
/// 3. This target itself needs to be added to the Xcode project (File > New
///    > Target > Notification Service Extension) with a matching
///    `com.apple.security.application-groups` +
///    `keychain-access-groups` entitlements file, linking against the same
///    Rust static lib the main app links. Hand-editing `project.pbxproj`
///    blind (no Xcode available in this environment to validate the result)
///    risks silently corrupting the whole iOS project, so that step is left
///    as a manual one-time task rather than attempted here.
///
/// Until all three land, incoming pushes on iOS fall back to APNs' own
/// unmodified alert content (whatever minimal `aps.alert` the gateway sent —
/// nothing decrypted, nothing rich) rather than crashing or hanging.
class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        guard let bestAttemptContent = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        // TODO(Spec 11 follow-up): once `charm_ios_nse_decrypt` exists, parse
        // `roomId`/`eventId` out of `request.content.userInfo["notification"]`
        // (the same `event_id_only` shape Sygnal posts on Android), call it,
        // and set `bestAttemptContent.title`/`.body` from the result —
        // falling back to a generic body (never raw ciphertext) exactly like
        // `push::handle_push`'s UTD path does on Android.
        contentHandler(bestAttemptContent)
    }

    /// Called by iOS shortly before its extension time budget runs out — the
    /// generic system-provided content is shown as-is rather than nothing at
    /// all being shown.
    override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }
}
