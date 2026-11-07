package io.github.wyf929597870.shiwen.network

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** Native-only credential writer. Neither the input nor a raw server response reaches JavaScript. */
internal class ServerSecretSettings(private val store: NodeSettingsStore) {
    fun set(id: String, configRevision: String, namespace: String, path: JSONArray, expectedRevision: Long, secret: String): JSONObject {
        require(namespace.length in 1..256 && expectedRevision >= 0 && path.length() in 1..32) { "INVALID_SECRET_FIELD" }
        require((0 until path.length()).all { path.opt(it) is String && path.getString(it).isNotEmpty() && path.getString(it) !in setOf("__proto__", "constructor", "prototype") }) { "INVALID_SECRET_FIELD" }
        require(secret.length in 1..8192) { "INVALID_SECRET_VALUE" }
        val node = store.get(id); val url = node.getString("baseUrl")
        check(node.getString("configRevision") == configRevision) { "NODE_CHANGED" }
        check(node.optBoolean("authenticated")) { "NODE_AUTH_REQUIRED" }
        val cookies = node.optJSONArray("cookies") ?: JSONArray()
        val client = NodeClient(url, node.optBoolean("allowPrivateHttp"), (0 until cookies.length()).map(cookies::getString)) { next ->
            store.update(id, url, configRevision) { it.put("cookies", JSONArray(next)) }
        }
        try {
            val body = JSONObject().put("method", "mobileManagement").put("args", JSONObject()
                .put("action", "settings.secretSet").put("args", JSONObject().put("ns", namespace).put("path", path)
                    .put("expectedRevision", expectedRevision).put("value", secret)))
            val result = try {
                client.request("/api/shiwen", "POST", body.toString().toRequestBody("application/json".toMediaType())).execute().use { response ->
                    when (response.code) {
                        401 -> return JSONObject().put("status", "rejected").put("code", "NODE_AUTH_REQUIRED")
                        403 -> return JSONObject().put("status", "rejected").put("code", "NODE_ACCESS_DENIED")
                        400, 409 -> return JSONObject().put("status", "rejected").put("code", "SETTINGS_REJECTED_REFRESH_REQUIRED")
                    }
                    check(response.isSuccessful) { "NODE_WRITE_RESULT_UNKNOWN" }
                    val source = response.body?.source() ?: error("NODE_WRITE_RESULT_UNKNOWN")
                    check(!source.request(65_537)) { "NODE_WRITE_RESULT_UNKNOWN" }
                    val envelope = JSONObject(source.readUtf8()).optJSONObject("result")
                    check(envelope?.optString("action") == "settings.secretSet" && envelope.optJSONObject("data")?.optBoolean("ok") == true) { "NODE_WRITE_RESULT_UNKNOWN" }
                    JSONObject().put("status", "saved")
                }
            } catch (_: Exception) { JSONObject().put("status", "unknown").put("code", "NODE_WRITE_RESULT_UNKNOWN") }
            val changed = runCatching { store.get(id).getString("configRevision") != configRevision }.getOrDefault(true)
            return result.put("nodeChanged", changed)
        } finally { client.revoke() }
    }
}
