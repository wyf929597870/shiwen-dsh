package io.github.wyf929597870.shiwen.agent

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Callable

/** Portable conversation text and drafts. Provider configuration and credentials are never read. */
internal object AgentConversationArchive {
    fun capture(store: AgentTaskStore): JSONObject = store.db.runInTransaction(Callable {
        JSONObject().put("conversations", JSONArray(store.dao.conversations().map { row ->
            JSONObject().put("id", row.id).put("title", row.title).put("model", row.model ?: JSONObject.NULL)
                .put("modelRevision", row.modelRevision ?: JSONObject.NULL).put("createdAt", row.createdAt).put("updatedAt", row.updatedAt)
                .put("profileRevision", row.profileRevision ?: JSONObject.NULL).put("profileAgentId", row.profileAgentId ?: JSONObject.NULL)
                .put("systemContext", row.systemContext ?: JSONObject.NULL)
        })).put("tasks", JSONArray(store.dao.archiveTasks().map { row ->
            JSONObject().put("requestId", row.requestId).put("fingerprint", row.fingerprint).put("input", row.input)
                .put("modelId", row.modelId).put("receiptRequestId", row.receiptRequestId ?: JSONObject.NULL)
                .put("status", row.status).put("output", row.output).put("error", row.error ?: JSONObject.NULL)
                .put("updatedAt", row.updatedAt).put("submissionHash", row.submissionHash).put("conversationId", row.conversationId)
                .put("modelRevision", row.modelRevision).put("contextSnapshot", row.contextSnapshot)
                .put("contextTurns", row.contextTurns).put("omittedTurns", row.omittedTurns)
        })).put("drafts", JSONArray(store.dao.archiveDrafts().map { row ->
            JSONObject().put("slot", row.slot).put("requestId", row.requestId).put("input", row.input)
                .put("saveOriginal", row.saveOriginal).put("kind", row.kind).put("generation", row.generation)
                .put("conversationId", row.conversationId)
        }))
    })
    fun restore(store: AgentTaskStore, archive: JSONObject, digest: String) = store.db.runInTransaction {
        if (store.dao.archiveMarker() == digest) return@runInTransaction
        check(store.dao.conversations().isEmpty() && store.dao.archiveTasks().isEmpty() && store.dao.archiveDrafts().isEmpty()) {
            "CONVERSATION_RESTORE_TARGET_NOT_EMPTY"
        }
        val conversations = archive.getJSONArray("conversations")
        for (i in 0 until conversations.length()) {
            val row = conversations.getJSONObject(i)
            store.dao.insertConversation(AgentConversation(row.getString("id"), row.getString("title"), nullable(row, "model"),
                nullable(row, "modelRevision"), archived = true, readOnly = true, row.getString("createdAt"), row.getString("updatedAt"),
                nullable(row, "profileRevision"), nullable(row, "profileAgentId"), null, nullable(row, "systemContext")))
        }
        val tasks = archive.getJSONArray("tasks")
        for (i in 0 until tasks.length()) {
            val row = tasks.getJSONObject(i); val interrupted = row.getString("status") in setOf("running", "admitted")
            store.dao.insert(AgentTask(row.getString("requestId"), row.getString("fingerprint"), row.getString("input"),
                row.getString("modelId"), nullable(row, "receiptRequestId"),
                if (interrupted) "interrupted" else row.getString("status"), row.getString("output"),
                if (interrupted) "RESTORED_ARCHIVE" else nullable(row, "error"), row.getString("updatedAt"),
                row.getString("submissionHash"), row.getString("conversationId"), row.getString("modelRevision"),
                row.getString("contextSnapshot"), row.getInt("contextTurns"), row.getInt("omittedTurns")))
        }
        val drafts = archive.getJSONArray("drafts")
        for (i in 0 until drafts.length()) {
            val row = drafts.getJSONObject(i)
            store.dao.saveDraft(AgentDraft(row.getString("slot"), row.getString("requestId"), row.getString("input"),
                row.getBoolean("saveOriginal"), row.getString("kind"), row.getLong("generation"), row.getString("conversationId")))
        }
        store.dao.saveSessionState(AgentSessionState("archive-restore-marker", digest))
    }
    private fun nullable(row: JSONObject, key: String) = row.optString(key).takeUnless { it.isBlank() || it == "null" }
}
