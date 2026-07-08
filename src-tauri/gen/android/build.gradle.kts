buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
        // Applied only when SENTRY_ANDROID_UPLOAD=true in app/build.gradle.kts.
        // Normal dev/CI Android builds do not run Sentry upload tasks.
        classpath("io.sentry:sentry-android-gradle-plugin:6.14.0")
        // Spec 11: only ever *applied* in app/build.gradle.kts, and only
        // when app/google-services.json exists — see that file's comment.
        // Safe to put the classpath itself here unconditionally; an unapplied
        // plugin jar on the classpath is a no-op.
        classpath("com.google.gms:google-services:4.4.2")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
