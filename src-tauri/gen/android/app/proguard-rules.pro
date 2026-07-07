# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Tink (pulled in transitively by androidx.security:security-crypto and
# org.unifiedpush.android:connector) references JSR-305 annotations that are
# compile-only and never shipped at runtime, so R8 can't find them. They're
# annotations with no runtime behavior to preserve — safe to silence rather
# than keep.
-dontwarn javax.annotation.Nullable
-dontwarn javax.annotation.concurrent.GuardedBy