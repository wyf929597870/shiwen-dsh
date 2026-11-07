package io.github.wyf929597870.shiwen.agent

import ai.koog.agents.core.agent.AIAgent
import ai.koog.agents.core.tools.ToolRegistry
import ai.koog.prompt.Prompt
import ai.koog.prompt.streaming.StreamFrame
import ai.koog.prompt.executor.clients.openai.base.models.OpenAIStreamChoice
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import ai.koog.serialization.typeToken
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.toList
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class ModelTransportTest {
    private lateinit var server: MockWebServer
    private lateinit var config: ModelConfig
    private lateinit var serverTrust: HandshakeCertificates
    private val toolCalls = mutableListOf<String>()

    @Before fun start() {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost")
            .addSubjectAlternativeName("127.0.0.1").build()
        serverTrust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        server = MockWebServer().apply {
            useHttps(serverTls.sslSocketFactory(), false)
            start()
        }
        config = ModelConfig("TLS fixture", server.url("/v1/").toString(), "fixture-model", "p0-test-key", "revision-1")
        toolCalls.clear()
    }

    @After fun stop() { server.shutdown() }

    private fun chunk(delta: String, finish: String? = null): String =
        "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture-model\",\"choices\":[{\"index\":0,\"delta\":$delta,\"finish_reason\":${finish?.let { "\"$it\"" } ?: "null"}}]}\n\n"
    private fun textChunk(text: String, finish: String? = null) =
        chunk("{\"content\":\"$text\"}", finish)
    private fun sse(body: String, status: Int = 200) = MockResponse().setResponseCode(status)
        .addHeader("Content-Type", "text/event-stream; charset=utf-8").setBody(body)
    private fun done() = "data: [DONE]\n\n"
    private fun newExecutor(trust: HandshakeCertificates = serverTrust) = ModelTransport.create(config) { builder ->
        builder.sslSocketFactory(trust.sslSocketFactory(), trust.trustManager)
    }

    @Test fun koogParsesFastSseAndDeliversEveryTextDelta() { runBlocking {
        val parsedFinish = Json { namingStrategy = JsonNamingStrategy.SnakeCase; ignoreUnknownKeys = true }
            .decodeFromString(OpenAIStreamChoice.serializer(), "{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}")
        assertEquals("stop", parsedFinish.finishReason)
        val trust = serverTrust
        val expected = (0 until 400).joinToString("") { "记录$it🌱" }
        val body = buildString {
            for (index in 0 until 400) append(textChunk("记录$index🌱"))
            append(textChunk("", "stop")); append(done())
        }
        server.enqueue(sse(body))
        newExecutor(trust).use { client ->
            val received = client.executeStreaming(Prompt.build("probe") { user("逐段返回") }, ModelTransport.model(config), emptyList())
                .toList().filterIsInstance<StreamFrame.TextDelta>().joinToString("") { it.text }
            assertEquals(expected, received)
        }
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/chat/completions", request.path)
        assertEquals("Bearer p0-test-key", request.getHeader("Authorization"))
        assertEquals("fixture-model", request.body.readUtf8().substringAfter("\"model\":\"").substringBefore('"'))
        assertEquals(1, server.requestCount)
    } }

    @Test fun koogExecutesOneToolCallThenReturnsFinalAnswer() { runBlocking {
        val trust = serverTrust
        server.enqueue(sse(chunk("{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"save_note\",\"arguments\":\"{\\\"text\\\":\\\"原文\\\"}\"}}]}", "tool_calls") + done()))
        server.enqueue(sse(textChunk("已保存", "stop") + done()))
        newExecutor(trust).use { client ->
            val saveTool = LibraryTool("save_note", "保存当前明确批准的原文", listOf("text")) { args ->
                toolCalls += args.getValue("text"); "receipt:applied"
            }
            val registry = ToolRegistry { tool(saveTool) }
            assertEquals("已保存", NativeAgentProbe().run("保存原文", client, ModelTransport.model(config), registry))
        }
        assertEquals(listOf("原文"), toolCalls)
        assertEquals(2, server.requestCount)
        val first = server.takeRequest(); val second = server.takeRequest()
        assertTrue(first.body.readUtf8().contains("save_note"))
        assertTrue(second.body.readUtf8().contains("receipt:applied"))
    } }

    @Test fun streamWithoutDoneFailsBeforeToolDispatchAndIsNotRetried() { runBlocking {
        val trust = serverTrust
        val partial = chunk("{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"save_note\",\"arguments\":\"{\\\"text\\\":\\\"完整参数但无终止标记\\\"}\"}}]}", "tool_calls")
        server.enqueue(sse(partial)) // Finish reason alone is insufficient; OpenAI-compatible [DONE] is required.
        newExecutor(trust).use { client ->
            val saveTool = LibraryTool("save_note", "保存", listOf("text")) { args -> toolCalls += args.getValue("text"); "applied" }
            assertTrue(runCatching {
                NativeAgentProbe().run("保存", client, ModelTransport.model(config), ToolRegistry { tool(saveTool) })
            }.isFailure)
        }
        assertTrue(toolCalls.isEmpty())
        assertEquals(1, server.requestCount)
        server.takeRequest()
    } }

    @Test fun lengthAndFilteredFinishReasonsAreRejected() { runBlocking {
        val trust = serverTrust
        for (reason in listOf("length", "content_filter")) {
            server.enqueue(sse(textChunk("部分回答", reason) + done()))
            newExecutor(trust).use { client ->
                val result = runCatching {
                    client.executeStreaming(Prompt.build("probe") { user("返回") }, ModelTransport.model(config), emptyList()).toList()
                }
                assertTrue("$reason must fail closed", result.isFailure)
            }
        }
        assertEquals(2, server.requestCount)
        server.takeRequest(); server.takeRequest()
    } }

    @Test fun redirectsAndQuotaErrorsAreNeverRetriedOrFollowed() { runBlocking {
        val trust = serverTrust
        server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", "/v1/other"))
        assertTrue(runCatching {
            newExecutor(trust).use { it.executeStreaming(Prompt.build("probe") { user("请求") }, ModelTransport.model(config), emptyList()).toList() }
        }.isFailure)
        server.takeRequest()
        server.enqueue(MockResponse().setResponseCode(429).setBody("quota"))
        assertTrue(runCatching {
            newExecutor(trust).use { it.executeStreaming(Prompt.build("probe") { user("请求") }, ModelTransport.model(config), emptyList()).toList() }
        }.isFailure)
        server.takeRequest()
        assertEquals(2, server.requestCount)
    } }
}
