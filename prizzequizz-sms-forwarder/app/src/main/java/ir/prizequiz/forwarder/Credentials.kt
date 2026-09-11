package ir.prizequiz.forwarder

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * THE DEVICE'S IDENTITY.
 *
 * The secret signs every deposit this phone reports, so it is the one thing
 * on here worth stealing. It lives in EncryptedSharedPreferences — backed by
 * the Android keystore — rather than plain preferences, and `allowBackup` is
 * off in the manifest so it never rides out in a cloud backup.
 *
 * It is written exactly once, at pairing, and never read back off the device.
 * Losing it is not a recoverable state and is not meant to be: the operator
 * revokes the device in the panel and pairs again, which takes a minute and
 * leaves a clean audit trail.
 */
class Credentials(context: Context) {

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "forwarder-identity",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    val deviceId: String? get() = prefs.getString(KEY_DEVICE, null)
    val secret: String? get() = prefs.getString(KEY_SECRET, null)
    val isPaired: Boolean get() = !deviceId.isNullOrBlank() && !secret.isNullOrBlank()

    fun save(deviceId: String, secret: String) {
        prefs.edit().putString(KEY_DEVICE, deviceId).putString(KEY_SECRET, secret).apply()
    }

    /** Used when the server says it no longer knows us — a revoked device. */
    fun clear() {
        prefs.edit().remove(KEY_DEVICE).remove(KEY_SECRET).apply()
    }

    private companion object {
        const val KEY_DEVICE = "device_id"
        const val KEY_SECRET = "secret"
    }
}
