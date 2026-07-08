package social.cloudhub.charm

import android.app.Application
import android.util.Log
import io.sentry.SentryOptions.BeforeBreadcrumbCallback
import io.sentry.SentryOptions.BeforeSendCallback
import io.sentry.android.core.SentryAndroid
import org.json.JSONObject
import java.io.File

class CharmApplication : Application() {
    private var cachedSentryConsentFile: File? = null
    private var cachedSentryConsentLastModified: Long = Long.MIN_VALUE
    private var cachedSentryConsentEnabled: Boolean = false
    private var warnedSentryConsentTimestampUnavailable: Boolean = false

    override fun onCreate() {
        super.onCreate()
        initializeSentryIfConsented()
    }

    private fun initializeSentryIfConsented() {
        val dsn = BuildConfig.SENTRY_DSN.takeIf { it.isNotBlank() } ?: return
        if (!sentryEnabledFromStore()) return

        SentryAndroid.init(this) { options ->
            options.setDsn(dsn)
            BuildConfig.SENTRY_ENVIRONMENT.takeIf { it.isNotBlank() }?.let { options.setEnvironment(it) }
            BuildConfig.SENTRY_RELEASE.takeIf { it.isNotBlank() }?.let { options.setRelease(it) }
            options.setSendDefaultPii(false)
            options.setSendClientReports(false)
            // Leave tracesSampleRate unset; 0.0 still enables tracing instrumentation overhead.
            options.setEnableAutoSessionTracking(false)
            options.setBeforeBreadcrumb(BeforeBreadcrumbCallback { breadcrumb, _ ->
                if (sentryEnabledFromStore()) breadcrumb else null
            })
            options.setBeforeSend(BeforeSendCallback { event, _ ->
                if (sentryEnabledFromStore()) event else null
            })
        }
    }

    @Synchronized
    private fun sentryEnabledFromStore(): Boolean {
        val appDataFile = File(applicationInfo.dataDir, "observability.json")
        val file = if (appDataFile.isFile) {
            appDataFile
        } else {
            File(filesDir, "observability.json").takeIf { it.isFile }
        }
        if (file == null) {
            cachedSentryConsentFile = null
            cachedSentryConsentLastModified = Long.MIN_VALUE
            cachedSentryConsentEnabled = false
            return false
        }
        val lastModified = file.lastModified()
        val canUseCachedTimestamp = lastModified > 0L
        if (!canUseCachedTimestamp && !warnedSentryConsentTimestampUnavailable) {
            Log.w("CharmApplication", "Sentry consent cache timestamp unavailable; reading consent file each time")
            warnedSentryConsentTimestampUnavailable = true
        }
        if (
            canUseCachedTimestamp &&
            file == cachedSentryConsentFile &&
            lastModified == cachedSentryConsentLastModified
        ) {
            return cachedSentryConsentEnabled
        }

        val enabled = runCatching {
            val root = JSONObject(file.readText(Charsets.UTF_8))
            val state = root.optJSONObject("observability")?.optJSONObject("state")
                ?: root.optJSONObject("state")
                ?: root.optJSONObject("observability")

            state?.optBoolean("sentryEnabled", false) == true
        }.getOrDefault(false)
        cachedSentryConsentFile = file
        cachedSentryConsentLastModified = if (canUseCachedTimestamp) lastModified else Long.MIN_VALUE
        cachedSentryConsentEnabled = enabled
        return enabled
    }
}
