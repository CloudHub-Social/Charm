package social.cloudhub.charm

import android.content.BroadcastReceiver
import android.content.Context
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.MessagingReceiver
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * UnifiedPush callback receiver (exposed via the four
 * `org.unifiedpush.android.connector.*` intent actions in
 * `AndroidManifest.xml`) — forwards every event straight into the Rust core
 * over JNI (`Java_social_cloudhub_charm_PushMessagingReceiver_native*` in
 * `src-tauri/src/push/android.rs`), which is the only place that decides what
 * to do with them. Kept a thin pass-through by design: the actual
 * registration bookkeeping, decrypt pipeline, and notification-building all
 * live in Rust so there's exactly one implementation of each, not a
 * Kotlin-side copy plus a Rust-side copy.
 */
class PushMessagingReceiver : MessagingReceiver() {
    external fun nativeOnNewEndpoint(
        endpoint: String,
        viaFcm: Boolean,
    )

    external fun nativeOnRegistrationFailed(reason: String)

    external fun nativeOnUnregistered()

    external fun nativeOnMessage(
        context: Context,
        pendingResult: BroadcastReceiver.PendingResult,
        payloadJson: String,
    )

    override fun onNewEndpoint(
        context: Context,
        endpoint: PushEndpoint,
        instance: String,
    ) {
        val viaFcm = PushBridge.currentDistributor(context) == context.packageName
        nativeOnNewEndpoint(endpoint.url, viaFcm)
    }

    override fun onRegistrationFailed(
        context: Context,
        reason: FailedReason,
        instance: String,
    ) {
        nativeOnRegistrationFailed(reason.toString())
    }

    override fun onUnregistered(
        context: Context,
        instance: String,
    ) {
        nativeOnUnregistered()
    }

    /**
     * `message.content` is the raw bytes the distributor delivered — since
     * Charm registers with no VAPID key (see `PushBridge`'s doc comment),
     * `decrypted` is always `false` here and `content` is exactly the
     * `event_id_only` JSON body Sygnal posted, UTF-8 decoded as-is.
     */
    override fun onMessage(
        context: Context,
        message: PushMessage,
        instance: String,
    ) {
        nativeOnMessage(
            context.applicationContext,
            goAsync(),
            String(message.content, Charsets.UTF_8),
        )
    }

    companion object {
        init {
            System.loadLibrary("charm_lib")
        }
    }
}
