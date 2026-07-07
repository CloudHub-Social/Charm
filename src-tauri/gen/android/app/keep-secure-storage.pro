# SecureStorage is only reached via JNI string-based lookup from Rust
# (matrix::secret_store::android), never a normal Kotlin/Java call site, so
# R8 has nothing telling it the class/methods are used and would otherwise
# strip or rename them in a minified release build, breaking every
# secret-store call at runtime. @Keep on the class covers this already;
# this rule is a second, build-config-level backstop in case @Keep
# processing is ever skipped (e.g. a consumer/lint config change).
-keep class social.cloudhub.charm.SecureStorage {
    *;
}
