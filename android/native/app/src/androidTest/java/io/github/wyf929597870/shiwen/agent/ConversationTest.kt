package io.github.wyf929597870.shiwen.agent

import ai.koog.agents.core.tools.ToolDescriptor
import ai.koog.agents.core.tools.ToolRegistry
import ai.koog.prompt.Prompt
import ai.koog.prompt.dsl.ModerationResult
import ai.koog.prompt.executor.model.PromptExecutor
import ai.koog.prompt.llm.*
import ai.koog.prompt.message.Message
import ai.koog.prompt.message.MessagePart
import ai.koog.prompt.streaming.*
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.wyf929597870.shiwen.probe.ProbeRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.asFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ConversationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val model = LLModel(LLMProvider("conversation-test", "Offline"), "scripted",
        listOf(LLMCapability.Tools, LLMCapability.Completion), 32_000)

    private fun createConversation(store: AgentTaskStore, id: String = UUID.randomUUID().toString()): String {
        val now = "2026-11-06T00:00:00Z"
        store.dao.insertConversation(AgentConversation(id, NEW_CONVERSATION_TITLE, null, null,
            archived = false, readOnly = false, createdAt = now, updatedAt = now))
        return id
    }

    private class RecordingExecutor(private val response: String, private val fail: Boolean = false) : PromptExecutor() {
        val prompts = mutableListOf<Prompt>()
        override fun executeStreaming(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>) = flow {
            prompts += prompt
            if (fail) error("scripted offline failure")
            emitAll(Message.Assistant(response, ai.koog.prompt.message.ResponseMetaInfo.Empty).toStreamFrames().asFlow())
        }
        override suspend fun execute(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>): Message.Assistant = error("streaming expected")
        override suspend fun moderate(prompt: Prompt, model: LLModel): ModerationResult = error("unused")
        override fun close() {}
    }

    @Test fun onlySuccessfulTurnsAreFrozenIntoTheirOwnConversation() = runBlocking {
        val namespace = "conversation-context-${UUID.randomUUID()}"
        val repo = ProbeRepository(context, namespace)
        val store = AgentTaskStore(context, repo.libraryId, namespace)
        val owner = NativeAgentTasks.open(repo, store)
        val firstConversation = createConversation(store)
        val otherConversation = createConversation(store)
        suspend fun send(id: String, conversationId: String, input: String, response: String,
            fail: Boolean = false): Pair<AgentTask, RecordingExecutor> {
            val executor = RecordingExecutor(response, fail)
            val task = owner.submit(id, input, model, "revision-a", conversationId,
                executorFactory = { executor })
            withTimeout(10_000) { while (owner.status(id)?.status in listOf("admitted", "running")) delay(10) }
            return checkNotNull(owner.status(id)) to executor
        }
        try {
            val (first, _) = send(UUID.randomUUID().toString(), firstConversation, "第一轮输入", "第一轮回答")
            assertEquals("succeeded", first.status)
            val (second, secondExecutor) = send(UUID.randomUUID().toString(), firstConversation, "第二轮问题", "第二轮回答")
            assertEquals(1, second.contextTurns)
            assertEquals(0, second.omittedTurns)
            val messages = secondExecutor.prompts.single().messages
            assertTrue(messages.filterIsInstance<Message.User>().any { it.textContent().contains("第一轮输入") })
            assertTrue(messages.filterIsInstance<Message.Assistant>().any { it.textContent().contains("第一轮回答") })
            assertTrue(messages.filterIsInstance<Message.User>().any { it.textContent().contains("第二轮问题") })

            val (failed, _) = send(UUID.randomUUID().toString(), firstConversation, "失败轮次内容", "不可见", fail = true)
            assertEquals("failed", failed.status)
            val (afterFailure, afterFailureExecutor) = send(UUID.randomUUID().toString(), firstConversation, "失败后的提问", "回答")
            assertEquals(2, afterFailure.contextTurns)
            assertFalse(afterFailureExecutor.prompts.single().messages.filterIsInstance<Message.User>()
                .any { it.textContent().contains("失败轮次内容") })

            val (isolated, isolatedExecutor) = send(UUID.randomUUID().toString(), otherConversation, "另一个会话", "独立回答")
            assertEquals(0, isolated.contextTurns)
            assertEquals(0, isolated.omittedTurns)
            assertFalse(isolatedExecutor.prompts.single().messages.filterIsInstance<Message.User>()
                .any { it.textContent().contains("第一轮输入") })

            val oversizedConversation = createConversation(store)
            val profileTooLargeId = UUID.randomUUID().toString()
            val oversizedProfile = AgentProfileSnapshot("profile-r1", "agent", "node", "x".repeat(MAX_PROFILE_CONTEXT_CHARS + 1))
            val profileError = runCatching {
                owner.submit(profileTooLargeId, "输入", model, "revision-a", oversizedConversation,
                    profile = oversizedProfile, executorFactory = { error("Must not call model") })
            }.exceptionOrNull()
            assertTrue(profileError?.message?.contains("AGENT_PROFILE_CONTEXT_TOO_LARGE") == true)
            assertNull(store.dao.get(profileTooLargeId))

            val promptBudgetConversation = createConversation(store)
            val promptBudgetError = runCatching {
                owner.submit(UUID.randomUUID().toString(), "y".repeat(MAX_TOTAL_PROMPT_TEXT_CHARS - 7_999), model,
                    "revision-a", promptBudgetConversation,
                    profile = AgentProfileSnapshot("profile-r1", "agent", "node", "x".repeat(8_000)),
                    executorFactory = { error("Must not call model") })
            }.exceptionOrNull()
            assertTrue(promptBudgetError?.message?.contains("MODEL_CONTEXT_BUDGET_EXCEEDED") == true)
        } finally {
            owner.close(); repo.db.close(); repo.executor.shutdown()
            context.deleteDatabase("$namespace-${repo.libraryId}.sqlite")
            context.deleteSharedPreferences("$namespace-installation")
        }
    }

    @Test fun contextBudgetKeepsNewestWholeTurnsAndReportsOmissions() {
        val tasks = (0 until 10).map { index ->
            AgentTask(UUID.randomUUID().toString(), "fingerprint", "user-$index", "model", null,
                status = "succeeded", output = "answer-$index")
        }.asReversed()
        val context = FrozenConversationContext.freeze(tasks, totalSuccessfulTurns = 10)
        assertEquals(MAX_CONTEXT_TURNS, context.includedTurns)
        assertEquals(2, context.omittedTurns)
        assertEquals("user-2", context.turns.first().user)
        assertEquals("user-9", context.turns.last().user)
        assertEquals(context.turns, FrozenConversationContext.decode(context.encode()))
    }

    @Test fun frozenContextIsPresentOnEveryToolLoopRequestWithoutReplayingOldTools() = runBlocking {
        val toolExecutor = object : PromptExecutor() {
            val prompts = mutableListOf<Prompt>()
            var call = 0
            override fun executeStreaming(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>) = flow {
                prompts += prompt
                val response = if (call++ == 0)
                    Message.Assistant(MessagePart.Tool.Call("call-current", "current_only", "{}"),
                        ai.koog.prompt.message.ResponseMetaInfo.Empty)
                else Message.Assistant("本轮完成", ai.koog.prompt.message.ResponseMetaInfo.Empty)
                emitAll(response.toStreamFrames().asFlow())
            }
            override suspend fun execute(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>): Message.Assistant = error("streaming expected")
            override suspend fun moderate(prompt: Prompt, model: LLModel): ModerationResult = error("unused")
            override fun close() {}
        }
        val registry = ToolRegistry {
            tool(LibraryTool("current_only", "仅本轮可调用", emptyList()) { "current receipt" })
        }
        val result = NativeAgentProbe().run("当前轮问题", toolExecutor, model, registry,
            conversationContext = listOf(ConversationTurn("旧轮问题", "旧轮回答")))
        assertEquals("本轮完成", result)
        assertEquals(2, toolExecutor.prompts.size)
        toolExecutor.prompts.forEach { prompt ->
            assertEquals(1, prompt.messages.filterIsInstance<Message.User>().count { it.textContent() == "旧轮问题" })
            assertEquals(1, prompt.messages.filterIsInstance<Message.Assistant>().count { it.textContent() == "旧轮回答" })
            assertTrue(prompt.messages.filterIsInstance<Message.User>().any { it.textContent() == "当前轮问题" })
        }
    }
}
