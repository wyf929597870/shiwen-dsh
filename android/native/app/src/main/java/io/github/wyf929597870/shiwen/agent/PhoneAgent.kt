package io.github.wyf929597870.shiwen.agent

import android.content.Context
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import io.github.wyf929597870.shiwen.probe.ProbeDraft
import io.github.wyf929597870.shiwen.library.AgentLibraryAccess
import io.github.wyf929597870.shiwen.library.LibraryRepository
import kotlinx.coroutines.runBlocking
import ai.koog.prompt.executor.model.PromptExecutor
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Callable

/** Application-owned singleton; bridge recreation attaches observers to the active library. */
internal class PhoneAgent(context: Context, private val repo: AgentLibraryAccess,
    val configs: ModelConfigStore = ModelConfigStore(context),
    private val store: AgentTaskStore = AgentTaskStore(context, repo.libraryId),
    private val executorFactory: (ModelConfig) -> PromptExecutor = ModelTransport::create,
    private val profileProvider: () -> JSONObject? = { NodeSettingsStore(context).selectedProfile()
        ?: run {
            val content = "你是拾文助手，帮助用户记录、整理资料和思考。专业、坦诚、温和，尊重原文与来源；不把猜测写成事实。"
            JSONObject().put("revision", io.github.wyf929597870.shiwen.model.Canonical.hash(mapOf("context" to content)))
                .put("agentId", "shiwen-phone").put("nodeId", "builtin").put("systemContext", content)
        } }) {
    init {
        (repo as? LibraryRepository)?.let {
            io.github.wyf929597870.shiwen.library.LibraryClientArchive(context).restoreConversations(it, store)
        }
    }
    private val tasks = runBlocking { NativeAgentTasks.open(repo, store) }

    fun conversations(): JSObject = snapshot()

    fun createConversation(id: String): JSObject {
        UUID.fromString(id)
        store.db.runInTransaction(Callable {
            if (store.dao.conversation(id) == null) {
                val now = Instant.now().toString()
                store.dao.insertConversation(AgentConversation(id, NEW_CONVERSATION_TITLE, null, null,
                    archived = false, readOnly = false, createdAt = now, updatedAt = now))
            }
            store.dao.saveSessionState(AgentSessionState(activeId = id))
        })
        return snapshot()
    }

    fun selectConversation(id: String): JSObject {
        check(store.dao.conversation(id) != null) { "CONVERSATION_UNKNOWN" }
        store.dao.saveSessionState(AgentSessionState(activeId = id))
        return snapshot()
    }

    /** Deletes one writable conversation with its tasks and draft; the active slot falls back to the newest writable one. */
    fun deleteConversation(id: String): JSObject {
        require(id != LEGACY_CONVERSATION_ID) { "CONVERSATION_READ_ONLY" }
        check(!requireConversation(id).readOnly) { "CONVERSATION_READ_ONLY" }
        check(id !in store.dao.runningConversationIds()) { "CONVERSATION_RUNNING" }
        store.db.runInTransaction(Callable {
            store.dao.deleteTasks(id)
            store.dao.deleteDrafts(id)
            store.dao.deleteConversation(id)
            if (store.dao.activeConversationId() == id)
                store.dao.saveSessionState(AgentSessionState(activeId = store.dao.latestWritableConversation()?.id))
        })
        return snapshot()
    }

    fun recent(conversationId: String, offset: Int = 0): JSObject {
        require(offset >= 0) { "INVALID_OFFSET" }
        requireConversation(conversationId)
        val page = store.dao.recent(conversationId, PAGE_SIZE + 1, offset)
        val hasMore = page.size > PAGE_SIZE
        val items = page.take(PAGE_SIZE)
        return JSObject().put("items", JSArray(items.map(::json)))
            .put("nextOffset", if (hasMore) offset + PAGE_SIZE else JSONObject.NULL)
    }

    fun status(id: String, conversationId: String): JSObject {
        requireConversation(conversationId)
        val task = store.dao.get(id) ?: return JSObject().put("status", "unknown")
        check(task.conversationId == conversationId) { "CONVERSATION_MISMATCH" }
        return json(task)
    }

    fun readDraft(conversationId: String): JSObject {
        requireConversation(conversationId)
        return JSObject().put("draft", store.dao.draft(conversationId)?.let {
            JSObject().put("id", it.requestId).put("input", it.input).put("saveOriginal", it.saveOriginal)
                .put("kind", it.kind).put("localGeneration", it.generation).put("conversationId", it.conversationId)
        } ?: JSONObject.NULL)
    }

    fun saveDraft(id: String, input: String, saveOriginal: Boolean, kind: String, generation: Long,
        conversationId: String): JSObject {
        UUID.fromString(id)
        require(input.length <= 32_000 && generation >= 0 && kind in CONTENT_KINDS)
        val conversation = requireConversation(conversationId)
        check(!conversation.readOnly && !conversation.archived) { "CONVERSATION_READ_ONLY" }
        val next = AgentDraft(slot = conversationId, requestId = id, input = input,
            saveOriginal = saveOriginal, kind = kind, generation = generation, conversationId = conversationId)
        store.db.runInTransaction(Callable {
            val task = store.dao.get(id)
            if (task != null) {
                check(task.conversationId == conversationId) { "CONVERSATION_MISMATCH" }
                check(task.submissionHash == NativeAgentTasks.submissionHash(repo.libraryId, input,
                    saveOriginal, kind, conversationId)) { "REQUEST_REUSED" }
                // A late page flush must not resurrect a draft already admitted as a task.
            } else {
                val old = store.dao.draft(conversationId)
                if (old?.requestId == id && generation == old.generation) check(old == next) { "DRAFT_GENERATION_REUSED" }
                if (old == null || old.requestId != id || generation >= old.generation) store.dao.saveDraft(next)
            }
        })
        return JSObject().put("saved", true)
    }

    fun acknowledge(id: String, generation: Long, conversationId: String): JSObject {
        val conversation = requireConversation(conversationId)
        check(!conversation.readOnly && !conversation.archived) { "CONVERSATION_READ_ONLY" }
        store.db.runInTransaction(Callable {
            val task = checkNotNull(store.dao.get(id)) { "TASK_UNKNOWN" }
            check(task.conversationId == conversationId) { "CONVERSATION_MISMATCH" }
            val draft = store.dao.draft(conversationId)
            if (draft != null && draft.requestId == id && draft.generation == generation) {
                check(task.submissionHash == NativeAgentTasks.submissionHash(repo.libraryId, draft.input,
                    draft.saveOriginal, draft.kind, conversationId)) { "REQUEST_REUSED" }
                store.dao.clearDraft(conversationId, id, generation)
            }
        })
        return JSObject().put("saved", true)
    }

    fun send(id: String, input: String, saveOriginal: Boolean, kind: String, revision: String,
        conversationId: String): JSObject = runBlocking {
        UUID.fromString(id)
        require(kind in CONTENT_KINDS)
        val existing = store.dao.get(id)
        if (existing != null) {
            check(existing.conversationId == conversationId) { "CONVERSATION_MISMATCH" }
            check(existing.submissionHash == NativeAgentTasks.submissionHash(repo.libraryId, input,
                saveOriginal, kind, conversationId)) { "REQUEST_REUSED" }
            return@runBlocking json(existing)
        }
        val config = configs.read() ?: error("MODEL_NOT_CONFIGURED")
        check(config.revision == revision) { "MODEL_CONFIG_CHANGED" }
        val profile = profileProvider()?.let {
            AgentProfileSnapshot(it.getString("revision"), it.getString("agentId"), it.getString("nodeId"),
                it.getString("systemContext"))
        }
        val draft = if (saveOriginal) ProbeDraft(slot = "agent", requestId = UUID.nameUUIDFromBytes(
            "${repo.libraryId}:$conversationId:$id:original".toByteArray(Charsets.UTF_8)).toString(), title = "",
            markdown = input, kind = kind, generation = 0) else null
        json(tasks.submit(id, input, ModelTransport.model(config), config.revision, conversationId,
            profile = profile, approvedDraft = draft) { executorFactory(config) })
    }

    fun cancel(id: String, conversationId: String): JSObject = runBlocking {
        requireConversation(conversationId)
        store.dao.get(id)?.let { check(it.conversationId == conversationId) { "CONVERSATION_MISMATCH" } }
        tasks.cancel(id)
        status(id, conversationId)
    }

    suspend fun close() = tasks.close()

    private fun requireConversation(id: String): AgentConversation =
        checkNotNull(store.dao.conversation(id)) { "CONVERSATION_UNKNOWN" }

    private fun snapshot(): JSObject {
        val running = store.dao.runningConversationIds().toSet()
        val items = store.dao.conversations().map { conversation ->
            JSObject().put("id", conversation.id).put("title", conversation.title)
                .put("model", conversation.model ?: JSONObject.NULL)
                .put("modelRevision", conversation.modelRevision ?: JSONObject.NULL)
                .put("profileRevision", conversation.profileRevision ?: JSONObject.NULL)
                .put("profileNodeId", conversation.profileNodeId ?: JSONObject.NULL)
                .put("archived", conversation.archived).put("readOnly", conversation.readOnly).put("running", conversation.id in running)
                .put("updatedAt", conversation.updatedAt)
        }
        val activeId = store.dao.activeConversationId()?.takeIf { store.dao.conversation(it) != null }
        return JSObject().put("items", JSArray(items)).put("activeId", activeId ?: JSONObject.NULL)
    }

    private fun json(task: AgentTask): JSObject {
        val receipt = task.receiptRequestId?.let { repo.receiptForAgent(it) }
        return JSObject().put("id", task.requestId).put("input", task.input).put("output", task.output)
            .put("status", task.status).put("error", task.error).put("model", task.modelId)
            .put("modelRevision", task.modelRevision).put("conversationId", task.conversationId)
            .put("contextTurns", task.contextTurns).put("omittedTurns", task.omittedTurns)
            .put("updatedAt", task.updatedAt).put("recordId", receipt?.recordId ?: JSONObject.NULL)
    }

    companion object {
        private const val PAGE_SIZE = 20
        private val CONTENT_KINDS = setOf("journal", "freewrite", "reading_note", "idea", "web", "ai", "reference")
        private val instances = java.util.concurrent.ConcurrentHashMap<String, PhoneAgent>()
        fun get(context: Context, repo: AgentLibraryAccess): PhoneAgent = instances.computeIfAbsent(repo.libraryId) {
            PhoneAgent(context.applicationContext, repo)
        }
    }
}
