package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/** Text received from other apps stays untrusted and unfiled until the user chooses a library. */
class ShareInboxStore(context: Context, namespace: String = "shiwen-share-inbox") {
    private val prefs = context.applicationContext.getSharedPreferences(namespace, Context.MODE_PRIVATE)
    fun receive(intent: Intent?): Boolean = synchronized(lock) {
        if (intent?.action != Intent.ACTION_SEND || intent.type !in setOf("text/plain", "text/markdown")) return false
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: return false
        require(text.isNotBlank() && text.length <= 1_000_000) { "SHARED_TEXT_TOO_LARGE" }
        val rows = read().filter { !it.optBoolean("saved") && !it.optBoolean("dismissed") }.toMutableList()
        check(rows.size < 20) { "SHARE_INBOX_FULL" }
        val url = text.trim().takeIf { candidate -> runCatching {
            val uri = java.net.URI(candidate)
            uri.scheme in setOf("https", "http") && !uri.host.isNullOrBlank() && uri.userInfo == null
        }.getOrDefault(false) }
        rows.add(JSONObject().put("id", UUID.randomUUID().toString())
            .put("title", intent.getStringExtra(Intent.EXTRA_SUBJECT)?.take(200) ?: "")
            .put("text", text).put("url", url ?: JSONObject.NULL).put("receivedAt", Instant.now().toString()))
        write(rows)
        true
    }
    fun list(): JSONObject = synchronized(lock) {
        JSONObject().put("items", JSONArray(read().filter { !it.optBoolean("saved") && !it.optBoolean("dismissed") }))
    }
    fun dismiss(id: String): JSONObject = synchronized(lock) {
        val rows = read(); val item = rows.firstOrNull { it.optString("id") == id } ?: error("SHARE_ITEM_NOT_FOUND")
        check(!item.has("pendingRecord")) { "SHARE_SAVE_PENDING" }
        item.put("dismissed", true); write(rows)
        JSONObject().put("dismissed", true)
    }
    internal fun save(id: String, target: LibraryRepository, requested: JSONObject): LibraryRecord = synchronized(lock) {
        val rows = read(); val item = rows.firstOrNull { it.optString("id") == id } ?: error("SHARE_ITEM_NOT_FOUND")
        check(!item.optBoolean("dismissed")) { "SHARE_ITEM_DISMISSED" }
        val existingTarget = item.optString("pendingTargetLibraryId").takeIf { it.isNotBlank() }
        check(existingTarget == null || existingTarget == target.libraryId) { "SHARE_TARGET_FROZEN" }
        if (item.optBoolean("saved")) return target.read(item.getString("savedRecordId"))
        val frozen = item.optJSONObject("pendingRecord") ?: JSONObject(requested.toString()).apply {
            val markdown = getString("markdown")
            require(markdown.isNotBlank() && markdown.length <= 1_000_000) { "INVALID_SHARED_RECORD" }
            val origin = optString("origin", "unknown")
            require(origin in setOf("personal", "external", "ai", "translation", "unknown")) { "INVALID_SHARED_ORIGIN" }
            // Source text cannot grant tool access or embed a native attachment descriptor.
            remove("attachmentDescriptors"); remove("sourceIds"); remove("id")
            put("sources", JSONArray().put(JSONObject().put("text", markdown).put("origin", origin)
                .put("sourceRef", "android-share:${item.getString("id")}")))
            target.validateDraft(this)
            item.put("pendingRecord", this).put("pendingTargetLibraryId", target.libraryId)
            write(rows)
        }
        val requestId = UUID.nameUUIDFromBytes("android-share:$id".toByteArray()).toString()
        val record = target.create(requestId, frozen, 1, activityAction = "import")
        item.put("saved", true).put("savedRecordId", record.id)
        write(rows)
        record
    }
    private fun read(): List<JSONObject> {
        val values = JSONArray(prefs.getString("items", "[]"))
        return (0 until values.length()).map(values::getJSONObject)
    }
    private fun write(rows: List<JSONObject>) {
        val value = JSONArray(rows).toString()
        require(value.toByteArray().size <= 8 * 1024 * 1024) { "SHARE_INBOX_FULL" }
        check(prefs.edit().putString("items", value).commit()) { "SHARE_INBOX_SAVE_FAILED" }
    }
    companion object { private val lock = Any() }
}
