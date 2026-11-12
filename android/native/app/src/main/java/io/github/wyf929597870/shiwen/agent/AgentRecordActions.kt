package io.github.wyf929597870.shiwen.agent

import io.github.wyf929597870.shiwen.library.LibraryMeta
import io.github.wyf929597870.shiwen.library.LibraryRepository
import io.github.wyf929597870.shiwen.model.Canonical
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Callable

/** Model suggestions are durable proposals. Only a separate user decision may apply them. */
internal class AgentRecordActions(private val repo: LibraryRepository) {
    private val key = "local-agent-record-proposals-v1"
    private fun rows() = JSONArray(repo.dao.meta(key) ?: "[]")
    private fun save(rows: JSONArray) = repo.dao.putMeta(LibraryMeta(key,rows.toString()))

    fun list(conversationId: String): JSONArray {
        val all = rows(); val result = JSONArray()
        for (i in 0 until all.length()) all.getJSONObject(i).takeIf { it.optString("conversationId") == conversationId }?.let(result::put)
        return result
    }

    fun propose(taskId: String, conversationId: String, action: String, recordId: String?, patch: JSONObject): JSONObject {
        require(action in setOf("create","update","delete","restore"))
        require(patch.toString().length <= 100_000) { "PROPOSAL_TOO_LARGE" }
        val fields = patch.keys().asSequence().toSet()
        require(fields.all { it in setOf("title","markdown","kind","origin","processing","contentDay","dateBasis","url","annotation","stage") }) { "PROPOSAL_FIELD_DENIED" }
        val before = if (action == "create") null else repo.read(requireNotNull(recordId))
        if (action == "delete") check(before?.deleted == false) { "RECORD_ALREADY_DELETED" }
        if (action == "restore") check(before?.deleted == true) { "RECORD_NOT_DELETED" }
        val fingerprint = Canonical.hash(mapOf("taskId" to taskId,"conversationId" to conversationId,
            "action" to action,"recordId" to recordId,"patch" to plain(patch),"revision" to before?.revision))
        val id = UUID.nameUUIDFromBytes("${repo.libraryId}:$fingerprint".toByteArray()).toString()
        return repo.db.runInTransaction(Callable {
            val all = rows()
            for (i in 0 until all.length()) if (all.getJSONObject(i).getString("id") == id) return@Callable all.getJSONObject(i)
            check(all.length() < 500) { "PROPOSAL_LIMIT_REACHED" }
            val proposal = JSONObject().put("id",id).put("libraryId",repo.libraryId).put("taskId",taskId)
                .put("conversationId",conversationId).put("action",action).put("recordId",recordId ?: JSONObject.NULL)
                .put("expectedRevision",before?.revision ?: JSONObject.NULL).put("beforeTitle",before?.title ?: "")
                .put("beforeMarkdown",before?.markdown?.take(8000) ?: "").put("beforeTruncated",(before?.markdown?.length ?: 0)>8000)
                .put("patch",patch).put("status","pending")
                .put("createdAt",Instant.now().toString())
            all.put(proposal);save(all);proposal
        })
    }

    fun decide(id: String, conversationId: String, accept: Boolean): JSONObject = repo.db.runInTransaction(Callable {
        val all = rows()
        val item = (0 until all.length()).map(all::getJSONObject).find { it.getString("id") == id }
            ?: error("PROPOSAL_NOT_FOUND")
        check(item.getString("conversationId") == conversationId) { "CONVERSATION_MISMATCH" }
        if (item.getString("status") != "pending") return@Callable item
        if (!accept) {item.put("status","rejected");save(all);return@Callable item}
        val patch = JSONObject(item.getJSONObject("patch").toString())
        val action = item.getString("action")
        // A model cannot relabel generated text as the user's original words.
        if (patch.has("markdown")) patch.put("origin","ai").put("processing","original")
            .put("sources",JSONArray().put(JSONObject().put("text",patch.getString("markdown"))
                .put("origin","ai").put("sourceRef","phone-agent:${item.getString("taskId")}")))
        val record = if (action == "create") {
            require(patch.optString("markdown").isNotBlank()) { "RECORD_EMPTY" }
            repo.create(id,patch.put("origin","ai"),1)
        } else {
            val recordId = item.getString("recordId")
            if (action == "delete") patch.put("deleted",true)
            if (action == "restore") patch.put("deleted",false)
            repo.update(recordId,item.getLong("expectedRevision"),id,patch,allowOriginCorrection=patch.has("origin"))
        }
        item.put("status","applied").put("recordId",record.id).put("versionId",record.versionId)
            .put("appliedAt",Instant.now().toString());save(all);item
    })

    fun review(start: String, end: String): JSONObject {
        val from=java.time.LocalDate.parse(start);val through=java.time.LocalDate.parse(end)
        require(!through.isBefore(from) && java.time.temporal.ChronoUnit.DAYS.between(from,through)<=366) { "INVALID_REVIEW_RANGE" }
        return AgentLibraryQuery(repo).byDate(start,end,limit=200)
    }

    private fun plain(value: Any?): Any? = when(value){
        JSONObject.NULL -> null
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        else -> value
    }
}
