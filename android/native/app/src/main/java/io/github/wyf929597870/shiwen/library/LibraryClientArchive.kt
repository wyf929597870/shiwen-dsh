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
        result.put("workspaceThemes", JSONArray(repo.dao.workspaceThemes().map(::JSONObject)))
        if(repo.registryItem().role=="standalone"){
            val entries=repo.dao.explorationScope("standalone").filter {it.kind in portableExploration}
            if(entries.isNotEmpty())result.put("exploration",JSONArray(entries.map {obj("kind" to it.kind,"key" to JSONArray(it.key),"data" to JSONObject(it.data))}))
        }
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
        repo.db.runInTransaction {
            if(repo.registryItem().role=="standalone")for(entry in archive.optJSONArray("exploration")?.objects().orEmpty()){
                repo.dao.putExploration(ExplorationObject("standalone",entry.getString("kind"),entry.getJSONArray("key").toString(),entry.getJSONObject("data").toString()))
            }
            archive.optJSONArray("workspaceThemes")?.let { themes ->
                for (i in 0 until themes.length()) {
                    val theme = themes.getJSONObject(i)
                    repo.dao.putMeta(LibraryMeta("workspace-theme:" + theme.getString("id"), theme.toString()))
                }
            }
            repo.dao.putMeta(LibraryMeta("restored-editor-archive-digest", digest))
        }
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
        private val portableExploration=setOf("exploration_questions","exploration_discoveries","exploration_evidence","exploration_reviews",
            "exploration_aliases","exploration_pairs","exploration_decisions","exploration_periods","exploration_responses","settings","legacy")
        fun validate(archive: JSONObject) {
            for(entry in archive.optJSONArray("exploration")?.objects().orEmpty()){
                require(entry.getString("kind") in portableExploration && entry.getJSONArray("key").length() in 1..3)
                entry.getJSONObject("data")
            }
            require(archive.optInt("version") == 1 && archive.toString().length <= 24 * 1024 * 1024) { "CLIENT_ARCHIVE_INVALID" }
            require(archive.keys().asSequence().all { it in setOf("version", "editorDrafts", "agentArchive", "draftAttachments", "workspaceThemes", "exploration") }) { "CLIENT_ARCHIVE_UNEXPECTED_FIELD" }
            archive.optJSONArray("workspaceThemes")?.let { themes ->
                val ids = mutableSetOf<String>()
                for (i in 0 until themes.length()) {
                    val theme = themes.getJSONObject(i)
                    require(ids.add(UUID.fromString(theme.getString("id")).toString()) && theme.getInt("revision") > 0 &&
                        theme.getString("title").length in 1..200 && theme.getString("summary").length <= 10000 &&
                        theme.has("members") && theme.toString().toByteArray().size <= 2_000_000) { "INVALID_WORKSPACE_THEME" }
                    for (j in 0 until theme.getJSONArray("members").length()) {
                        val member = theme.getJSONArray("members").getJSONObject(j)
                        require(member.getString("field") in setOf("excerpt","body","reflection") && member.getString("sourceRecordId").isNotBlank() &&
                            member.getString("sourceKind").isNotBlank() && member.getString("id").isNotBlank() &&
                            member.getInt("start") >= 0 && member.getInt("end") - member.getInt("start") == member.getString("quote").length)
                        member.getBoolean("whole")
                    }
                }
            }
            val drafts = archive.getJSONArray("editorDrafts")
            require(drafts.length() <= 1000) { "CLIENT_ARCHIVE_DRAFT_INVALID" }
            val slots = mutableSetOf<String>()
            for (i in 0 until drafts.length()) {
                val row = drafts.getJSONObject(i); val slot = row.getString("slot")
                require((slot in setOf("composer", "materials", "articles", "collections") || slot.matches(Regex("annotation:[0-9a-fA-F-]{36}"))) && slots.add(slot)) { "CLIENT_ARCHIVE_DRAFT_INVALID" }
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
