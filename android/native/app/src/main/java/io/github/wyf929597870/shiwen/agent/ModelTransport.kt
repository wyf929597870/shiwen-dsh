package io.github.wyf929597870.shiwen.agent

import ai.koog.http.client.ktor.KtorKoogHttpClient
import ai.koog.prompt.Prompt
import ai.koog.agents.core.tools.ToolDescriptor
import ai.koog.prompt.dsl.ModerationResult
import ai.koog.prompt.executor.clients.ConnectionTimeoutConfig
import ai.koog.prompt.executor.clients.openai.OpenAIClientSettings
import ai.koog.prompt.executor.clients.openai.OpenAILLMClient
import ai.koog.prompt.executor.llms.MultiLLMPromptExecutor
import ai.koog.prompt.executor.model.PromptExecutor
import ai.koog.prompt.llm.*
import ai.koog.prompt.message.Message
import ai.koog.prompt.streaming.StreamFrame
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.Interceptor
import okhttp3.ResponseBody
import okio.Buffer
import okio.ForwardingSource
import okio.BufferedSource
import okio.buffer
import java.io.IOException
import java.util.concurrent.atomic.AtomicReference

internal object ModelTransport {
    fun model(config: ModelConfig) = LLModel(LLMProvider.OpenAI, config.model,
        listOf(LLMCapability.Completion, LLMCapability.Tools, LLMCapability.OpenAIEndpoint.Completions),
        contextLength = 32_000, maxOutputTokens = 4_096)

    fun create(config: ModelConfig, configureNetwork: (OkHttpClient.Builder) -> Unit = {}): PromptExecutor {
        ModelConfigStore.normalizeUrl(config.baseUrl)
        val completion = AtomicReference<StreamCompletion?>(null)
        val serial = Mutex()
        val builder = OkHttpClient.Builder()
        configureNetwork(builder)
        val network = builder.followRedirects(false).followSslRedirects(false)
            .retryOnConnectionFailure(false).addInterceptor(RequireCompletedSse(completion)).build()
        val base = HttpClient(OkHttp) {
            followRedirects = false
            engine { preconfigured = network }
        }
        try {
            val client = OpenAILLMClient(apiKey = config.apiKey,
                settings = OpenAIClientSettings(baseUrl = config.baseUrl, chatCompletionsPath = "chat/completions",
                    timeoutConfig = ConnectionTimeoutConfig(180_000, 15_000, 60_000)),
                httpClientFactory = KtorKoogHttpClient.Factory(baseClient = base))
            val delegate = MultiLLMPromptExecutor(client)
            return object : PromptExecutor() {
                override suspend fun execute(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>): Message.Assistant =
                    error("STREAMING_REQUIRED")
                override fun executeStreaming(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>): Flow<StreamFrame> =
                    checkedStream(delegate.executeStreaming(prompt, model, tools), completion, serial)
                override suspend fun moderate(prompt: Prompt, model: LLModel): ModerationResult = error("NOT_SUPPORTED")
                override fun close() {
                    try { delegate.close() } finally {
                        base.close(); network.dispatcher.cancelAll()
                        network.connectionPool.evictAll(); network.dispatcher.executorService.shutdown()
                    }
                }
            }
        } catch (error: Exception) {
            base.close(); network.dispatcher.executorService.shutdown()
            throw error
        }
    }

    /** Buffering by NativeAgentProbe happens above this boundary. Tool frames are buffered until
     * the wire-level [DONE] and a valid finish reason have both been observed. */
    private fun checkedStream(upstream: Flow<StreamFrame>, tracker: AtomicReference<StreamCompletion?>,
        serial: Mutex): Flow<StreamFrame> = flow {
        serial.withLock {
            val state = StreamCompletion()
            check(tracker.compareAndSet(null, state)) { "MODEL_STREAM_ALREADY_ACTIVE" }
        var ended = false
            try {
                upstream.collect { frame ->
                    if (frame is StreamFrame.End) {
                        val reason = frame.finishReason
                        check(state.completed && (reason == "stop" || reason == "tool_calls")) {
                            "MODEL_RESPONSE_INCOMPLETE"
                        }
                        ended = true
                        emit(frame)
                    } else emit(frame)
                }
                check(ended && state.completed) { "MODEL_RESPONSE_INCOMPLETE" }
            } finally { tracker.compareAndSet(state, null) }
        }
    }
}

/** Koog's Ktor SSE adapter emits an End frame when HTTP closes cleanly, even if the provider
 * omitted its OpenAI [DONE] sentinel. Convert that case into a transport failure. */
private class StreamCompletion {
    @Volatile var finishReason: String? = null
    @Volatile var completed: Boolean = false
}

private class RequireCompletedSse(private val tracker: AtomicReference<StreamCompletion?>) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): okhttp3.Response {
        val response = chain.proceed(chain.request())
        if (response.request.header("Accept")?.contains("text/event-stream") != true || !response.isSuccessful) return response
        val body = response.body ?: throw IOException("MODEL_STREAM_BODY_MISSING")
        val state = tracker.get() ?: throw IOException("MODEL_STREAM_STATE_MISSING")
        val line = StringBuilder()
        val checking = object : ForwardingSource(body.source()) {
            override fun read(sink: Buffer, byteCount: Long): Long {
                val offset = sink.size
                val count = super.read(sink, byteCount)
                if (count > 0L && !state.completed) {
                    val copy = Buffer()
                    sink.copyTo(copy, offset, count)
                    copy.readByteArray().forEach { inspectByte(it.toInt() and 0xff, line, state) }
                } else if (count == -1L) {
                    if (line.isNotEmpty()) inspectLine(line.toString(), state)
                    if (!state.completed) throw IOException("MODEL_STREAM_INCOMPLETE")
                }
                return count
            }
        }
        val checkedSource = checking.buffer()
        val checkedBody = object : ResponseBody() {
            override fun contentType() = body.contentType()
            override fun contentLength() = body.contentLength()
            override fun source(): BufferedSource = checkedSource
        }
        return response.newBuilder().body(checkedBody).build()
    }
    private fun inspectByte(byte: Int, line: StringBuilder, state: StreamCompletion) {
        if (byte == '\n'.code) {
            inspectLine(line.toString().trimEnd('\r'), state)
            line.setLength(0)
        } else {
            line.append(byte.toChar())
            if (line.length > MAX_SSE_LINE) throw IOException("MODEL_STREAM_EVENT_TOO_LARGE")
        }
    }
    private fun inspectLine(eventLine: String, state: StreamCompletion) {
        if (!eventLine.startsWith("data:")) return
        val data = eventLine.substringAfter("data:").trim()
        if (data == "[DONE]") {
            if (state.finishReason != "stop" && state.finishReason != "tool_calls")
                throw IOException("MODEL_STREAM_FINISH_REASON_INVALID")
            state.completed = true
            return
        }
        val reason = FINISH_REASON.find(data)?.groupValues?.get(1) ?: return
        if (reason != "stop" && reason != "tool_calls") throw IOException("MODEL_STREAM_FINISH_REASON_INVALID")
        state.finishReason = reason
    }
    companion object {
        private const val MAX_SSE_LINE = 1_048_576
        private val FINISH_REASON = Regex("\\\"finish_reason\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"")
    }
}
