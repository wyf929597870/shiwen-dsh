package io.github.wyf929597870.shiwen.library

import org.json.JSONArray
import org.json.JSONObject

/** Mirrors the offline passage scoring used by the desktop discovery worker. */
internal object FollowupPassages {
    private val common = "今天 昨天 后来 这个 那个 时候 什么 怎么 为什么 如何 是否 自己 一个 我的 我在 可以 已经 还是 如果 因为 觉得 有点 事情 之后 开始 继续 可能 真的 我想 发现 the and that with from this".split(" ").toSet()
    private val words = Regex("[\\p{IsHan}]+|[a-z0-9]{3,}")
    private val sentences = Regex("[^\\r\\n。！？!?]{1,240}[。！？!?]?")
    private fun terms(text: String): Set<String> = words.findAll(text.lowercase()).flatMap {
        val word = it.value
        if (word.first() in 'a'..'z' || word.first() in '0'..'9') sequenceOf(word)
        else word.windowed(2).asSequence()
    }.toSet() - common

    data class Passage(val terms: Set<String>, val locator: JSONObject)

    fun extract(record: LibraryRecord): List<Passage> {
        if (record.origin != "personal" || record.kind !in setOf("journal","freewrite","idea","reading_note","article")) return emptyList()
        val passages = mutableListOf<Passage>()
        var offset = 0
        for (span in JSONArray(record.sourcesJson).objects()) {
            val text = span.getString("text")
            if (span.getString("origin") == "personal") for (sentence in sentences.findAll(text)) {
                val quote = sentence.value.trim()
                val words = terms(quote)
                if (quote.length < 6 || words.size < 2) continue
                val start = offset + sentence.range.first + sentence.value.indexOf(quote)
                passages.add(Passage(words,obj("quote" to quote,"start" to start,"end" to start+quote.length,
                    "field" to if (record.kind=="reading_note") "reflection" else "body")))
            }
            offset += text.length
        }
        return passages
    }

    fun match(passages: List<Passage>, question: String, context: String): Pair<Int,JSONObject>? {
        val topic = terms(question)
        val background = terms(context) - topic
        return passages.mapNotNull { p ->
            val direct = p.terms.count(topic::contains)
            val score = direct * 2 + minOf(4,p.terms.count(background::contains))
            if (score >= 4) score to p.locator else null
        }.maxByOrNull { it.first }
    }
}
