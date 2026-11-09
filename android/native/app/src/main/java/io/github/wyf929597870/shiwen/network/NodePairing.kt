package io.github.wyf929597870.shiwen.network

import org.json.JSONObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

internal object NodePairing {
    fun pair(store: NodeSettingsStore, text: String, id: String? = null): String {
        require(text.length in 1..8192) { "INVALID_PAIRING" }
        val code = JSONObject(text)
        require(code.getInt("version") == 1) { "PAIRING_VERSION_UNSUPPORTED" }
        val fingerprint = code.getString("fingerprint")
        require(fingerprint.matches(Regex("[a-f0-9]{64}"))) { "INVALID_PAIRING" }
        if (id != null) {
            val old = store.get(id).optString("fingerprint")
            check(old.isEmpty() || old == fingerprint) { "NODE_IDENTITY_MISMATCH" }
        }
        val array = code.getJSONArray("endpoints")
        require(array.length() in 1..16) { "INVALID_PAIRING" }
        val endpoints = (0 until array.length()).map { NodeSettingsStore.normalizeUrl(array.getString(it), false) }.distinct()
        val body = JSONObject().put("id", code.getString("id")).put("secret", code.getString("secret"))
            .toString().toRequestBody("application/json".toMediaType())
        // Probe before consuming the one-use ticket. Lost response requires a new code.
        for (url in endpoints) {
            val client = NodeClient(url, fingerprint = fingerprint, timeoutSeconds = 3)
            try {
                val reachable = runCatching { client.request("/auth/status").execute().use { it.isSuccessful } }.getOrDefault(false)
                if (!reachable) continue
                client.request("/auth/pair", "POST", body).execute().use { response ->
                    check(response.isSuccessful) { "PAIRING_EXPIRED" }
                    val source = response.body?.source() ?: error("PAIRING_RESULT_UNKNOWN")
                    check(!source.request(32769)) { "PAIRING_RESULT_UNKNOWN" }
                    val paired = JSONObject(source.readUtf8())
                    check(paired.getString("fingerprint") == fingerprint) { "NODE_IDENTITY_MISMATCH" }
                    return store.paired(id, code.optString("name", "拾文服务"), fingerprint,
                        listOf(url) + endpoints.filterNot { it == url }, paired.getString("token")).getString("id")
                }
            } finally { client.revoke() }
        }
        error("NODE_OFFLINE")
    }
}
