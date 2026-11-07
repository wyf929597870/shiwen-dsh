package io.github.wyf929597870.shiwen.agent

import ai.koog.prompt.executor.model.PromptExecutor
import ai.koog.prompt.llm.LLModel
import io.github.wyf929597870.shiwen.model.Canonical
import io.github.wyf929597870.shiwen.probe.ProbeDraft
import io.github.wyf929597870.shiwen.library.AgentLibraryAccess
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

/** P0 task owner, intentionally independent of Activity/WebView. Created once by the native
 * application owner. No automatic resume: process recovery marks uncertain runs interrupted.
 * Each explicit submission consumes its ID once, even when an answer or callback was lost.
 */
internal class NativeAgentTasks private constructor(private val repository: AgentLibraryAccess,
    private val store: AgentTaskStore, private val ownerKey: String) {
    private val closed = AtomicBoolean(false)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val jobs = mutableMapOf<String, Job>()

    suspend fun submit(requestId: String, input: String, model: LLModel, modelConfigRevision: String,
        conversationId: String, profile: AgentProfileSnapshot? = null, approvedDraft: ProbeDraft? = null,
        executorFactory: () -> PromptExecutor): AgentTask = withContext(Dispatchers.IO) {
        require(input.isNotBlank() && input.length <= 32_000)
        require(modelConfigRevision.isNotBlank())
        val fingerprint = Canonical.hash(mapOf("libraryId" to repository.libraryId, "input" to input,
            "conversationId" to conversationId,
            "approvedDraft" to approvedDraft?.let { mapOf("requestId" to it.requestId, "title" to it.title,
                "markdown" to it.markdown, "kind" to it.kind, "generation" to it.generation) }))
        mutex.withLock {
            check(!closed.get() && scope.isActive) { "TASK_OWNER_CLOSED" }
            val existing = store.dao.get(requestId)
            if (existing != null) {
                check(existing.fingerprint == fingerprint) { "REQUEST_REUSED" }
                return@withLock existing
            }
            check(jobs.isEmpty()) { "AGENT_BUSY" }
            val conversation = checkNotNull(store.dao.conversation(conversationId)) { "CONVERSATION_UNKNOWN" }
            check(!conversation.readOnly && !conversation.archived) { "CONVERSATION_READ_ONLY" }
            check(conversation.modelRevision == null || conversation.modelRevision == modelConfigRevision) { "MODEL_CONFIG_CHANGED" }
            check(conversation.model == null || conversation.model == model.id) { "MODEL_CONFIG_CHANGED" }
            check(conversation.profileRevision == profile?.revision && conversation.profileAgentId == profile?.agentId &&
                conversation.profileNodeId == profile?.nodeId && conversation.systemContext == profile?.systemContext ||
                conversation.modelRevision == null) { "PROFILE_CHANGED" }
            val systemContext = profile?.systemContext ?: conversation.systemContext.orEmpty()
            check(systemContext.length <= MAX_PROFILE_CONTEXT_CHARS) { "AGENT_PROFILE_CONTEXT_TOO_LARGE" }
            check(input.length + systemContext.length <= MAX_TOTAL_PROMPT_TEXT_CHARS) { "MODEL_CONTEXT_BUDGET_EXCEEDED" }
            val now = now()
            if (conversation.modelRevision == null) {
                val title = if (conversation.title == NEW_CONVERSATION_TITLE) input.take(64) else conversation.title
                check(store.dao.bindConversation(conversationId, model.id, modelConfigRevision, title,
                    profile?.revision, profile?.agentId, profile?.nodeId, profile?.systemContext, now) == 1) {
                    "MODEL_CONFIG_CHANGED"
                }
            }
            val priorCount = store.dao.countSuccessful(conversationId, modelConfigRevision)
            val priorTasks = store.dao.successfulRecent(conversationId, modelConfigRevision, MAX_CONTEXT_SOURCE_TURNS)
            val availableHistoryChars = (MAX_TOTAL_PROMPT_TEXT_CHARS - input.length - systemContext.length)
                .coerceAtMost(MAX_CONTEXT_CHARS)
            val frozen = FrozenConversationContext.freeze(priorTasks, priorCount, availableHistoryChars)
            val task = AgentTask(requestId, fingerprint, input, model.id, approvedDraft?.requestId,
                submissionHash = submissionHash(repository.libraryId, input, approvedDraft != null, approvedDraft?.kind, conversationId),
                conversationId = conversationId, modelRevision = modelConfigRevision,
                contextSnapshot = frozen.encode(), contextTurns = frozen.includedTurns, omittedTurns = frozen.omittedTurns,
                updatedAt = now)
            val (admitted, created) = store.admit(task)
            if (!created) return@withLock admitted
            val job = scope.launch(start = CoroutineStart.LAZY) {
                try {
                    check(store.dao.start(requestId, now()) == 1)
                    var streamedUnits = 0
                    val result = NativeAgentProbe().run(input, executorFactory(), model,
                        localLibraryTools(repository, approvedDraft, requestId, conversationId),
                        conversationContext = FrozenConversationContext.decode(admitted.contextSnapshot),
                        systemContext = systemContext) { fragment ->
                        streamedUnits += fragment.length
                        check(streamedUnits <= 128_000) { "TURN_OUTPUT_TOO_LARGE" }
                        store.dao.append(requestId, fragment, now())
                    }
                    currentCoroutineContext().ensureActive()
                    store.dao.succeed(requestId, result, now())
                    store.dao.touchConversation(conversationId, now())
                } catch (cancelled: CancellationException) {
                    store.dao.finish(requestId, "cancelled", null, now())
                    throw cancelled
                } catch (_: Exception) {
                    // Transport exception messages may contain secrets; do not persist them.
                    store.dao.finish(requestId, "failed", "AGENT_RUN_FAILED", now())
                } finally { withContext(NonCancellable) { mutex.withLock { jobs.remove(requestId) } } }
            }
            jobs[requestId] = job
            job.start()
            admitted
        }
    }
    suspend fun status(requestId: String): AgentTask? = withContext(Dispatchers.IO) { store.dao.get(requestId) }
    suspend fun cancel(requestId: String) {
        val job = mutex.withLock { jobs[requestId] }
        job?.cancelAndJoin()
        withContext(Dispatchers.IO) {
            if (job != null) {
                store.dao.finish(requestId, "cancelled", null, now())
                mutex.withLock { jobs.remove(requestId) }
            }
        }
    }
    suspend fun close() {
        if (!closed.compareAndSet(false, true)) return
        withContext(NonCancellable) {
            try { scope.coroutineContext[Job]?.cancelAndJoin() }
            finally {
                store.db.close()
                synchronized(owners) { owners.remove(ownerKey) }
            }
        }
    }
    companion object {
        fun submissionHash(libraryId: String, input: String, saveOriginal: Boolean, kind: String?,
            conversationId: String = LEGACY_CONVERSATION_ID) =
            Canonical.hash(mapOf("libraryId" to libraryId, "input" to input,
                "conversationId" to conversationId, "saveOriginal" to saveOriginal,
                "kind" to if (saveOriginal) kind else null))
        private const val MAX_CONTEXT_SOURCE_TURNS = 128
        private val owners = mutableSetOf<String>()
        private fun now() = Instant.now().toString()
        suspend fun open(repository: AgentLibraryAccess, store: AgentTaskStore): NativeAgentTasks = withContext(Dispatchers.IO) {
            check(repository.libraryId == store.libraryId) { "LIBRARY_MISMATCH" }
            val key = checkNotNull(store.db.openHelper.databaseName)
            synchronized(owners) { check(owners.add(key)) { "TASK_OWNER_EXISTS" } }
            try {
                store.ensureLegacyConversation()
                store.dao.recoverInterrupted(now())
                NativeAgentTasks(repository, store, key)
            } catch (error: Exception) {
                synchronized(owners) { owners.remove(key) }
                throw error
            }
        }
    }
}
