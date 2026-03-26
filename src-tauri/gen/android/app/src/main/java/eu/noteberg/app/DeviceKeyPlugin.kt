package eu.noteberg.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.util.Base64
import java.security.SecureRandom

/**
 * Secure credential storage for Android using Android Keystore + SharedPreferences.
 *
 * Replaces tauri-plugin-stronghold on Android (which cannot be cross-compiled from
 * Windows due to libsodium C dependency). A hardware-backed AES-256-GCM key in the
 * Android Keystore encrypts each credential value stored in SharedPreferences.
 *
 * Commands:
 *   saveCredential(key, value)  — encrypt and persist a string credential
 *   getCredential(key)          — decrypt and return { value: string|null }
 *   deleteCredential(key)       — remove a credential
 */

private const val KEYSTORE_ALIAS = "noteberg_credential_key_v1"
private const val PREFS_NAME = "noteberg_secure_credentials"

@TauriPlugin
class DeviceKeyPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    @Command
    fun saveCredential(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val key = args.getString("key") ?: return invoke.reject("missing key")
            val value = args.getString("value") ?: return invoke.reject("missing value")

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))

            activity.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
                .edit()
                .putString("enc_$key", Base64.encodeToString(encrypted, Base64.DEFAULT))
                .putString("iv_$key", Base64.encodeToString(cipher.iv, Base64.DEFAULT))
                .apply()

            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("saveCredential error: ${e.message}")
        }
    }

    @Command
    fun getCredential(invoke: Invoke) {
        try {
            val key = invoke.getArgs().getString("key") ?: return invoke.reject("missing key")
            val prefs = activity.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
            val encB64 = prefs.getString("enc_$key", null)
            val ivB64 = prefs.getString("iv_$key", null)

            val result = JSObject()
            if (encB64 == null || ivB64 == null) {
                // No stored value — resolve with null sentinel so JS can detect absence
                invoke.resolve(result)
                return
            }

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(128, Base64.decode(ivB64, Base64.DEFAULT))
            )
            val decrypted = cipher.doFinal(Base64.decode(encB64, Base64.DEFAULT))
            result.put("value", String(decrypted, Charsets.UTF_8))
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("getCredential error: ${e.message}")
        }
    }

    @Command
    fun deleteCredential(invoke: Invoke) {
        try {
            val key = invoke.getArgs().getString("key") ?: return invoke.reject("missing key")
            activity.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
                .edit()
                .remove("enc_$key")
                .remove("iv_$key")
                .apply()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("deleteCredential error: ${e.message}")
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keyStore.containsAlias(KEYSTORE_ALIAS)) {
            return (keyStore.getEntry(KEYSTORE_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
        }
        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        keyGen.init(
            KeyGenParameterSpec.Builder(
                KEYSTORE_ALIAS,
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
