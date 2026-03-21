package eu.noteberg.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.util.Base64
import java.security.SecureRandom

private const val KEY_ALIAS = "noteberg_vault_key_v1"
private const val PREFS_NAME = "noteberg_vault"
private const val PREFS_KEY = "encrypted_vault_key"
private const val PREFS_IV = "encrypted_vault_iv"

/**
 * Manages a random 32-byte vault key protected by the Android Keystore.
 *
 * On first call: generates a random 32-byte key, encrypts it with a hardware-backed
 * AES-256-GCM key from the Android Keystore, stores the ciphertext in SharedPreferences.
 * On subsequent calls: decrypts and returns the stored key.
 *
 * Returns the key as a lowercase hex string.
 */
@TauriPlugin
class DeviceKeyPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    @Command
    fun getOrCreateVaultKey(invoke: Invoke) {
        try {
            val prefs = activity.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
            val encryptedKeyB64 = prefs.getString(PREFS_KEY, null)
            val ivB64 = prefs.getString(PREFS_IV, null)

            val rawKey: ByteArray = if (encryptedKeyB64 != null && ivB64 != null) {
                // Decrypt existing vault key using the Android Keystore AES key
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                val iv = Base64.decode(ivB64, Base64.DEFAULT)
                cipher.init(Cipher.DECRYPT_MODE, getOrCreateKeystoreKey(), GCMParameterSpec(128, iv))
                cipher.doFinal(Base64.decode(encryptedKeyB64, Base64.DEFAULT))
            } else {
                // First launch: generate a new random 32-byte vault key
                val newKey = ByteArray(32).also { SecureRandom().nextBytes(it) }
                // Encrypt with Android Keystore key and persist in SharedPreferences
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKeystoreKey())
                val encrypted = cipher.doFinal(newKey)
                prefs.edit()
                    .putString(PREFS_KEY, Base64.encodeToString(encrypted, Base64.DEFAULT))
                    .putString(PREFS_IV, Base64.encodeToString(cipher.iv, Base64.DEFAULT))
                    .apply()
                newKey
            }

            // Return as lowercase hex string (Rust side decodes with hex::decode)
            invoke.resolve(rawKey.joinToString("") { "%02x".format(it) })
        } catch (e: Exception) {
            invoke.reject("DeviceKeyPlugin error: ${e.message}")
        }
    }

    private fun getOrCreateKeystoreKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (keyStore.getEntry(KEY_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
        }
        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        keyGen.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return keyGen.generateKey()
    }
}
