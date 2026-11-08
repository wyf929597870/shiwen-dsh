package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/** Text received from other apps stays untrusted and unfiled until the user chooses a library. */
class ShareInboxStore(context: Context, namespace: String = "shiwen-share-inbox") {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences(namespace, Context.MODE_PRIVATE)
    private val inboxDir = File(app.filesDir, "share-inbox-images")
    fun receive(intent: Intent?): Boolean = synchronized(lock) {
        val isImage = intent?.type?.startsWith("image/") == true && intent.action in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)
        val isText = intent?.action == Intent.ACTION_SEND && intent.type in setOf("text/plain", "text/markdown")
        if (!isImage && !isText) return false
        val text = intent?.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
        require(text.length <= 1_000_000 && (isImage || text.isNotBlank())) { "SHARED_TEXT_TOO_LARGE" }
        val rows = read().filter { !it.optBoolean("saved") && !it.optBoolean("dismissed") }.toMutableList()
        check(rows.size < 20) { "SHARE_INBOX_FULL" }
        val files = JSONArray()
        val created = mutableListOf<File>()
        if (isImage) {
            val uris = linkedSetOf<Uri>()
            if (intent!!.action == Intent.ACTION_SEND_MULTIPLE)
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::addAll)
            else IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::add)
            intent.clipData?.let { clip -> for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(uris::add) }
            require(uris.size in 1..10) { "SHARE_IMAGE_COUNT_INVALID" }
            try {
                check(inboxDir.exists() || inboxDir.mkdirs()) { "SHARE_INBOX_UNAVAILABLE" }
                var total = 0L
                val transfer = LibraryFileTransfer(app)
                for ((index, uri) in uris.withIndex()) {
                    val bytes = transfer.readUri(uri, LibraryAttachmentDraftStore.MAX_IMAGE_BYTES.toLong())
                    check(LibraryAttachmentDraftStore.imageMime(bytes) != null) { "IMAGE_FORMAT_UNSUPPORTED" }
                    total += bytes.size; require(total <= 32L * 1024 * 1024) { "SHARE_IMAGE_TOO_LARGE" }
                    val name = UUID.randomUUID().toString();val path = File(inboxDir, name)
                    path.writeBytes(bytes);created.add(path)
                    files.put(JSONObject().put("id", name).put("name", "image-${index+1}").put("hash", LibraryAttachmentDraftStore.sha256(bytes)).put("byteLength", bytes.size))
                }
            } catch (error: Exception) { created.forEach { it.delete() }; throw error }
        }
        val url = text.trim().takeIf { candidate -> runCatching {
            val uri = java.net.URI(candidate)
            uri.scheme in setOf("https", "http") && !uri.host.isNullOrBlank() && uri.userInfo == null
        }.getOrDefault(false) }
        rows.add(JSONObject().put("id", UUID.randomUUID().toString())
            .put("title", intent?.getStringExtra(Intent.EXTRA_SUBJECT)?.take(200) ?: "")
            .put("text", text).put("images", files).put("url", url ?: JSONObject.NULL).put("receivedAt", Instant.now().toString()))
        try { write(rows) } catch (error: Exception) { created.forEach { it.delete() }; throw error }
        true
    }
    fun list(): JSONObject = synchronized(lock) {
        JSONObject().put("items", JSONArray(read().filter { !it.optBoolean("saved") && !it.optBoolean("dismissed") }))
    }
    fun dismiss(id: String): JSONObject = synchronized(lock) {
        val rows = read(); val item = rows.firstOrNull { it.optString("id") == id } ?: error("SHARE_ITEM_NOT_FOUND")
        check(!item.has("pendingRecord")) { "SHARE_SAVE_PENDING" }
        item.put("dismissed", true); write(rows); deleteInboxImages(item)
        JSONObject().put("dismissed", true)
    }
    internal fun save(id: String, target: LibraryRepository, requested: JSONObject): LibraryRecord = synchronized(lock) {
        val rows = read(); val item = rows.firstOrNull { it.optString("id") == id } ?: error("SHARE_ITEM_NOT_FOUND")
        check(!item.optBoolean("dismissed")) { "SHARE_ITEM_DISMISSED" }
        val existingTarget = item.optString("pendingTargetLibraryId").takeIf { it.isNotBlank() }
        check(existingTarget == null || existingTarget == target.libraryId) { "SHARE_TARGET_FROZEN" }
        if (item.optBoolean("saved")) return target.read(item.getString("savedRecordId"))
        val staging = LibraryAttachmentDraftStore(app, target.libraryId)
        val frozen = item.optJSONObject("pendingRecord") ?: JSONObject(requested.toString()).apply {
            var markdown = optString("markdown")
            val incoming = item.optJSONArray("images") ?: JSONArray()
            require(markdown.length <= 1_000_000 && (markdown.isNotBlank() || incoming.length() > 0)) { "INVALID_SHARED_RECORD" }
            val origin = optString("origin", "unknown")
            require(origin in setOf("personal", "external", "ai", "translation", "unknown")) { "INVALID_SHARED_ORIGIN" }
            // Source text cannot grant tool access or embed a native attachment descriptor.
            remove("attachmentDescriptors"); remove("sourceIds"); remove("id")
            val staged = JSONArray()
            for (index in 0 until incoming.length()) {
                val source = incoming.getJSONObject(index); val fileId = source.getString("id"); UUID.fromString(fileId)
                val file = File(inboxDir, fileId); check(file.isFile && file.canonicalFile.parentFile == inboxDir.canonicalFile) { "SHARE_IMAGE_MISSING" }
                val bytes = file.readBytes()
                check(bytes.size.toLong() == source.getLong("byteLength") && LibraryAttachmentDraftStore.sha256(bytes) == source.getString("hash")) { "SHARE_IMAGE_CORRUPT" }
                val descriptor = staging.stage(source.getString("name"), bytes); staged.put(descriptor)
                markdown += (if (markdown.isBlank()) "" else "\n\n") + "![图片](attachment:${descriptor.getString("id")})"
            }
            put("markdown", markdown).put("attachmentDescriptors", staged)
            put("sources", JSONArray().put(JSONObject().put("text", markdown).put("origin", origin)
                .put("sourceRef", "android-share:${item.getString("id")}")))
            target.validateDraft(this)
            item.put("pendingRecord", this).put("pendingTargetLibraryId", target.libraryId)
            write(rows)
        }
        val requestId = UUID.nameUUIDFromBytes("android-share:$id".toByteArray()).toString()
        val descriptors = frozen.optJSONArray("attachmentDescriptors") ?: JSONArray()
        val staged = (0 until descriptors.length()).map { index -> val descriptor = descriptors.getJSONObject(index); staging.read(descriptor.getString("id"), descriptor.getString("name")) }
        val record = target.create(requestId, frozen, 1, activityAction = "import", stagedAttachments = staged)
        item.put("saved", true).put("savedRecordId", record.id)
        write(rows)
        staged.forEach { runCatching { staging.delete(it.id) } }; deleteInboxImages(item)
        record
    }
    private fun deleteInboxImages(item: JSONObject) {
        val images = item.optJSONArray("images") ?: return
        for (index in 0 until images.length()) runCatching {
            val id = images.getJSONObject(index).getString("id"); UUID.fromString(id)
            val file = File(inboxDir, id); if (file.canonicalFile.parentFile == inboxDir.canonicalFile) file.delete()
        }
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
