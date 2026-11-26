package io.github.wyf929597870.shiwen.agent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
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

    // The first entry is the default. A revision identifies the exact endpoint/model/key snapshot.
    private fun entries(): List<ModelConfig> {
        val stored = preferences.getString("encrypted", null) ?: return emptyList()
        try {
            val envelope = JSONObject(stored)
            val key = keyStore.getKey(alias, null) as? SecretKey ?: error("KEY_UNAVAILABLE")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, decode(envelope.getString("iv"))))
            cipher.updateAAD(namespace.toByteArray(Charsets.UTF_8))
            val value = JSONObject(String(cipher.doFinal(decode(envelope.getString("data"))), Charsets.UTF_8))
            val rows = if (value.has("models")) value.getJSONArray("models") else JSONArray().put(value)
            return (0 until rows.length()).map { index ->
                val row = rows.getJSONObject(index)
                ModelConfig(row.getString("name"), row.getString("baseUrl"), row.getString("model"),
                    row.getString("apiKey"), row.getString("revision"))
            }
        } catch (_: Exception) { error("MODEL_CONFIG_UNAVAILABLE") }
    }

    @Synchronized fun read(): ModelConfig? = entries().firstOrNull()
    @Synchronized fun get(revision: String): ModelConfig =
        entries().firstOrNull { it.revision == revision } ?: error("MODEL_CONFIG_CHANGED")

    @Synchronized fun catalog(): JSONObject {
        val models = entries()
        val result = models.firstOrNull()?.publicJson() ?: JSONObject().put("configured", false)
        return result.put("models", JSONArray(models.map { it.publicJson() }))
    }

    @Synchronized fun save(name: String, baseUrl: String, model: String, newKey: String): ModelConfig =
        saveEntry(read()?.revision, name, baseUrl, model, newKey)

    @Synchronized fun saveEntry(revision: String?, name: String, baseUrl: String, model: String, newKey: String): ModelConfig =
        saveModels(revision, name, baseUrl, listOf(model), newKey).first()

    @Synchronized fun saveModels(revision: String?, name: String, baseUrl: String, modelIds: List<String>, newKey: String): List<ModelConfig> {
        val provider = name.trim()
        require(provider.isNotEmpty() && provider.length <= 80) { "INVALID_PROVIDER_NAME" }
        val ids = modelIds.map(String::trim).distinct()
        require(ids.isNotEmpty() && ids.all { it.length in 1..200 && it.none(Char::isISOControl) }) { "INVALID_MODEL" }
        val normalized = normalizeUrl(baseUrl)
        val models = entries().toMutableList()
        val index = models.indexOfFirst { it.revision == revision }
        check(revision == null || index >= 0) { "MODEL_CONFIG_CHANGED" }
        val old = models.getOrNull(index)
        val key = endpointKey(old, normalized, newKey)
        // Keep the original session binding when the edited model remains selected.
        val editedId = old?.model?.takeIf { it in ids } ?: ids.first()
        val next = ids.map { id ->
            val editing = index >= 0 && id == editedId
            val existing = if (editing) old else models.firstOrNull { it.name == provider &&
                it.baseUrl == normalized && it.model == id && it.apiKey == key }
            if (existing != null && existing.name == provider && existing.model == id &&
                existing.baseUrl == normalized && existing.apiKey == key) existing
            else ModelConfig(provider, normalized, id, key, UUID.randomUUID().toString()).also {
                if (editing) models[index] = it else models.add(it)
            }
        }
        persist(models)
        return next
    }

    @Synchronized fun makeDefault(revision: String) {
        val models = entries()
        val selected = models.firstOrNull { it.revision == revision } ?: error("MODEL_CONFIG_CHANGED")
        if (selected != models.first()) persist(listOf(selected) + models.filterNot { it === selected })
    }

    @Synchronized fun remove(revision: String) {
        val models = entries()
        val remaining = models.filterNot { it.revision == revision }
        check(remaining.size < models.size) { "MODEL_CONFIG_CHANGED" }
        if (remaining.isEmpty()) clear() else persist(remaining)
    }

    private fun persist(models: List<ModelConfig>) {
        val key = keyStore.getKey(alias, null) as? SecretKey ?: KeyGenerator.getInstance("AES", "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
            generateKey()
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(namespace.toByteArray(Charsets.UTF_8))
        val rows = JSONArray(models.map { it.publicJson().put("apiKey", it.apiKey) })
        val payload = JSONObject().put("models", rows).toString().toByteArray(Charsets.UTF_8)
        val envelope = JSONObject().put("iv", encode(cipher.iv)).put("data", encode(cipher.doFinal(payload)))
        check(preferences.edit().putString("encrypted", envelope.toString()).commit()) { "MODEL_CONFIG_SAVE_FAILED" }
    }
    @Synchronized fun clear() {
        check(preferences.edit().clear().commit()) { "MODEL_CONFIG_SAVE_FAILED" }
        keyStore.deleteEntry(alias)
    }
    companion object {
        fun endpointKey(old: ModelConfig?, normalized: String, newKey: String): String {
            val key = newKey.trim().ifEmpty {
                check(old != null && old.baseUrl == normalized) { "API_KEY_REQUIRED_FOR_ENDPOINT" }
                old.apiKey
            }
            require(key.length in 1..4096 && key.all { it.code in 32..126 }) { "INVALID_API_KEY" }
            return key
        }
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
