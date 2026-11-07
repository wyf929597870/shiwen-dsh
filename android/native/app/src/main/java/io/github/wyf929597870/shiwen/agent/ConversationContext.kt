package io.github.wyf929597870.shiwen.agent

import ai.koog.prompt.Prompt
import org.json.JSONArray
import org.json.JSONObject

internal data class ConversationTurn(val user: String, val assistant: String)

internal data class AgentProfileSnapshot(val revision: String, val agentId: String, val nodeId: String,
    val systemContext: String)

internal data class FrozenConversationContext(val turns: List<ConversationTurn>, val omittedTurns: Int) {
    val includedTurns: Int get() = turns.size
    fun encode(): String = JSONArray().apply {
        turns.forEach { put(JSONObject().put("user", it.user).put("assistant", it.assistant)) }
    }.toString()

    companion object {
        fun decode(encoded: String): List<ConversationTurn> = runCatching {
            val array = JSONArray(encoded)
            (0 until array.length()).map { index ->
                val item = array.getJSONObject(index)
                ConversationTurn(item.getString("user"), item.getString("assistant"))
            }
        }.getOrElse { throw IllegalStateException("CONVERSATION_CONTEXT_CORRUPT") }

        fun freeze(recentNewestFirst: List<AgentTask>, totalSuccessfulTurns: Int,
            maxChars: Int = MAX_CONTEXT_CHARS): FrozenConversationContext {
            val turnsNewestFirst = recentNewestFirst.map { ConversationTurn(it.input, it.output) }
            val selectedNewestFirst = mutableListOf<ConversationTurn>()
            var chars = 0
            for (turn in turnsNewestFirst) {
                val size = turn.user.length + turn.assistant.length
                if (selectedNewestFirst.size >= MAX_CONTEXT_TURNS || chars + size > maxChars) break
                selectedNewestFirst += turn
                chars += size
            }
            val turns = selectedNewestFirst.asReversed()
            return FrozenConversationContext(turns, (totalSuccessfulTurns - turns.size).coerceAtLeast(0))
        }
    }
}

/** Add only prior successful plain-text turns before the current run's prompt. The same frozen
 * turns are supplied to every model request in the current tool loop; tool messages stay local. */
internal fun Prompt.withConversationContext(turns: List<ConversationTurn>): Prompt {
    if (turns.isEmpty()) return this
    val systemCount = messages.takeWhile { it is ai.koog.prompt.message.Message.System }.size
    val body = messages.drop(systemCount)
    val alreadyPresent = turns.indices.all { index ->
        val user = body.getOrNull(index * 2) as? ai.koog.prompt.message.Message.User
        val assistant = body.getOrNull(index * 2 + 1) as? ai.koog.prompt.message.Message.Assistant
        user?.textContent() == turns[index].user && assistant?.textContent() == turns[index].assistant
    }
    if (alreadyPresent) return this
    val history = Prompt.build("conversation-context") {
        turns.forEach { user(it.user); assistant(it.assistant) }
    }.messages
    return copy(messages = messages.take(systemCount) + history + messages.drop(systemCount))
}

internal const val MAX_CONTEXT_TURNS = 8
internal const val MAX_CONTEXT_CHARS = 8_000
internal const val MAX_TOTAL_PROMPT_TEXT_CHARS = 24_000
internal const val MAX_PROFILE_CONTEXT_CHARS = 12_000
