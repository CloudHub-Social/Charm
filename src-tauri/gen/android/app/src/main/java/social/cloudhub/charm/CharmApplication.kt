package social.cloudhub.charm

import android.app.Application
import io.sentry.SentryOptions.BeforeBreadcrumbCallback
import io.sentry.SentryOptions.BeforeSendCallback
import io.sentry.android.core.SentryAndroid
import org.json.JSONObject
import java.io.File

class CharmApplication : Application() {
    private var cachedSentryConsentFile: File? = null
    private var cachedSentryConsentLastModified: Long = Long.MIN_VALUE
    private var cachedSentryConsentEnabled: Boolean = false

    override fun onCreate() {
        super.onCreate()
        initializeSentryIfConsented()
    }

    private fun initializeSentryIfConsented() {
        val dsn = BuildConfig.SENTRY_DSN.takeIf { it.isNotBlank() } ?: return
        if (!sentryEnabledFromStore()) return

        SentryAndroid.init(this) { options ->
            options.setDsn(dsn)
            options.setEnvironment(BuildConfig.SENTRY_ENVIRONMENT.takeIf { it.isNotBlank() })
            BuildConfig.SENTRY_RELEASE.takeIf { it.isNotBlank() }?.let { options.setRelease(it) }
            options.setSendDefaultPii(false)
            options.setSendClientReports(false)
            options.setTracesSampleRate(0.0)
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
        val file = listOf(
            File(applicationInfo.dataDir, "observability.json"),
            File(filesDir, "observability.json"),
        ).firstOrNull { it.isFile }
        if (file == null) {
            cachedSentryConsentFile = null
            cachedSentryConsentLastModified = Long.MIN_VALUE
            cachedSentryConsentEnabled = false
            return false
        }
        val lastModified = file.lastModified()
        if (file == cachedSentryConsentFile && lastModified == cachedSentryConsentLastModified) {
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
        cachedSentryConsentLastModified = lastModified
        cachedSentryConsentEnabled = enabled
        return enabled
    }
}
