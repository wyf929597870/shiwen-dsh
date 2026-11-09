package io.github.wyf929597870.shiwen.network

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLException

/** Only addresses that pass the stored TLS pin can become a node's current URL. */
internal object NodeReachability {
    private val locks = ConcurrentHashMap<String, Any>()
    private val failures = ConcurrentHashMap<String, Int>()
    private val checked = ConcurrentHashMap<String, Long>()
    private val cursors = ConcurrentHashMap<String, Int>()
    private data class Hint(val fingerprint: String, val url: String, val expires: Long)
    private val hints = ConcurrentHashMap<String, Hint>()
    @Volatile var hasNetwork = true
    fun discovered(fingerprint: String, url: String) {
        if (!fingerprint.matches(Regex("[a-f0-9]{64}"))) return
        hints.entries.removeIf { it.value.expires < System.currentTimeMillis() }
        if (hints.size >= 64 && !hints.containsKey(url)) return
        hints[url] = Hint(fingerprint, NodeSettingsStore.normalizeUrl(url, false), System.currentTimeMillis() + 120_000)
    }
    fun clearHints() { hints.clear(); checked.clear() }
    fun discoveredNodes(): JSONArray = JSONArray(hints.values.filter { it.expires > System.currentTimeMillis() }
        .map { JSONObject().put("fingerprint", it.fingerprint).put("baseUrl", it.url) })
    fun resolve(store: NodeSettingsStore, id: String, force: Boolean = false, cancelled: () -> Boolean = { false }): JSONObject = synchronized(locks.getOrPut(id) { Any() }) {
        val row = store.get(id); val revision = row.getString("configRevision"); val generation = row.optLong("connectionGeneration")
        val fingerprint = row.optString("fingerprint"); val now = System.currentTimeMillis()
        if (!force && now - (checked[id] ?: 0) < 30_000 && row.optString("connectionState") in setOf("online", "login-required")) return@synchronized row
        if (!hasNetwork) {
            store.connection(id, revision, generation) { it.put("connectionState", "no-network") }
            return@synchronized store.get(id)
        }
        val saved = row.optJSONArray("endpoints") ?: JSONArray()
        val offset = cursors[id] ?: 0
        val candidates = NodeRoutePolicy.candidates(row.getString("baseUrl"),
            if (fingerprint.isNotEmpty()) (0 until saved.length()).map(saved::getString) else emptyList(),
            if (fingerprint.isNotEmpty()) hints.values.filter { it.fingerprint == fingerprint && it.expires > now }.map { it.url } else emptyList(), offset)
        var attempted = 0
        var mismatch = false; var apiError = false
        // Snapshot the finite set: discovered addresses join the NEXT round.
        val deadline = System.nanoTime() + 10_000_000_000L
        for (url in candidates) {
            if (cancelled()) return@synchronized store.get(id)
            if (System.nanoTime() >= deadline || Thread.currentThread().isInterrupted) break
            attempted++
            val cookies = row.optJSONArray("cookies") ?: JSONArray()
            val client = NodeClient(url, row.optBoolean("allowPrivateHttp"),
                if (fingerprint.isEmpty()) (0 until cookies.length()).map(cookies::getString) else emptyList(),
                fingerprint.takeIf { it.isNotEmpty() }, row.optString("token").takeIf { it.isNotEmpty() }, 2)
            try {
                client.request("/auth/status").execute().use { response ->
                    if (!response.isSuccessful) { apiError = true; return@use }
                    val source = response.body?.source() ?: return@use
                    if (source.request(32769)) { apiError = true; return@use }
                    val status = JSONObject(source.readUtf8())
                    if (fingerprint.isNotEmpty() && status.optString("fingerprint") != fingerprint) { mismatch = true; return@use }
                    val authenticated = status.optBoolean("authenticated")
                    val announced = status.optJSONArray("endpoints") ?: JSONArray()
                    val valid = (0 until announced.length()).mapNotNull { i ->
                        runCatching { NodeSettingsStore.normalizeUrl(announced.getString(i), false) }.getOrNull()
                    }.filterNot { it.contains("127.0.0.1") }
                    if (cancelled()) return@synchronized store.get(id)
                    store.connection(id, revision, generation) {
                        it.put("baseUrl", url).put("authenticated", authenticated).put("lastCheckedAt", Instant.now().toString())
                            .put("connectionState", if (authenticated) "online" else "login-required")
                        if (url != row.getString("baseUrl")) it.put("connectionGeneration", generation + 1)
                        if (fingerprint.isNotEmpty()) it.put("endpoints", JSONArray((listOf(url) + valid + candidates).distinct().take(16)))
                    }
                    failures.remove(id); checked[id] = now
                    return@synchronized store.get(id)
                }
            } catch (error: Exception) {
                if (error is SSLException || generateSequence(error as Throwable?) { it.cause }.any { it.message?.contains("IDENTITY_MISMATCH") == true }) mismatch = true
                if (error is org.json.JSONException) apiError = true
                if (error.message == "NODE_CHANGED") throw error
            } finally { client.revoke() }
        }
        if (cancelled()) return@synchronized store.get(id)
        cursors[id] = offset + (attempted - 1).coerceAtLeast(1)
        val failed = (failures[id] ?: 0) + 1; failures[id] = failed; checked[id] = now
        store.connection(id, revision, generation) {
            it.put("connectionState", NodeRoutePolicy.failedState(failed, mismatch, apiError))
                .put("lastCheckedAt", Instant.now().toString())
        }
        store.get(id)
    }
}
