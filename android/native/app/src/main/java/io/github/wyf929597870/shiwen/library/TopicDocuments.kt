package io.github.wyf929597870.shiwen.library

import org.json.JSONObject

/** Read and write within the caller's Room transaction. Existing unchunked phone themes remain readable. */
internal class TopicDocuments(private val dao: LibraryDao) {
    fun ids(prefix: String) = dao.topicKeys(prefix).map { it.removePrefix(prefix) }

    fun read(key: String): JSONObject? {
        val value = dao.meta(key)?.let(::JSONObject) ?: return null
        val count = value.optInt("_chunks")
        if (count == 0) return value
        return JSONObject(buildString {
            for (i in 0 until count) append(checkNotNull(dao.meta("topic-part:$key:$i")))
        })
    }

    fun write(key: String, value: JSONObject?) {
        val previous = dao.meta(key)?.let(::JSONObject)?.optInt("_chunks") ?: 0
        var count = 0
        if (value == null) dao.removeWorkspaceMeta(key)
        else {
            val data = value.toString()
            if (data.length <= 100000) dao.putMeta(LibraryMeta(key,data))
            else {
                var start = 0
                while (start < data.length) {
                    var end = minOf(start + 100000,data.length)
                    if (end < data.length && data[end-1].isHighSurrogate()) end--
                    dao.putMeta(LibraryMeta("topic-part:$key:$count",data.substring(start,end)))
                    count++
                    start = end
                }
                val header = obj("_chunks" to count)
                if (value.has("members")) {
                    for (field in listOf("id","title","summary","revision")) header.put(field,value.get(field))
                    header.put("memberCount",value.getJSONArray("members").length())
                }
                dao.putMeta(LibraryMeta(key,header.toString()))
            }
        }
        for (i in count until previous) dao.removeWorkspaceMeta("topic-part:$key:$i")
    }
}
