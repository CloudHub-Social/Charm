package social.cloudhub.charm

import android.content.Context
import androidx.annotation.Keep
import org.unifiedpush.android.connector.UnifiedPush

/**
 * Kotlin half of Spec 11's Android push transport — called from the Rust
 * `push::android` module over JNI (see `secret_store.kt`'s bridge for the
 * same shape: classloader-resolved static methods, no separate JNI
 * registration needed).
 *
 * No VAPID key is supplied to [UnifiedPush.register]: the external-distributor
 * path (this spec's priority — the Sygnal gateway is already live for it)
 * doesn't need one, since Sygnal posts a plain `event_id_only` JSON payload
 * directly to whatever endpoint URL the distributor hands back.
 *
 * **Known gap, embedded-FCM fallback only:** per
 * `org.unifiedpush.android:embedded-fcm-distributor`'s own docs
 * (unifiedpush.org/kdoc/embedded_fcm_distributor/), an app that registers
 * with no VAPID key — as this one does — must additionally expose its own
 * `EmbeddedDistributorReceiver` overriding `gateway` with a server that adds
 * VAPID authorization to FCM's Web Push responses; without it, the library's
 * default `EmbeddedDistributorReceiver` can't complete registration and this
 * fallback path yields no usable endpoint. That gateway doesn't exist yet
 * (it's separate server-side infra, out of scope here) — this fallback is
 * therefore not yet functional. The primary UnifiedPush external-distributor
 * path above is unaffected.
 *
 * `@Keep`: reached only by JNI classloader/method-name lookup (see
 * `push::android::push_bridge_class`), invisible to R8's static analysis —
 * same rationale as `SecureStorage`'s own `@Keep`. Without it, a release
 * build's minification can rename or strip this object and every method on
 * it, and the JNI lookup fails at runtime with no compile-time warning.
 */
@Keep
object PushBridge {
    /**
     * Picks a distributor (whatever the user already has saved, else the
     * external default if exactly one is installed) and requests a new
     * registration for [instance]. If neither resolves — no saved
     * distributor and zero or multiple external ones installed —
     * [UnifiedPush.tryUseCurrentOrDefaultDistributor]'s callback reports
     * `false`, and this falls back to the embedded FCM distributor (bundled
     * via `org.unifiedpush.android:embedded-fcm-distributor`, registered
     * under this app's own package) rather than leaving the user with no
     * push transport at all — see this spec's "graceful fallback / embedded
     * distributor story" risk note.
     *
     * The actual endpoint/token arrives later via
     * [PushMessagingReceiver.onNewEndpoint] — see this spec's note on why
     * that round trip has to be async on the Rust side.
     */
    @JvmStatic
    fun register(
        context: Context,
        instance: String,
    ) {
        UnifiedPush.tryUseCurrentOrDefaultDistributor(context) { usingExternalDistributor ->
            if (!usingExternalDistributor) {
                UnifiedPush.saveDistributor(context, context.packageName)
            }
            UnifiedPush.register(context, instance)
        }
    }

    @JvmStatic
    fun unregister(
        context: Context,
        instance: String,
    ) {
        UnifiedPush.unregister(context, instance)
    }

    /**
     * Every distributor (external or the embedded FCM fallback) currently
     * installed — backs the settings panel's "choose a distributor" picker
     * when more than one external option exists (this spec's frontend
     * section).
     */
    @JvmStatic
    fun availableDistributors(context: Context): Array<String> = UnifiedPush.getDistributors(context).toTypedArray()

    /** Currently saved distributor package name, or `null` if none yet. */
    @JvmStatic
    fun currentDistributor(context: Context): String? = UnifiedPush.getSavedDistributor(context)

    /**
     * Explicit user choice from the settings panel's distributor picker:
     * saves [distributor] and re-registers [instance] against it, which
     * triggers a fresh [PushMessagingReceiver.onNewEndpoint].
     */
    @JvmStatic
    fun selectDistributor(
        context: Context,
        distributor: String,
        instance: String,
    ) {
        UnifiedPush.saveDistributor(context, distributor)
        UnifiedPush.register(context, instance)
    }
}
