package io.github.wyf929597870.shiwen.library

import org.json.JSONArray
import org.json.JSONObject
import java.util.PriorityQueue
import kotlin.math.sqrt

/** Bounded local scan for unsynced records and offline reading highlights. */
internal class WorkspaceSearch(private val repository: LibraryRepository) {
    private data class Hit(val score: Double, val id: String, val value: JSONObject)
    private val words = Regex("[a-zA-Z0-9]+|[\\p{IsHan}]+")
    private fun terms(text: String): Set<String> = buildSet {
        for (word in words.findAll(text.lowercase())) {
            val value = word.value
            if (value[0].code < 128 || value.length == 1) add(value)
            else for (i in 0 until value.lastIndex) add(value.substring(i, i + 2))
        }
    }
    fun search(args: JSONObject): JSONObject {
        val query = args.getString("query").trim()
        require(query.length in 1..2000)
        val related = args.optBoolean("related")
        val offset = args.optInt("offset", 0)
        val limit = args.optInt("limit", 20)
        require(offset in 0..1000000 && limit in 1..100)
        val wanted = terms(query)
        val order = compareByDescending<Hit> { it.score }.thenBy { it.id }
        val hits = PriorityQueue(order.reversed())
        var total = 0
        var after = ""
        while (true) {
            val batch = repository.dao.workspaceBatch(after)
            if (batch.isEmpty()) break
            for (row in batch) {
                var best = 0.0
                var match: JSONObject? = null
                fun consider(field: String, source: String, excerpt: Int? = null) {
                    val exact = source.indexOf(query, ignoreCase = true)
                    fun keep(score: Double, start: Int, end: Int) {
                        if (score <= best) return
                        best = score
                        match = JSONObject().put("field", field).put("text", source.substring(start,end))
                            .put("anchor", JSONObject().put("start",start).put("end",end).apply {
                                if (excerpt != null) put("excerptIndex", excerpt)
                            })
                    }
                    if (exact >= 0) {
                        val start = maxOf(0, exact - 45)
                        keep(if (field == "title") 3.0 else 2.0, start, minOf(source.length, exact + query.length + 90))
                    } else if (related && wanted.isNotEmpty()) {
                        var start = 0
                        while (start < source.length) {
                            val end = minOf(start + 220, source.length)
                            val terms = terms(source.substring(start, end))
                            val overlap = terms.count { it in wanted }
                            if (overlap >= minOf(2, wanted.size) && terms.isNotEmpty())
                                keep(overlap / sqrt(wanted.size.toDouble() * terms.size), start, end)
                            if (end == source.length) break
                            start = end - 32
                        }
                    }
                }
                consider("title", row.title)
                consider(if (row.kind == "reading_note") "reflection" else "body", row.markdown)
                if (row.kind == "reading_note") {
                    val note = runCatching { JSONObject(row.annotation ?: "") }.getOrNull()
                    consider("chapter", note?.optString("chapter").orEmpty())
                    note?.optJSONArray("excerpts")?.let { excerpts ->
                        for (i in 0 until excerpts.length()) consider("excerpt", excerpts.optJSONObject(i)?.optString("text").orEmpty(), i)
                    }
                }
                if (match != null) {
                    total++
                    val hit = Hit(best, row.id, JSONObject().put("recordId",row.id).put("title",row.title)
                        .put("revision",row.revision).put("origin",row.origin).put("kind",row.kind)
                        .put("contentDay",row.contentDay).put("match",match))
                    if (hits.size < offset + limit) hits.add(hit)
                    else if (order.compare(hit, hits.peek()) < 0) { hits.poll(); hits.add(hit) }
                }
            }
            after = batch.last().id
        }
        return JSONObject().put("libraryScope",repository.libraryId).put("total",total)
            .put("items",JSONArray(hits.sortedWith(order).drop(offset).map { it.value }))
            .put("nextOffset",if (total > offset + limit) offset + limit else JSONObject.NULL)
    }
}
