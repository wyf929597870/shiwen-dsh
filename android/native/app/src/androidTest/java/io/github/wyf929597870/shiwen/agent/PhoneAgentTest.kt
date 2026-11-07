package io.github.wyf929597870.shiwen.agent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ai.koog.agents.core.tools.ToolDescriptor
import ai.koog.prompt.Prompt
import ai.koog.prompt.dsl.ModerationResult
import ai.koog.prompt.executor.model.PromptExecutor
import ai.koog.prompt.llm.LLModel
import ai.koog.prompt.message.*
import ai.koog.prompt.streaming.*
import io.github.wyf929597870.shiwen.probe.ProbeRepository
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PhoneAgentTest {
    @Test fun providerClientInitializesOnAndroidWithoutSendingARequest() {
        ModelTransport.create(ModelConfig("测试", "https://model.invalid/v1/", "test-model",
            "only-a-test-secret", UUID.randomUUID().toString())).close()
    }
    @Test fun facadeExposesActualReceiptWithoutSecretsOrDuplicateCalls() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "phone-agent-test-${UUID.randomUUID()}"
        val repo = ProbeRepository(context, namespace)
        val configs = ModelConfigStore(context, "$namespace-config")
        val store = AgentTaskStore(context, repo.libraryId, "$namespace-tasks")
        var starts = 0
        val service = PhoneAgent(context, repo, configs, store, executorFactory = {
            starts++
            object : PromptExecutor() {
                var count = 0
                override fun executeStreaming(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>) = flow {
                    val response = if (count++ == 0) {
                        assertTrue(tools.any { it.name == "save_approved_record" })
                        Message.Assistant(MessagePart.Tool.Call("call-1", "save_approved_record", "{}"), ResponseMetaInfo.Empty)
                    } else Message.Assistant("原文已保存", ResponseMetaInfo.Empty)
                    emitAll(response.toStreamFrames().asFlow())
                }
                override suspend fun execute(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>): Message.Assistant = error("unused")
                override suspend fun moderate(prompt: Prompt, model: LLModel): ModerationResult = error("unused")
                override fun close() {}
            }
        }, profileProvider = { null })
        try {
            val config = configs.save("测试供应商", "https://model.invalid/v1", "test-model", "only-a-test-secret")
            assertEquals(0, starts)
            val conversationId = UUID.randomUUID().toString()
            assertEquals(conversationId, service.createConversation(conversationId).getString("activeId"))
            val otherConversationId = UUID.randomUUID().toString()
            service.createConversation(otherConversationId)
            val id = UUID.randomUUID().toString()
            val input = "今天写下的原话🌱"
            service.saveDraft(id, input, true, "journal", 1, conversationId)
            val otherDraftId = UUID.randomUUID().toString()
            service.saveDraft(otherDraftId, "另一个会话草稿", false, "idea", 1, otherConversationId)
            service.saveDraft(id, "迟到的旧稿", true, "journal", 0, conversationId)
            assertTrue(runCatching { service.saveDraft(id, "代次复用", true, "journal", 1, conversationId) }.isFailure)
            assertEquals(input, service.readDraft(conversationId).getJSONObject("draft").getString("input"))
            assertEquals("另一个会话草稿", service.readDraft(otherConversationId).getJSONObject("draft").getString("input"))
            service.send(id, input, true, "journal", config.revision, conversationId)
            withTimeout(10_000) { while (service.status(id, conversationId).getString("status") != "succeeded") delay(10) }
            val result = service.status(id, conversationId)
            val recordId = checkNotNull(result.getString("recordId"))
            assertEquals(input, repo.db.dao().record(recordId)?.markdown)
            assertFalse(result.toString().contains("only-a-test-secret"))
            service.send(id, input, true, "journal", config.revision, conversationId)
            assertEquals(1, starts); assertEquals(1, repo.db.dao().records(0, 30).size)
            store.dao.saveDraft(AgentDraft(slot = conversationId, requestId = id, input = "$input，新文字", saveOriginal = false, kind = "idea", generation = 2, conversationId = conversationId))
            service.acknowledge(id, 1, conversationId)
            assertEquals(2L, service.readDraft(conversationId).getJSONObject("draft").getLong("localGeneration"))
            assertTrue(runCatching { service.acknowledge(id, 2, conversationId) }.isFailure)
            assertEquals("$input，新文字", service.readDraft(conversationId).getJSONObject("draft").getString("input"))
            store.dao.saveDraft(AgentDraft(slot = conversationId, requestId = id, input = input, saveOriginal = true, kind = "idea", generation = 3, conversationId = conversationId))
            assertTrue(runCatching { service.acknowledge(id, 3, conversationId) }.isFailure)
            store.dao.saveDraft(AgentDraft(slot = conversationId, requestId = id, input = input, saveOriginal = true, kind = "journal", generation = 4, conversationId = conversationId))
            service.acknowledge(id, 4, conversationId)
            assertTrue(service.readDraft(conversationId).isNull("draft"))
            service.saveDraft(id, input, true, "journal", 1, conversationId)
            assertTrue(service.readDraft(conversationId).isNull("draft"))
            assertTrue(runCatching { service.send(id, "改写请求", true, "journal", config.revision, conversationId) }.isFailure)
            val changed = configs.save("测试供应商", config.baseUrl, config.model, "")
            assertTrue(runCatching {
                val otherConversation = UUID.randomUUID().toString()
                service.createConversation(otherConversation)
                service.send(UUID.randomUUID().toString(), input, false, "idea", config.revision, otherConversation)
            }.isFailure)
            assertNotEquals(config.revision, changed.revision); assertEquals(1, starts)
            assertEquals(recordId, service.recent(conversationId).getJSONArray("items").getJSONObject(0).getString("recordId"))
            assertTrue(runCatching { service.status(id, otherConversationId) }.isFailure)
            assertTrue(runCatching { service.acknowledge(id, 1, otherConversationId) }.isFailure)
            service.selectConversation(conversationId)
            assertEquals(conversationId, service.conversations().getString("activeId"))
            service.close()
            val restored = PhoneAgent(context, repo, configs,
                AgentTaskStore(context, repo.libraryId, "$namespace-tasks"),
                executorFactory = { error("Persisted conversations never call a model") }, profileProvider = { null })
            try {
                assertEquals(conversationId, restored.conversations().getString("activeId"))
                assertEquals("另一个会话草稿", restored.readDraft(otherConversationId).getJSONObject("draft").getString("input"))
                assertEquals("succeeded", restored.status(id, conversationId).getString("status"))
            } finally { restored.close() }
        } finally {
            runCatching { service.close() }; configs.clear(); repo.db.close(); repo.executor.shutdown()
            context.deleteDatabase("$namespace-${repo.libraryId}.sqlite")
            context.deleteDatabase("$namespace-tasks-${repo.libraryId}.sqlite")
            context.deleteSharedPreferences("$namespace-installation")
            context.deleteSharedPreferences("$namespace-config")
        }
    }

    @Test fun conversationFreezesProfileSnapshotAndRejectsAnotherNode() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "phone-agent-profile-${UUID.randomUUID()}"
        val repo = ProbeRepository(context, namespace)
        val configs = ModelConfigStore(context, "$namespace-config")
        val store = AgentTaskStore(context, repo.libraryId, "$namespace-tasks")
        val config = configs.save("本机测试", "https://model.invalid/v1", "fixture", "test-key")
        var profile = JSONObject().put("revision", "profile-r1").put("agentId", "agent-a")
            .put("nodeId", "node-a").put("systemContext", "人格快照 A：温和、直接")
        var modelCalls = 0
        val service = PhoneAgent(context, repo, configs, store, executorFactory = {
            modelCalls++
            object : PromptExecutor() {
                override fun executeStreaming(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>) = flow {
                    val systemText = prompt.messages.filterIsInstance<Message.System>().joinToString("\n") { it.textContent() }
                    assertTrue(systemText.contains("人格快照 A") || systemText.contains("人格快照 B"))
                    emitAll(Message.Assistant("按当前人设回答", ResponseMetaInfo.Empty).toStreamFrames().asFlow())
                }
                override suspend fun execute(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>): Message.Assistant = error("unused")
                override suspend fun moderate(prompt: Prompt, model: LLModel): ModerationResult = error("unused")
                override fun close() {}
            }
        }, profileProvider = { profile })
        try {
            val firstConversation = UUID.randomUUID().toString()
            service.createConversation(firstConversation)
            val firstId = UUID.randomUUID().toString()
            service.send(firstId, "你好", false, "idea", config.revision, firstConversation)
            withTimeout(10_000) { while (service.status(firstId, firstConversation).getString("status") != "succeeded") delay(10) }
            val item = service.conversations().getJSONArray("items").let { array ->
                (0 until array.length()).map { array.getJSONObject(it) }.first { it.getString("id") == firstConversation }
            }
            assertEquals("profile-r1", item.getString("profileRevision"))
            assertEquals("node-a", item.getString("profileNodeId"))

            profile = JSONObject().put("revision", "profile-r2").put("agentId", "agent-b")
                .put("nodeId", "node-b").put("systemContext", "人格快照 B：严谨、简洁")
            assertTrue(runCatching {
                service.send(UUID.randomUUID().toString(), "继续", false, "idea", config.revision, firstConversation)
            }.exceptionOrNull()?.message?.contains("PROFILE_CHANGED") == true)
            val secondConversation = UUID.randomUUID().toString()
            service.createConversation(secondConversation)
            val secondId = UUID.randomUUID().toString()
            service.send(secondId, "新会话", false, "idea", config.revision, secondConversation)
            withTimeout(10_000) { while (service.status(secondId, secondConversation).getString("status") != "succeeded") delay(10) }
            assertEquals(2, modelCalls)
        } finally {
            service.close(); configs.clear(); repo.db.close(); repo.executor.shutdown()
            context.deleteDatabase("$namespace-${repo.libraryId}.sqlite")
            context.deleteDatabase("$namespace-tasks-${repo.libraryId}.sqlite")
            context.deleteSharedPreferences("$namespace-installation")
            context.deleteSharedPreferences("$namespace-config")
        }
    }
}
