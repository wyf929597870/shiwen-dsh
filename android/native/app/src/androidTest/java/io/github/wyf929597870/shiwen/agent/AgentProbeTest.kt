package io.github.wyf929597870.shiwen.agent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ai.koog.agents.core.tools.ToolDescriptor
import ai.koog.prompt.Prompt
import ai.koog.prompt.dsl.ModerationResult
import ai.koog.prompt.executor.model.PromptExecutor
import ai.koog.prompt.llm.*
import ai.koog.prompt.message.*
import ai.koog.prompt.streaming.*
import io.github.wyf929597870.shiwen.probe.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class AgentProbeTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val model = LLModel(LLMProvider("probe", "Offline test"), "scripted",
        listOf(LLMCapability.Tools, LLMCapability.Completion), 32_000)

    private suspend fun withRepository(block: suspend (ProbeRepository) -> Unit) {
        val namespace = "agent-test-${UUID.randomUUID()}"
        val repo = ProbeRepository(context, namespace)
        try { block(repo) } finally {
            repo.db.close(); repo.executor.shutdown()
            context.deleteDatabase("$namespace-${repo.libraryId}.sqlite")
            context.deleteSharedPreferences("$namespace-installation")
        }
    }
    private fun draft() = ProbeDraft(slot = "agent", requestId = UUID.randomUUID().toString(),
        title = "散步日记", markdown = "今天散步看到了🌱。\n# 原文不改写", kind = "journal", generation = 1)
    private fun tool(name: String, args: String = "{}", id: String = UUID.randomUUID().toString()) =
        Message.Assistant(MessagePart.Tool.Call(id, name, args), ResponseMetaInfo.Empty)
    private fun answer(text: String) = Message.Assistant(text, ResponseMetaInfo.Empty)
    private fun results(prompt: Prompt) = prompt.messages.flatMap { it.parts }.filterIsInstance<MessagePart.Tool.Result>()
    private fun conversation(store: AgentTaskStore): String = UUID.randomUUID().toString().also { id ->
        val now = "2026-11-06T00:00:00Z"
        store.dao.insertConversation(AgentConversation(id, NEW_CONVERSATION_TITLE, null, null,
            archived = false, readOnly = false, createdAt = now, updatedAt = now))
    }

    private class Script(private val script: suspend (Int, Prompt, List<ToolDescriptor>) -> Flow<StreamFrame>) : PromptExecutor() {
        var calls = 0; var closed = false
        override fun executeStreaming(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>) = flow {
            emitAll(script(calls++, prompt, tools))
        }
        override suspend fun execute(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>): Message.Assistant =
            error("Expected actual streaming path")
        override suspend fun moderate(prompt: Prompt, model: LLModel): ModerationResult = error("unused")
        override fun close() { closed = true }
    }

    @Test fun realFrameworkCallsRoomOnceAndReturnsPersistentReceipt() = runBlocking {
        withRepository { repo ->
            val draft = draft()
            val fragments = mutableListOf<String>()
            val executor = Script { index, prompt, tools ->
                assertTrue(tools.any { it.name == "save_approved_record" })
                when (index) {
                    0, 1 -> tool("save_approved_record").toStreamFrames().asFlow()
                    2 -> {
                        assertEquals(2, results(prompt).size)
                        assertTrue(results(prompt).all { it.toString().contains("applied") })
                        answer("已保存").toStreamFrames().asFlow()
                    }
                    else -> error("Unexpected model retry")
                }
            }
            assertEquals("已保存", NativeAgentProbe().run("请保存我的日记", executor, model,
                localLibraryTools(repo, draft)) { fragments += it })
            assertEquals("已保存", fragments.joinToString(""))
            assertTrue(executor.closed)
            assertEquals(1, repo.db.dao().records(0, 30).size)
            val receipt = checkNotNull(repo.db.dao().receipt(draft.requestId))
            assertEquals(draft.markdown, repo.db.dao().record(receipt.recordId)?.markdown)
            // A new native run can return the original receipt without creating another record.
            assertEquals(receipt.recordId, repo.save(draft).id)
        }
    }

    @Test fun readToolsStayInBoundLibraryAndNoWriteGrantIsAdvertised() = runBlocking {
        withRepository { first -> withRepository { second ->
            val record = first.save(draft())
            val executor = Script { index, prompt, tools ->
                assertFalse(tools.any { it.name == "save_approved_record" })
                when (index) {
                    0 -> tool("search_records", "{\"query\":\"散步\"}").toStreamFrames().asFlow()
                    1 -> {
                        assertTrue(results(prompt).single().toString().contains(record.id))
                        tool("read_record", "{\"id\":\"${record.id}\"}").toStreamFrames().asFlow()
                    }
                    else -> answer("已读取原文").toStreamFrames().asFlow()
                }
            }
            assertEquals("已读取原文", NativeAgentProbe().run("看看散步日记", executor, model, localLibraryTools(first)))
            val other = Script { index, prompt, tools ->
                assertFalse(tools.any { it.name == "save_approved_record" })
                if (index == 0) tool("read_record", "{\"id\":\"${record.id}\"}").toStreamFrames().asFlow()
                else {
                    assertTrue(results(prompt).single().toString().contains("RECORD_NOT_FOUND"))
                    answer("另一资料库中没有此记录").toStreamFrames().asFlow()
                }
            }
            NativeAgentProbe().run("看看资料", other, model, localLibraryTools(second))
            assertTrue(second.db.dao().search("散步").isEmpty())
        } }
    }

    @Test fun interruptedStreamNeverDispatchesACompletedToolWithoutEndFrame() = runBlocking {
        withRepository { repo ->
            val request = draft()
            val executor = Script { _, _, _ -> tool("save_approved_record").toStreamFrames()
                .filterNot { it is StreamFrame.End }.asFlow() }
            assertTrue(runCatching {
                NativeAgentProbe().run("保存", executor, model, localLibraryTools(repo, request))
            }.isFailure)
            assertEquals(1, executor.calls); assertTrue(executor.closed)
            assertNull(repo.db.dao().receipt(request.requestId))
            assertTrue(repo.db.dao().records(0, 30).isEmpty())
        }
    }

    @Test fun cancellationStopsStreamingWithoutRetryOrWrite() = runBlocking {
        withRepository { repo ->
            val request = draft()
            val started = CompletableDeferred<Unit>()
            var streamClosed = false
            val executor = Script { _, _, _ -> flow {
                try {
                    emit(StreamFrame.TextDelta("正在处理")); started.complete(Unit)
                    awaitCancellation()
                } finally { streamClosed = true }
            } }
            val job = launch {
                NativeAgentProbe().run("保存", executor, model, localLibraryTools(repo, request))
            }
            withTimeout(10_000) { started.await() }
            withTimeout(10_000) { job.cancelAndJoin() }
            assertTrue(streamClosed); assertTrue(executor.closed); assertEquals(1, executor.calls)
            assertNull(repo.db.dao().receipt(request.requestId))
        }
    }

    @Test fun taskJournalSurvivesLostObserverWithoutResendingModelRequest() = runBlocking {
        withRepository { repo ->
            val namespace = "agent-journal-test-${UUID.randomUUID()}"
            val store = AgentTaskStore(context, repo.libraryId, namespace)
            val owner = NativeAgentTasks.open(repo, store)
            val id = UUID.randomUUID().toString()
            val conversationId = conversation(store)
            var constructed = 0
            try {
                val factory = { constructed++; Script { _, _, _ -> answer("完整回答").toStreamFrames().asFlow() } }
                owner.submit(id, "你好", model, "config-1", conversationId, executorFactory = factory)
                withTimeout(10_000) {
                    while (owner.status(id)?.status != "succeeded") delay(10)
                }
                val duplicate = owner.submit(id, "你好", model, "config-1", conversationId, executorFactory = factory)
                assertEquals("完整回答", duplicate.output); assertEquals(1, constructed)
                assertTrue(runCatching { owner.submit(id, "改变正文", model, "config-1", conversationId, executorFactory = factory) }.isFailure)
                owner.close()
                val reopenedStore = AgentTaskStore(context, repo.libraryId, namespace)
                val reopened = NativeAgentTasks.open(repo, reopenedStore)
                try {
                    assertEquals("succeeded", reopened.submit(id, "你好", model, "config-1", conversationId, executorFactory = factory).status)
                    assertEquals(1, constructed)
                } finally { reopened.close() }
            } finally {
                owner.close()
                context.deleteDatabase("$namespace-${repo.libraryId}.sqlite")
            }
        }
    }

    @Test fun interruptedTaskIsVisibleAfterReopenAndNeverAutoResumed() = runBlocking {
        withRepository { repo ->
            val namespace = "agent-recovery-test-${UUID.randomUUID()}"
            val store = AgentTaskStore(context, repo.libraryId, namespace)
            val id = UUID.randomUUID().toString()
            // Durable state left by an abruptly terminated process, not a claim of OS kill testing.
            store.admit(AgentTask(id, "fingerprint", "原请求", "scripted", null))
            store.dao.start(id, "2026-11-06T00:00:00Z")
            store.dao.append(id, "已收到的部分", "2026-11-06T00:00:00Z")
            store.db.close()
            val reopenedStore = AgentTaskStore(context, repo.libraryId, namespace)
            val owner = NativeAgentTasks.open(repo, reopenedStore)
            try {
                val task = checkNotNull(owner.status(id))
                assertEquals("interrupted", task.status)
                assertEquals("已收到的部分", task.output)
                assertEquals("PROCESS_INTERRUPTED", task.error)
            } finally {
                owner.close(); context.deleteDatabase("$namespace-${repo.libraryId}.sqlite")
            }
        }
    }

    @Test fun taskOwnerOutlivesCallingCoroutineAndSupportsExplicitCancel() = runBlocking {
        withRepository { repo ->
            val namespace = "agent-owner-test-${UUID.randomUUID()}"
            val store = AgentTaskStore(context, repo.libraryId, namespace)
            val owner = NativeAgentTasks.open(repo, store)
            val id = UUID.randomUUID().toString()
            val conversationId = conversation(store)
            val started = CompletableDeferred<Unit>()
            val executor = Script { _, _, _ -> flow {
                emit(StreamFrame.TextDelta("部分回答")); started.complete(Unit); awaitCancellation()
            } }
            try {
                launch { owner.submit(id, "你好", model, "config-1", conversationId) { executor } }.join()
                withTimeout(10_000) { started.await() }
                assertEquals("running", owner.status(id)?.status)
                assertEquals("部分回答", owner.status(id)?.output)
                val duplicateStore = AgentTaskStore(context, repo.libraryId, namespace)
                try {
                    assertTrue(runCatching { NativeAgentTasks.open(repo, duplicateStore) }.isFailure)
                    assertEquals("running", owner.status(id)?.status)
                } finally { duplicateStore.db.close() }
                owner.cancel(id)
                assertEquals("cancelled", owner.status(id)?.status)
                assertTrue(executor.closed); assertEquals(1, executor.calls)
                assertEquals("cancelled", owner.submit(id, "你好", model, "config-1", conversationId) { error("Must not restart") }.status)
            } finally {
                owner.close(); context.deleteDatabase("$namespace-${repo.libraryId}.sqlite")
            }
        }
    }
}
