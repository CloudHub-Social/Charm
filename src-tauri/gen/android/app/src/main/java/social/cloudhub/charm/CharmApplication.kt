package social.cloudhub.charm

import android.app.Application
import android.os.FileObserver
import io.sentry.SentryOptions.BeforeBreadcrumbCallback
import io.sentry.SentryOptions.BeforeSendCallback
import io.sentry.android.core.SentryAndroid
import org.json.JSONObject
import java.io.File

class CharmApplication : Application() {
    @Volatile
    private var sentryConsentEnabled: Boolean = false
    private val sentryConsentObservers = mutableListOf<FileObserver>()

    override fun onCreate() {
        super.onCreate()
        initializeSentryIfConsented()
    }

    private fun initializeSentryIfConsented() {
        val dsn = BuildConfig.SENTRY_DSN.takeIf { it.isNotBlank() } ?: return
        sentryConsentEnabled = readSentryEnabledFromStore()
        startSentryConsentObservers()
        if (!sentryConsentEnabled) return

        SentryAndroid.init(this) { options ->
            options.setDsn(dsn)
            BuildConfig.SENTRY_ENVIRONMENT.takeIf { it.isNotBlank() }?.let { options.setEnvironment(it) }
            BuildConfig.SENTRY_RELEASE.takeIf { it.isNotBlank() }?.let { options.setRelease(it) }
            options.setSendDefaultPii(false)
            options.setSendClientReports(false)
            options.setEnableNdk(false)
            // Leave tracesSampleRate unset; 0.0 still enables tracing instrumentation overhead.
            options.setEnableAutoSessionTracking(false)
            options.setBeforeBreadcrumb(BeforeBreadcrumbCallback { breadcrumb, _ ->
                if (sentryConsentEnabled) breadcrumb else null
            })
            options.setBeforeSend(BeforeSendCallback { event, _ ->
                if (sentryConsentEnabled) event else null
            })
        }
    }

    private fun startSentryConsentObservers() {
        val mask = FileObserver.CLOSE_WRITE or
            FileObserver.CREATE or
            FileObserver.DELETE or
            FileObserver.MODIFY or
            FileObserver.MOVED_FROM or
            FileObserver.MOVED_TO
        listOf(File(applicationInfo.dataDir), filesDir)
            .distinctBy { it.absolutePath }
            .forEach { directory ->
                @Suppress("DEPRECATION")
                val observer = object : FileObserver(directory.absolutePath, mask) {
                    override fun onEvent(event: Int, path: String?) {
                        if (path == null || path == "observability.json") {
                            sentryConsentEnabled = readSentryEnabledFromStore()
                        }
                    }
                }
                observer.startWatching()
                sentryConsentObservers.add(observer)
            }
    }

    private fun readSentryEnabledFromStore(): Boolean {
        val appDataFile = File(applicationInfo.dataDir, "observability.json")
        val file = if (appDataFile.isFile) {
            appDataFile
        } else {
            File(filesDir, "observability.json").takeIf { it.isFile }
        }
        if (file == null) return false

        return runCatching {
            val root = JSONObject(file.readText(Charsets.UTF_8))
            val state = root.optJSONObject("observability")?.optJSONObject("state")
                ?: root.optJSONObject("state")
                ?: root.optJSONObject("observability")

            state?.optBoolean("sentryEnabled", false) == true
        }.getOrDefault(false)
    }
}
