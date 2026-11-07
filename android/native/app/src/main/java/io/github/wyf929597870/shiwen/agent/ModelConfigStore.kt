package io.github.wyf929597870.shiwen.agent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class ModelConfig(val name: String, val baseUrl: String, val model: String,
    val apiKey: String, val revision: String) {
    // Deliberately no data-class toString/copy exposing credentials in logs.
    fun publicJson() = JSONObject().put("name", name).put("baseUrl", baseUrl)
        .put("model", model).put("revision", revision).put("configured", true)
}

/** Uses Android's AES/GCM implementation and non-exportable Keystore key. No secret JS getter. */
internal class ModelConfigStore(context: Context, private val namespace: String = "shiwen-model-config") {
    private val preferences = context.applicationContext.getSharedPreferences(namespace, Context.MODE_PRIVATE)
    private val alias = "$namespace-aes"
    private val keyStore get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Synchronized fun read(): ModelConfig? {
        val stored = preferences.getString("encrypted", null) ?: return null
        try {
            val envelope = JSONObject(stored)
            val key = keyStore.getKey(alias, null) as? SecretKey ?: error("KEY_UNAVAILABLE")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, decode(envelope.getString("iv"))))
            cipher.updateAAD(namespace.toByteArray(Charsets.UTF_8))
            val value = JSONObject(String(cipher.doFinal(decode(envelope.getString("data"))), Charsets.UTF_8))
            return ModelConfig(value.getString("name"), value.getString("baseUrl"), value.getString("model"),
                value.getString("apiKey"), value.getString("revision"))
        } catch (_: Exception) { error("MODEL_CONFIG_UNAVAILABLE") }
    }

    @Synchronized fun save(name: String, baseUrl: String, model: String, newKey: String): ModelConfig {
        require(name.trim().isNotEmpty() && name.length <= 80) { "INVALID_PROVIDER_NAME" }
        require(model.trim().isNotEmpty() && model.length <= 200 && model.none { it.isISOControl() }) { "INVALID_MODEL" }
        val normalized = normalizeUrl(baseUrl)
        val old = read()
        val keyText = newKey.trim().ifEmpty {
            check(old != null && old.baseUrl == normalized) { "API_KEY_REQUIRED_FOR_ENDPOINT" }
            old.apiKey
        }
        require(keyText.length in 1..4096 && keyText.none { it.isISOControl() }) { "INVALID_API_KEY" }
        val next = ModelConfig(name.trim(), normalized, model.trim(), keyText, UUID.randomUUID().toString())
        val key = keyStore.getKey(alias, null) as? SecretKey ?: KeyGenerator.getInstance("AES", "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
            generateKey()
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(namespace.toByteArray(Charsets.UTF_8))
        val payload = next.publicJson().put("apiKey", keyText).toString().toByteArray(Charsets.UTF_8)
        val envelope = JSONObject().put("iv", encode(cipher.iv)).put("data", encode(cipher.doFinal(payload)))
        check(preferences.edit().putString("encrypted", envelope.toString()).commit()) { "MODEL_CONFIG_SAVE_FAILED" }
        return next
    }
    @Synchronized fun clear() {
        check(preferences.edit().clear().commit()) { "MODEL_CONFIG_SAVE_FAILED" }
        keyStore.deleteEntry(alias)
    }
    companion object {
        fun normalizeUrl(value: String): String {
            require(value.length <= 2048) { "INVALID_MODEL_URL" }
            val url = value.trim().toHttpUrlOrNull() ?: error("INVALID_MODEL_URL")
            require(url.scheme == "https" && url.username.isEmpty() && url.password.isEmpty()
                && url.query == null && url.fragment == null) { "MODEL_URL_REQUIRES_HTTPS" }
            return url.toString().trimEnd('/') + "/"
        }
        private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
        private fun decode(value: String) = Base64.decode(value, Base64.NO_WRAP)
    }
}
