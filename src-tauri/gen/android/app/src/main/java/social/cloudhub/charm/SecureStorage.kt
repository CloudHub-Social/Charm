package social.cloudhub.charm

import android.content.Context
import android.content.SharedPreferences
import androidx.annotation.Keep
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Backs `matrix::secret_store`'s Android implementation (see
 * `src-tauri/src/matrix/secret_store.rs`), called via JNI. Values are stored
 * in `EncryptedSharedPreferences`, encrypted with an AES-256-GCM key that
 * `MasterKey` generates and holds inside the Android Keystore — the actual
 * key material never leaves the Keystore (encrypt/decrypt operations are
 * performed by it, not with a key we ever see in plaintext), matching what
 * `keyring`'s macOS/Windows/Linux backends already guarantee there.
 *
 * One `SharedPreferences` file per `service` (Charm only ever uses one:
 * `social.cloudhub.charm`), with `account` as the key within it — mirroring
 * `keyring::Entry`'s own (service, account) addressing.
 *
 * `@Keep`: every entry point here is reached only via JNI string-based lookup
 * from the Rust side (`secret_store.rs`), never a normal Kotlin/Java call
 * site, so R8 has no reference to see in a minified release build and would
 * otherwise strip or rename this class.
 */
@Keep
object SecureStorage {
    // EncryptedSharedPreferences is not thread-safe, and calls arrive from
    // whatever Tokio worker thread happens to attach to the JVM for a given
    // secret_store call — so both instance creation and every read/write
    // below are synchronized on this lock. Cached per service so repeated
    // get/set/delete (the common path — passphrase and session lookups)
    // don't re-run MasterKey/EncryptedSharedPreferences setup each time.
    private val lock = Any()
    private val cache = HashMap<String, SharedPreferences>()

    private fun preferencesFileName(service: String): String = "secure_store_$service"

    private fun preferences(context: Context, service: String): SharedPreferences =
        synchronized(lock) {
            cache.getOrPut(service) {
                val masterKey = MasterKey.Builder(context.applicationContext)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()
                EncryptedSharedPreferences.create(
                    context.applicationContext,
                    preferencesFileName(service),
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                )
            }
        }

    /** Returns the stored value for (`service`, `account`), or `null` if there isn't one. */
    @JvmStatic
    fun get(context: Context, service: String, account: String): String? =
        synchronized(lock) {
            preferences(context, service).getString(account, null)
        }

    /**
     * Writes synchronously (`commit()`, not `apply()`) so the caller only
     * gets control back once the value is actually on disk — the Rust side
     * treats this call as durable the moment it returns (e.g. writing a
     * freshly generated SQLCipher passphrase immediately before using it to
     * create the store it protects), and `apply()`'s async flush left a
     * window where a process kill could lose a passphrase that was already
     * used to encrypt a store, making it permanently unrecoverable.
     */
    @JvmStatic
    fun set(context: Context, service: String, account: String, value: String) {
        synchronized(lock) {
            check(preferences(context, service).edit().putString(account, value).commit()) {
                "SecureStorage.set: SharedPreferences.commit() returned false for $service/$account"
            }
        }
    }

    /** No-ops if (`service`, `account`) has nothing stored — matches `keyring`'s delete semantics on other platforms, where callers already tolerate a missing entry. */
    @JvmStatic
    fun delete(context: Context, service: String, account: String) {
        synchronized(lock) {
            preferences(context, service).edit().remove(account).commit()
        }
    }
}
