package io.github.wyf929597870.shiwen.library

import org.json.JSONArray
import org.json.JSONObject

/** Each instance operates on a single verified binding. Ordinary-record cursors remain in LibrarySyncCoordinator. */
internal class ExplorationSync(private val repo:LibraryRepository,private val send:(String,JSONObject)->JSONObject){
    private val pool=PhoneExploration(repo)
    private val binding=repo.registryItem()
    private val local=pool.local
    private var coverage:String?=null
    private fun request(action:String,args:JSONObject=obj()):JSONObject{
        args.put("libraryId",repo.libraryId).put("serverId",binding.serverId).put("epoch",binding.epoch).put("deviceId",repo.deviceId)
        coverage?.let { args.put("coverage",it) }
        return send(action,args)
    }
    fun connect():Boolean{
        val result=runCatching { request("explorationCapabilities") }.getOrElse {
            val unknown=it.message.orEmpty().contains(Regex("UNKNOWN_METHOD|VALIDATION_ERROR|UNSUPPORTED|INVALID_REQUEST"))
            pool.put("sync",(pool.get("sync","status",area=local)?:obj()).put("state",if(unknown)"upgrade_required" else "offline"),"status",area=local)
            return false
        }
        check(result.optString("capability")=="explorationSync.v1")
        pool.put("sync",obj("enabled" to result.optBoolean("steps")),"stepCapability",area=local)
        coverage=result.getString("coverage")
        pool.put("sync",(pool.get("sync","status",area=local)?:obj()).put("state","online").put("coverage",coverage),"status",area=local)
        return true
    }
    private fun recordProof(row:LibraryOutbox,action:String)=request(action,obj("channel" to "record","operationId" to row.operationId,"fingerprint" to row.fingerprint))
    fun recordTracked(row:LibraryOutbox)=pool.get("bodyOwner",row.recordId,area="exploration-body-owners")?.let {
        it.stringValue("version")==row.versionId || it.isNull("version") && row.action=="create"
    }==true
    /** An empty result permits one send. A non-null result is either a definitive receipt or a hold. */
    fun beforeRecord(row:LibraryOutbox):JSONObject?{
        val owner=pool.get("bodyOwner",row.recordId,area="exploration-body-owners")?:return null
        if(owner.optString("binding")!=pool.binding||coverage==null)return obj("status" to "unknown")
        val attempted=row.attempts>0||row.state=="unknown"
        if(attempted&&owner.stringValue("coverage")!=coverage)return obj("status" to "unknown")
        val p=runCatching {recordProof(row,if(attempted)"explorationProof" else "explorationReserve")}.getOrNull()?:return obj("status" to "unknown")
        if(p.optString("operationId")!=row.operationId||p.optString("fingerprint")!=row.fingerprint||p.optString("coverage")!=coverage)return obj("status" to "unknown")
        return when(p.getString("status")){
            "committed"->p.getJSONObject("receipt")
            "not_committed"->{pool.put("bodyOwner",owner.put("coverage",coverage),row.recordId,area="exploration-body-owners");null}
            else->obj("status" to "unknown")
        }
    }
    private fun applyEntity(area:String,event:JSONObject){
        val kind=event.getString("entity");val key=event.getJSONArray("key").toString()
        val value=event.optJSONObject("value")
        if(kind=="source_state" && value!=null){
            val id=value.getString("id");val old=pool.get(kind,id,area=local)
            if(old==null||old.optLong("revision")<=value.optLong("revision"))pool.put(kind,value,id,area=local)
        }
        if(value==null)pool.dao.dropExploration(area,kind,key) else pool.dao.putExploration(ExplorationObject(area,kind,key,value.toString()))
    }
    private fun project(){
        pool.dao.clearExplorationScope(pool.scope)
        for(r in pool.dao.explorationScope(pool.base))pool.dao.putExploration(r.copy(scope=pool.scope))
        for(r in pool.dao.explorationList(local,"source_state"))pool.dao.putExploration(r.copy(scope=pool.scope))
        for(intent in pool.rows("outbox",local).sortedBy { it.optLong("created") }){
            if(intent.optString("state") !in setOf("pending","sent"))continue
            val op=intent.getJSONObject("operation");val args=JSONObject(op.getJSONObject("args").toString())
            // Projections are disposable. Only the immutable outbox is ever uploaded.
            if(op.getString("method")=="shiwen_exploration_respond"){
                val q=runCatching {pool.detail(args.getString("questionId"))}.getOrNull()?:continue
                args.put("questionId",q.getString("questionId")).put("expectedRevision",q.getInt("revision"))
            }
            // A failed nested Room transaction poisons the outer snapshot transaction.
            // Roll back only this optimistic intent when its target has changed.
            val sql=repo.db.openHelper.writableDatabase
            sql.execSQL("SAVEPOINT exploration_overlay")
            try{pool.apply(op.getString("method"),args)}
            catch(e:Exception){sql.execSQL(";ROLLBACK TO exploration_overlay")}
            finally{sql.execSQL("RELEASE exploration_overlay")}
        }
    }
    private fun snapshot():Long{
        val start=request("explorationBegin");val id=start.getString("snapshotId");val high=start.getLong("highWatermark")
        val previous=pool.get("sync","cursor",area=local)?.getLong("cursor")
        check(previous==null || high>=previous){"EXPLORATION_STALE_SNAPSHOT"}
        val stage=pool.binding+"/staging";pool.dao.clearExplorationScope(stage)
        class ManifestHash {
            var count=0
            val digest=java.security.MessageDigest.getInstance("SHA-256").apply { update('['.code.toByte()) }
            fun add(bytes:ByteArray){if(count++>0)digest.update(','.code.toByte());digest.update(bytes)}
            fun verify(expected:JSONObject){
                digest.update(']'.code.toByte())
                check(count==expected.getInt("count") && digest.digest().joinToString(""){"%02x".format(it)}==expected.getString("digest")){"EXPLORATION_MANIFEST_MISMATCH"}
            }
        }
        val total=ManifestHash()
        val manifest=start.getJSONObject("entities")
        val entities=manifest.keys().asSequence().associateWith { ManifestHash() }
        var offset:Int?=0
        while(offset!=null){
            val page=request("explorationPage",obj("snapshotId" to id,"offset" to offset))
            check(page.getString("snapshotId")==id&&page.getLong("highWatermark")==high)
            repo.db.runInTransaction {
                for(item in page.getJSONArray("items").objects()){
                    val bytes=io.github.wyf929597870.shiwen.model.Canonical.encode(plainExploration(item)).toByteArray(Charsets.UTF_8)
                    total.add(bytes)
                    checkNotNull(entities[item.getString("entity")]){"EXPLORATION_MANIFEST_MISMATCH"}.add(bytes)
                    // Staging an unverified page must not advance the live invalidation facts.
                    val row=ExplorationObject(stage,item.getString("entity"),item.getJSONArray("key").toString(),item.getJSONObject("value").toString())
                    pool.dao.putExploration(row)
                }
            }
            offset=if(page.isNull("next"))null else page.getInt("next")
        }
        total.verify(start)
        for((entity,hash) in entities)hash.verify(manifest.getJSONObject(entity))
        repo.db.runInTransaction {
            pool.dao.clearExplorationScope(pool.base)
            for(r in pool.dao.explorationScope(stage))applyEntity(pool.base,obj("entity" to r.kind,"key" to JSONArray(r.key),"value" to JSONObject(r.data)))
            pool.dao.clearExplorationScope(stage);pool.put("sync",obj("cursor" to high),"cursor",area=local);project()
        }
        return high
    }
    private fun pull(force:Boolean=false){
        var cursor=pool.get("sync","cursor",area=local)?.getLong("cursor")
        if(cursor==null||force)cursor=snapshot()
        while(true){
            val from=checkNotNull(cursor)
            val page=try{request("explorationChanges",obj("cursor" to from))}catch(e:Exception){
                if(!e.message.orEmpty().contains("CURSOR_EXPIRED"))throw e
                cursor=snapshot();continue
            }
            val events=page.getJSONArray("events").objects()
            if(events.isNotEmpty()&&events.first().getLong("seq")!=from+1){cursor=snapshot();continue}
            val next=page.getLong("nextCursor")
            check(next==from+events.size && next<=page.getLong("highWatermark")){"EXPLORATION_CURSOR_MISMATCH"}
            check(events.isNotEmpty() || next==page.getLong("highWatermark")){"EXPLORATION_CURSOR_GAP"}
            repo.db.runInTransaction {
                events.forEachIndexed { i,event->check(event.getLong("seq")==from+i+1);applyEntity(pool.base,event) }
                pool.put("sync",obj("cursor" to next),"cursor",area=local);project()
            }
            cursor=next
            if(next>=page.getLong("highWatermark"))break
        }
        request("explorationAck",obj("cursor" to cursor))
    }
    private fun push(intent:JSONObject){
        val id=intent.getString("id");val state=intent.getString("state")
        if(state=="resolving"){resolve(intent);return}
        if(state=="conflict")return
        val operation=intent.getJSONObject("operation")
        val input=operation.getJSONObject("args")
        if(operation.getString("method")=="shiwen_exploration_step" && pool.get("sync","stepCapability",area=local)?.optBoolean("enabled")!=true)return
        if(state=="pending"){
            for (field in listOf("questionId", "targetQuestionId")) {
                val question = input.stringValue(field) ?: continue
                val parent = pool.get("questionOwner",question,area=local)?.stringValue("operation")
                if (parent != null && pool.get("outbox",parent,area=local) != null) return
                val mapped = pool.get("questionMapping",question,area=local)?.getString("id")
                if (mapped != null && !intent.optBoolean("reserved")) input.put(field,mapped)
            }
            val refs=input.optJSONArray("suggestions")?.objects().orEmpty().flatMap {item->
                item.getJSONArray("sources").objects().flatMap {s->listOfNotNull(s.stringValue("recordId"),s.stringValue("annotationId"))}
            }.distinct()
            if(refs.chunked(500).any {repo.dao.hasPendingSourceChanges(it)})return
        }
        val dep=intent.stringValue("dependency")
        if(state=="pending" && dep!=null && repo.dao.allOutbox().any { it.recordId==dep && (recordTracked(it) || it.action=="create") && it.state !in setOf("applied","confirmed","snapshot-covered") })return
        if (state == "pending" && !intent.optBoolean("reserved")) {
            // A lost reservation response can still bind these exact bytes on the server.
            intent.put("fingerprint",explorationHash(operation)).put("reserved",true)
            pool.put("outbox",intent,id,area=local)
        }
        val args=obj("operationId" to id,"channel" to "exploration","fingerprint" to intent.getString("fingerprint"))
        val attempted=state=="sent";if(attempted&&intent.stringValue("coverage")!=coverage)return
        val proof=request(if(attempted)"explorationProof" else "explorationReserve",args)
        if(proof.optString("fingerprint")!=intent.getString("fingerprint")||proof.optString("coverage")!=coverage||proof.optString("operationId")!=id)return
        val receipt=when(proof.optString("status")){
            "committed"->proof.getJSONObject("receipt")
            "not_committed"->{
                pool.put("outbox",intent.put("state","sent").put("coverage",coverage),id,area=local)
                request("explorationSubmit",args.put("operation",intent.getJSONObject("operation")))
            }
            else->return
        }
        repo.db.runInTransaction {
            if(receipt.optString("status")=="conflict")pool.put("outbox",intent.put("state","conflict").put("receipt",receipt),id,area=local)
            else if(receipt.optString("status") in setOf("applied","resolved")){
                for (mapping in receipt.arrayValue("questionMappings").objects()) {
                    val provisional = mapping.getString("provisional")
                    if (pool.get("questionOwner",provisional,area=local) != null)
                        pool.put("questionMapping",obj("id" to mapping.getString("question")),provisional,area=local)
                }
                pool.put("confirmed",receipt,id,area=local);pool.drop("outbox",id,area=local)
            }
        }
    }
    private fun resolve(intent:JSONObject){
        val id=intent.getString("id");val receipt=try{request("explorationResolve",intent.getJSONObject("resolution"))}catch(e:Exception){
            if(e.message.orEmpty().contains("RESOLUTION_STALE")){
                intent.remove("resolution")
                pool.put("outbox",intent.put("state","conflict"),id,area=local)
            }
            throw e
        }
        check(receipt.optString("status")=="resolved")
        repo.db.runInTransaction {pool.put("confirmed",receipt,id,area=local);pool.drop("outbox",id,area=local)}
    }
    fun sync(force:Boolean=false){
        if(coverage==null)return
        pull(force)
        val errors=mutableListOf<Exception>()
        for(intent in pool.rows("outbox",local).sortedBy { it.optLong("created") }){
            try{push(intent)}catch(e:Exception){errors.add(e)}
        }
        pull()
        pool.put("sync",obj("state" to if(errors.isEmpty())"online" else "pending","lastSync" to System.currentTimeMillis()),"status",area=local)
    }
}

internal fun plainExploration(value:Any?):Any?=when(value){
    null,JSONObject.NULL->null
    is JSONArray->(0 until value.length()).map { plainExploration(value.get(it)) }
    is JSONObject->value.keys().asSequence().associateWith { plainExploration(value.get(it)) }
    else->value
}
