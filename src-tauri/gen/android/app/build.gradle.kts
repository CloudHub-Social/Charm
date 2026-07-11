import io.sentry.android.gradle.extensions.SentryPluginExtension
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Spec 11's embedded-FCM push fallback needs a real Firebase project —
// `google-services.json` isn't checked in yet (Firebase project pending on
// the CloudHub-Social side). Applying the Google Services plugin
// unconditionally would break every Android build/CI run until that file
// exists; gate on its presence instead, same "conditional on an optional
// local file" shape as `tauriProperties` above. Once the real file lands at
// `app/google-services.json`, this starts applying with no other change
// needed.
val hasGoogleServicesConfig = file("google-services.json").exists()
if (hasGoogleServicesConfig) {
    apply(plugin = "com.google.gms.google-services")
}

fun requiredSentryEnv(name: String): String =
    System.getenv(name) ?: error("$name is required when SENTRY_ANDROID_UPLOAD=true")

fun buildConfigString(value: String): String =
    "\"${
        value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
    }\""

val sentryAndroidUpload = System.getenv("SENTRY_ANDROID_UPLOAD") == "true"
if (sentryAndroidUpload) {
    apply(plugin = "io.sentry.android.gradle")
    configure<SentryPluginExtension> {
        org.set(requiredSentryEnv("SENTRY_ORG"))
        projectName.set(requiredSentryEnv("SENTRY_PROJECT"))
        authToken.set(requiredSentryEnv("SENTRY_AUTH_TOKEN"))
        includeProguardMapping.set(true)
        autoUploadProguardMapping.set(true)
        uploadNativeSymbols.set(true)
        autoUploadNativeSymbols.set(true)
        includeNativeSources.set(true)
        includeSourceContext.set(false)
        includeDependenciesReport.set(false)
        telemetry.set(false)
        tracingInstrumentation {
            enabled.set(false)
        }
        autoInstallation {
            enabled.set(false)
        }
    }
}

android {
    compileSdk = 36
    namespace = "social.cloudhub.charm"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "social.cloudhub.charm"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        buildConfigField(
            "String",
            "SENTRY_DSN",
            buildConfigString(System.getenv("SENTRY_DSN") ?: System.getenv("VITE_SENTRY_DSN") ?: ""),
        )
        buildConfigField(
            "String",
            "SENTRY_ENVIRONMENT",
            buildConfigString(System.getenv("SENTRY_ENVIRONMENT") ?: System.getenv("VITE_SENTRY_ENVIRONMENT") ?: ""),
        )
        buildConfigField(
            "String",
            "SENTRY_RELEASE",
            buildConfigString(System.getenv("SENTRY_RELEASE") ?: System.getenv("VITE_SENTRY_RELEASE") ?: ""),
        )
    }
    // Nightly CI signs the debug build type (not release — that also flips
    // on minify/proguard, a bigger risk surface than a nightly compile-check
    // pipeline should take on) with a persistent keystore when one is
    // configured via ANDROID_RELEASE_STORE_FILE and friends (see
    // nightly-platform-builds.yml's Android job). Without those env vars,
    // `getByName("nightly")`'s fields stay null and nothing references the
    // config, so a local `pnpm tauri android build --debug` is unaffected —
    // it keeps using the Android Gradle Plugin's own auto-generated
    // ~/.android/debug.keystore, same as before this existed.
    //
    // Why this needs to exist at all: without an explicit signingConfig,
    // every CI run signs with a *freshly regenerated* debug keystore (each
    // GitHub Actions runner is a clean VM), so consecutive nightly APKs
    // never share a signing identity. Android refuses to install an update
    // over an existing app when the signature doesn't match, so every
    // nightly forced an uninstall+reinstall instead of an in-place upgrade.
    signingConfigs {
        create("nightly") {
            val storeFilePath = System.getenv("ANDROID_RELEASE_STORE_FILE")
            if (storeFilePath != null) {
                storeFile = file(storeFilePath)
                storePassword = System.getenv("ANDROID_RELEASE_STORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_RELEASE_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_RELEASE_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            if (System.getenv("ANDROID_RELEASE_STORE_FILE") != null) {
                signingConfig = signingConfigs.getByName("nightly")
            }
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // Backs `SecureStorage.kt` (Keystore-backed `EncryptedSharedPreferences`)
    // — `matrix::secret_store`'s Android implementation, called via JNI,
    // stands in for `keyring`'s desktop-only OS-keychain backends there.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("io.sentry:sentry-android:8.48.0")
    // Spec 11: UnifiedPush-first push transport, falling back to the
    // embedded FCM distributor when no external distributor is installed —
    // see `push::android`'s doc comment. Coordinates/versions per each
    // library's own `build.gradle` (checked against
    // github.com/UnifiedPush/android-connector and
    // github.com/UnifiedPush/android-embedded_fcm_distributor at the time
    // this was wired up — re-check unifiedpush.org/developers/android/ before
    // bumping either).
    // connector pulls in the plain com.google.crypto.tink:tink:1.17.0, while
    // androidx.security:security-crypto (above) pulls in
    // com.google.crypto.tink:tink-android:1.8.0 — a different artifact that
    // ships the same classes, so Gradle's duplicate class check fails the
    // build. (embedded-fcm-distributor below only depends on kotlin-stdlib;
    // it was never the source of the conflict.) Exclude the plain variant
    // from connector rather than dropping Tink to security-crypto's much
    // older 1.8.0 — per UnifiedPush's own duplicate-class guidance, force
    // tink-android up to 1.17.0 (the version connector was actually built
    // and tested against) instead, so connector's push
    // registration/decryption code doesn't run against a Tink six versions
    // older than it expects.
    implementation("org.unifiedpush.android:connector:3.0.10") {
        exclude(group = "com.google.crypto.tink", module = "tink")
    }
    implementation("com.google.crypto.tink:tink-android:1.17.0")
    implementation("org.unifiedpush.android:embedded-fcm-distributor:3.0.0-rc1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
