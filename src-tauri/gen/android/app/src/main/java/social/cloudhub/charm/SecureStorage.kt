package social.cloudhub.charm

import android.content.Context
import android.content.SharedPreferences
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
 */
object SecureStorage {
    private fun preferencesFileName(service: String): String = "secure_store_$service"

    private fun preferences(context: Context, service: String): SharedPreferences {
        val masterKey = MasterKey.Builder(context.applicationContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context.applicationContext,
            preferencesFileName(service),
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /** Returns the stored value for (`service`, `account`), or `null` if there isn't one. */
    @JvmStatic
    fun get(context: Context, service: String, account: String): String? {
        return preferences(context, service).getString(account, null)
    }

    @JvmStatic
    fun set(context: Context, service: String, account: String, value: String) {
        preferences(context, service).edit().putString(account, value).apply()
    }

    /** No-ops if (`service`, `account`) has nothing stored — matches `keyring`'s delete semantics on other platforms, where callers already tolerate a missing entry. */
    @JvmStatic
    fun delete(context: Context, service: String, account: String) {
        preferences(context, service).edit().remove(account).apply()
    }
}
