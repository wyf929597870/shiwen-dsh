package io.github.wyf929597870.shiwen.network

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

/** One encrypted registry; credentials and profile bodies never appear in list(). */
internal class NodeSettingsStore(context: Context, private val namespace: String = "shiwen-nodes") {
    private val prefs = context.applicationContext.getSharedPreferences(namespace, Context.MODE_PRIVATE)
    private val alias = "$namespace-aes"
    private val lock = locks.getOrPut(namespace) { Any() }
    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun read(): JSONObject {
        val raw = prefs.getString("encrypted", null) ?: return JSONObject().put("items", JSONArray())
        try {
            val envelope = JSONObject(raw)
            val key = keyStore().getKey(alias, null) as? SecretKey ?: error("KEY_UNAVAILABLE")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, decode(envelope.getString("iv"))))
            cipher.updateAAD(namespace.toByteArray())
            return JSONObject(String(cipher.doFinal(decode(envelope.getString("data"))), Charsets.UTF_8))
        } catch (_: Exception) { error("NODE_SETTINGS_UNAVAILABLE") }
    }
    private fun write(value: JSONObject) {
        val key = keyStore().getKey(alias, null) as? SecretKey ?: KeyGenerator.getInstance("AES", "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build()); generateKey()
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key); cipher.updateAAD(namespace.toByteArray())
        val envelope = JSONObject().put("iv", encode(cipher.iv)).put("data", encode(cipher.doFinal(value.toString().toByteArray())))
        check(prefs.edit().putString("encrypted", envelope.toString()).commit()) { "NODE_SETTINGS_SAVE_FAILED" }
    }
    private fun rows(value: JSONObject): List<JSONObject> = value.getJSONArray("items").let { a -> (0 until a.length()).map(a::getJSONObject) }
    fun get(id: String): JSONObject = synchronized(lock) { rows(read()).find { it.getString("id") == id } ?: error("NODE_NOT_FOUND") }
    fun list(): JSONObject = synchronized(lock) {
        val value = read()
        JSONObject().put("activeId", value.opt("activeId") ?: JSONObject.NULL).put("items", JSONArray(rows(value).map { row ->
            JSONObject().apply { for (key in listOf("id", "name", "baseUrl", "allowPrivateHttp", "authenticated", "lastCheckedAt", "profileSyncStatus", "profileUpdatedAt", "configRevision"))
                put(key, row.opt(key) ?: JSONObject.NULL)
                val profile = row.optJSONObject("profile")
                put("profileRevision", profile?.optString("revision") ?: JSONObject.NULL)
                put("profileMemoryCount", profile?.optJSONArray("memories")?.length() ?: 0)
                put("refreshing", NodeConnection.isRefreshing(row.getString("id")))
            }
        }))
    }
    fun save(id: String?, name: String, baseUrl: String, allowPrivateHttp: Boolean): JSONObject = synchronized(lock) {
        require(name.trim().isNotEmpty() && name.length <= 80) { "INVALID_NODE_NAME" }
        val normalized = normalizeUrl(baseUrl, allowPrivateHttp)
        val value = read(); val rows = rows(value).toMutableList()
        val old = id?.let { key -> rows.find { it.getString("id") == key } ?: error("NODE_NOT_FOUND") }
        require(rows.size < 32 || old != null) { "TOO_MANY_NODES" }
        val row = if (old?.getString("baseUrl") == normalized) old else JSONObject().put("id", id ?: UUID.randomUUID().toString())
            .put("authenticated", false).put("cookies", JSONArray()).put("profileSyncStatus", "not-synced")
        row.put("name", name.trim()).put("baseUrl", normalized).put("allowPrivateHttp", allowPrivateHttp)
            .put("configRevision", UUID.randomUUID().toString())
        rows.removeAll { it.optString("id") == row.getString("id") }; rows.add(row)
        value.put("items", JSONArray(rows)); write(value); row
    }
    /** A response for an address edited in the meantime cannot update the new node. */
    fun update(id: String, expectedUrl: String, expectedRevision: String? = null, patch: (JSONObject) -> Unit) = synchronized(lock) {
        val value = read(); val row = rows(value).find { it.getString("id") == id } ?: error("NODE_NOT_FOUND")
        check(row.getString("baseUrl") == expectedUrl && (expectedRevision == null || row.optString("configRevision") == expectedRevision)) { "NODE_CHANGED" }
        patch(row); write(value)
    }
    fun select(id: String?) = synchronized(lock) {
        val value = read()
        if (!id.isNullOrBlank()) check(rows(value).any { it.getString("id") == id }) { "NODE_NOT_FOUND" }
        value.put("activeId", id?.takeIf { it.isNotBlank() } ?: JSONObject.NULL); write(value)
    }
    fun remove(id: String) = synchronized(lock) {
        val value = read(); value.put("items", JSONArray(rows(value).filterNot { it.getString("id") == id }))
        if (value.optString("activeId") == id) value.put("activeId", JSONObject.NULL)
        write(value)
    }
    fun selectedProfile(): JSONObject? = synchronized(lock) {
        val value = read(); val id = value.optString("activeId").takeUnless { it.isBlank() || it == "null" } ?: return@synchronized null
        check(!NodeConnection.isRefreshing(id)) { "PROFILE_REFRESHING" }
        val row = rows(value).find { it.getString("id") == id } ?: error("NODE_NOT_FOUND")
        val profile = row.optJSONObject("profile") ?: error("PROFILE_NOT_SYNCED")
        JSONObject(profile.toString()).put("nodeId", id)
    }
    fun clearForTest() = synchronized(lock) { prefs.edit().clear().commit(); keyStore().deleteEntry(alias) }
    companion object {
        private val locks = java.util.concurrent.ConcurrentHashMap<String, Any>()
        fun normalizeUrl(value: String, allowPrivateHttp: Boolean): String {
            require(value.length <= 2048) { "INVALID_NODE_URL" }
            val url = value.trim().toHttpUrlOrNull() ?: error("INVALID_NODE_URL")
            require(url.username.isEmpty() && url.password.isEmpty() && url.encodedPath == "/" && url.query == null && url.fragment == null) { "NODE_ORIGIN_REQUIRED" }
            require(url.isHttps || allowPrivateHttp) { "HTTP_REQUIRES_EXPLICIT_CONSENT" }
            return url.toString()
        }
        private fun encode(value: ByteArray) = Base64.encodeToString(value, Base64.NO_WRAP)
        private fun decode(value: String) = Base64.decode(value, Base64.NO_WRAP)
    }
}
