package io.github.wyf929597870.shiwen.agent

import io.github.wyf929597870.shiwen.library.LibraryMeta
import io.github.wyf929597870.shiwen.library.LibraryRepository
import io.github.wyf929597870.shiwen.model.Canonical
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Callable

/** Library-local persona and explicitly confirmed memories. No model or node credentials. */
internal class LocalAgentProfileStore(private val repo: LibraryRepository) {
    private val key="local-agent-profile-v1"
    fun read(): JSONObject = repo.dao.meta(key)?.let(::JSONObject) ?: JSONObject()
        .put("revision",0).put("identity","你是拾文助手，帮助用户记录、整理资料、思考和创作。")
        .put("soul","专业、坦诚、温和，尊重原文与来源；不把猜测写成事实。")
        .put("user","").put("memories",JSONArray())
    fun save(expectedRevision: Long, identity: String, soul: String, user: String): JSONObject = repo.db.runInTransaction(Callable {
        val state=read();check(state.getLong("revision")==expectedRevision) { "PROFILE_REVISION_CONFLICT" }
        require(identity.isNotBlank()&&identity.length<=3000&&soul.length<=3000&&user.length<=2000) { "PROFILE_DOCUMENT_INVALID" }
        state.put("identity",identity).put("soul",soul).put("user",user);persist(state)
    })
    fun memory(expectedRevision: Long, id: String?, body: String?, action: String): JSONObject = repo.db.runInTransaction(Callable {
        val state=read();check(state.getLong("revision")==expectedRevision) { "PROFILE_REVISION_CONFLICT" }
        require(action in setOf("save","delete","accept","reject"))
        val memories=state.getJSONArray("memories")
        val items=(0 until memories.length()).map(memories::getJSONObject).toMutableList()
        val existing=items.find { it.getString("id")==id }
        when(action){
            "save" -> {require(!body.isNullOrBlank()&&body.length<=2000) { "MEMORY_INVALID" }
                if(existing!=null)existing.put("body",body).put("status","active")
                else {check(items.size<500) { "MEMORY_LIMIT_REACHED" };items.add(JSONObject().put("id",UUID.randomUUID().toString()).put("body",body).put("status","active"))}}
            "accept" -> checkNotNull(existing) { "MEMORY_NOT_FOUND" }.put("status","active")
            else -> {check(existing!=null) { "MEMORY_NOT_FOUND" };items.remove(existing)}
        }
        state.put("memories",JSONArray(items));persist(state)
    })
    fun propose(taskId: String, body: String): JSONObject = repo.db.runInTransaction(Callable {
        require(body.isNotBlank()&&body.length<=2000)
        val state=read();val memories=state.getJSONArray("memories")
        val id=UUID.nameUUIDFromBytes("${repo.libraryId}:$taskId:$body".toByteArray()).toString()
        for(i in 0 until memories.length())if(memories.getJSONObject(i).getString("id")==id)return@Callable memories.getJSONObject(i)
        check(memories.length()<500) { "MEMORY_LIMIT_REACHED" }
        val item=JSONObject().put("id",id).put("body",body).put("status","candidate").put("taskId",taskId)
        memories.put(item);persist(state);item
    })
    private fun persist(state: JSONObject): JSONObject {
        state.put("revision",state.getLong("revision")+1).put("updatedAt",Instant.now().toString())
        repo.dao.putMeta(LibraryMeta(key,state.toString()));return state
    }
    fun snapshot(): JSONObject {
        val state=read();val context=StringBuilder()
        listOf("identity","soul","user").forEach { field -> context.append("\n[$field]\n").append(state.optString(field)) }
        val memories=state.getJSONArray("memories");var omitted=0
        for(i in 0 until memories.length()){
            val item=memories.getJSONObject(i);if(item.optString("status")!="active")continue
            val text="\n[已确认记忆 ${item.getString("id")}] ${item.getString("body")}"
            if(context.length+text.length<=MAX_PROFILE_CONTEXT_CHARS-200)context.append(text) else omitted++
        }
        if(omitted>0)context.append("\n另有 $omitted 条已确认记忆未注入本轮上下文。")
        return JSONObject().put("revision",Canonical.hash(mapOf("libraryId" to repo.libraryId,"context" to context.toString())))
            .put("agentId","shiwen-phone").put("nodeId","phone:${repo.libraryId}")
            .put("systemContext",context.toString()).put("omittedMemories",omitted)
    }
}
