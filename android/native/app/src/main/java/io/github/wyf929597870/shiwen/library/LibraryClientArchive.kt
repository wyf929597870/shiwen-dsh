package io.github.wyf929597870.shiwen.library

import android.content.Context
import io.github.wyf929597870.shiwen.agent.AgentConversationArchive
import io.github.wyf929597870.shiwen.agent.AgentTaskStore
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

/** Includes client-only data in a library archive without ever opening model or node secret stores. */
internal class LibraryClientArchive(context: Context) {
    private val app = context.applicationContext
    fun capture(repo: LibraryRepository, includeConversations: Boolean = true): JSONObject {
        restoreDrafts(repo)
        val drafts = RecordEditorDraftStore(app)
        val result = try { JSONObject().put("version", 1).put("editorDrafts", drafts.archive(repo.libraryId)) }
            finally { drafts.close() }
        val references = draftAttachmentReferences(result.getJSONArray("editorDrafts"))
        val store = LibraryAttachmentDraftStore(app, repo.libraryId)
        val staged = JSONArray()
        references.forEach { (id, expected) ->
            val file = store.read(id, expected.getString("name"))
            check(file.hash == expected.getString("hash") && file.byteLength == expected.getLong("byteLength") &&
                file.mimeType == expected.getString("mimeType")) { "DRAFT_ATTACHMENT_METADATA_MISMATCH" }
            staged.put(expected)
        }
        result.put("draftAttachments", staged)
        if (includeConversations) {
            val agent = AgentTaskStore(app, repo.libraryId)
            try {
                restoreConversations(repo, agent)
                agent.ensureLegacyConversation()
                result.put("agentArchive", AgentConversationArchive.capture(agent))
            } finally { agent.db.close() }
        }
        validate(result)
        return result
    }
    fun restoreDrafts(repo: LibraryRepository) {
        val archive = restored(repo) ?: return
        val digest = digest(archive)
        if (repo.dao.meta("restored-editor-archive-digest") == digest) return
        val store = RecordEditorDraftStore(app)
        try { store.restoreArchive(repo.libraryId, archive.getJSONArray("editorDrafts"), digest) }
        finally { store.close() }
        repo.dao.putMeta(LibraryMeta("restored-editor-archive-digest", digest))
    }
    fun restoreConversations(repo: LibraryRepository, store: AgentTaskStore) {
        val archive = restored(repo) ?: return
        val conversations = archive.optJSONObject("agentArchive") ?: return
        val digest = digest(archive)
        if (repo.dao.meta("restored-agent-archive-digest") == digest) return
        AgentConversationArchive.restore(store, conversations, digest)
        repo.dao.putMeta(LibraryMeta("restored-agent-archive-digest", digest))
    }
    private fun restored(repo: LibraryRepository) = repo.dao.meta("restored-client-archive-v1")?.let(::JSONObject)?.also(::validate)
    private fun digest(value: JSONObject) = MessageDigest.getInstance("SHA-256").digest(value.toString().toByteArray())
        .joinToString("") { "%02x".format(it) }
    companion object {
        fun validate(archive: JSONObject) {
            require(archive.optInt("version") == 1 && archive.toString().length <= 24 * 1024 * 1024) { "CLIENT_ARCHIVE_INVALID" }
            require(archive.keys().asSequence().all { it in setOf("version", "editorDrafts", "agentArchive", "draftAttachments") }) { "CLIENT_ARCHIVE_UNEXPECTED_FIELD" }
            val drafts = archive.getJSONArray("editorDrafts")
            require(drafts.length() <= 1000) { "CLIENT_ARCHIVE_DRAFT_INVALID" }
            val slots = mutableSetOf<String>()
            for (i in 0 until drafts.length()) {
                val row = drafts.getJSONObject(i); val slot = row.getString("slot")
                require((slot in setOf("composer", "materials", "articles") || slot.matches(Regex("annotation:[0-9a-fA-F-]{36}"))) && slots.add(slot)) { "CLIENT_ARCHIVE_DRAFT_INVALID" }
                require(row.getLong("localGeneration") in 0..9_007_199_254_740_991L && row.getLong("updatedAt") >= 0) { "CLIENT_ARCHIVE_DRAFT_INVALID" }
                val id = row.optString("requestId").takeUnless { it.isBlank() || it == "null" }
                if (id != null) UUID.fromString(id)
                require(row.getJSONObject("content").toString().length <= 2_000_000) { "CLIENT_ARCHIVE_DRAFT_INVALID" }
                row.optJSONObject("pendingMutation")?.let { pending ->
                    require(id != null && pending.optString("requestId") == id && pending.optLong("localGeneration", -1) == row.getLong("localGeneration") &&
                        pending.optString("action") in setOf("create", "update", "delete", "restore") && pending.length() <= 16 && pending.toString().length <= 2_000_000) { "CLIENT_ARCHIVE_DRAFT_INVALID" }
                }
            }
            archive.optJSONArray("draftAttachments")?.let { staged ->
                val ids = mutableSetOf<String>()
                for (i in 0 until staged.length()) {
                    val item = staged.getJSONObject(i)
                    val id = item.getString("id")
                    UUID.fromString(id)
                    require(ids.add(id) && LibraryAttachmentDraftStore.safeName(item.getString("name")) == item.getString("name") &&
                        item.getString("hash").matches(Regex("[a-f0-9]{64}")) &&
                        item.getLong("byteLength") in 1..LibraryAttachmentDraftStore.MAX_IMAGE_BYTES.toLong() &&
                        item.getString("mimeType") in setOf("image/png", "image/jpeg", "image/gif", "image/webp")) {
                        "CLIENT_ARCHIVE_DRAFT_ATTACHMENT_INVALID"
                    }
                }
                val references = draftAttachmentReferences(drafts)
                require(ids == references.keys && (0 until staged.length()).all { index ->
                    val descriptor = staged.getJSONObject(index)
                    references[descriptor.getString("id")]?.toString() == descriptor.toString()
                }) { "CLIENT_ARCHIVE_DRAFT_ATTACHMENT_MISMATCH" }
            }
            archive.optJSONObject("agentArchive")?.let { agent ->
                val conversations = agent.getJSONArray("conversations"); val tasks = agent.getJSONArray("tasks"); val agentDrafts = agent.getJSONArray("drafts")
                require(conversations.length() <= 100_000 && tasks.length() <= 100_000 && agentDrafts.length() <= conversations.length()) { "CLIENT_ARCHIVE_TOO_LARGE" }
                val ids = mutableSetOf<String>()
                for (i in 0 until conversations.length()) {
                    val row = conversations.getJSONObject(i); val id = row.getString("id")
                    require(id.length in 1..128 && ids.add(id)) { "CLIENT_ARCHIVE_CONVERSATION_INVALID" }
                    for (field in listOf("title", "createdAt", "updatedAt")) row.getString(field)
                }
                val taskIds = mutableSetOf<String>()
                for (i in 0 until tasks.length()) {
                    val row = tasks.getJSONObject(i); val id = row.getString("requestId"); UUID.fromString(id)
                    require(taskIds.add(id) && row.getString("conversationId") in ids) { "CLIENT_ARCHIVE_TASK_INVALID" }
                    for (field in listOf("fingerprint", "input", "modelId", "status", "output", "updatedAt", "submissionHash", "modelRevision", "contextSnapshot")) row.getString(field)
                    require(row.getInt("contextTurns") >= 0 && row.getInt("omittedTurns") >= 0) { "CLIENT_ARCHIVE_TASK_INVALID" }
                }
                val draftSlots = mutableSetOf<String>()
                for (i in 0 until agentDrafts.length()) {
                    val row = agentDrafts.getJSONObject(i); UUID.fromString(row.getString("requestId"))
                    require(row.getString("conversationId") in ids && draftSlots.add(row.getString("slot")) && row.getLong("generation") >= 0) { "CLIENT_ARCHIVE_AGENT_DRAFT_INVALID" }
                    row.getString("input"); row.getBoolean("saveOriginal"); row.getString("kind")
                }
            }
        }

        /** Extract only editor staging tokens, never committed attachment descriptors. */
        fun draftAttachmentReferences(drafts: JSONArray): Map<String, JSONObject> {
            val references = linkedMapOf<String, JSONObject>()
            for (i in 0 until drafts.length()) {
                val row = drafts.getJSONObject(i)
                val content = row.optJSONObject("content")
                val form = content?.optJSONObject("form")
                val annotationEditor = content?.optJSONObject("editor")
                val metadata = linkedMapOf<String, JSONObject>()
                fun collect(array: JSONArray?) {
                    if (array == null) return
                    for (index in 0 until array.length()) {
                        val item = array.getJSONObject(index)
                        val id = item.optString("id")
                        if (id.isBlank()) continue
                        val normalized = JSONObject().put("id", id).put("name", item.optString("name"))
                            .put("hash", item.optString("hash")).put("byteLength", item.optLong("byteLength", -1))
                            .put("mimeType", item.optString("mimeType"))
                        val prior = metadata.putIfAbsent(id, normalized)
                        require(prior == null || prior.toString() == normalized.toString()) { "CLIENT_ARCHIVE_DRAFT_ATTACHMENT_MISMATCH" }
                    }
                }
                collect(form?.optJSONArray("stagedAttachments"))
                collect(annotationEditor?.optJSONArray("staged"))
                val pending = row.optJSONObject("pendingMutation")
                val frozenRecord = pending?.optJSONObject("record") ?: pending?.optJSONObject("patch")
                collect(frozenRecord?.optJSONArray("attachmentDescriptors"))
                val ids = linkedSetOf<String>()
                form?.optJSONArray("stagedAttachments")?.let { array ->
                    for (index in 0 until array.length()) ids += array.getJSONObject(index).getString("id")
                }
                annotationEditor?.optJSONArray("staged")?.let { array ->
                    for (index in 0 until array.length()) ids += array.getJSONObject(index).getString("id")
                }
                pending?.optJSONArray("stagedAttachmentIds")?.let { array ->
                    for (index in 0 until array.length()) ids += array.getString(index)
                }
                for (id in ids) {
                    UUID.fromString(id)
                    val descriptor = metadata[id] ?: error("CLIENT_ARCHIVE_DRAFT_ATTACHMENT_METADATA_MISSING")
                    require(descriptor.optString("name").isNotBlank() && descriptor.optString("hash").isNotBlank() &&
                        descriptor.optLong("byteLength", -1) > 0 && descriptor.optString("mimeType").isNotBlank()) {
                        "CLIENT_ARCHIVE_DRAFT_ATTACHMENT_METADATA_MISSING"
                    }
                    val previous = references.putIfAbsent(id, descriptor)
                    require(previous == null || previous.toString() == descriptor.toString()) { "CLIENT_ARCHIVE_DRAFT_ATTACHMENT_MISMATCH" }
                }
            }
            return references
        }
    }
}
