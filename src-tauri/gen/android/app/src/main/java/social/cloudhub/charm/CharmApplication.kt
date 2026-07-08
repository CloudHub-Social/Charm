package social.cloudhub.charm

import android.app.Application
import io.sentry.SentryOptions.BeforeSendCallback
import io.sentry.android.core.SentryAndroid
import org.json.JSONObject
import java.io.File

class CharmApplication : Application() {
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
            options.setRelease(BuildConfig.SENTRY_RELEASE.takeIf { it.isNotBlank() })
            options.setSendDefaultPii(false)
            options.setTracesSampleRate(0.0)
            options.setEnableAutoSessionTracking(false)
            options.setBeforeSend(BeforeSendCallback { event, _ ->
                if (sentryEnabledFromStore()) event else null
            })
        }
    }

    private fun sentryEnabledFromStore(): Boolean {
        val file = File(filesDir, "observability.json")
        if (!file.isFile) return false

        return runCatching {
            val root = JSONObject(file.readText())
            val state = root.optJSONObject("observability")?.optJSONObject("state")
                ?: root.optJSONObject("state")
                ?: root.optJSONObject("observability")

            state?.optBoolean("sentryEnabled", false) == true
        }.getOrDefault(false)
    }
}
