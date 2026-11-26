package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.work.*
import io.github.wyf929597870.shiwen.agent.PhoneAgent
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Callable
import java.util.concurrent.TimeUnit

/** Durable per-library scans. A model never owns a Room transaction while it runs. */
class PhoneDiscoveryWorker(context:Context, params:WorkerParameters): Worker(context,params) {
    companion object {
        @JvmStatic fun schedule(context:Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("shiwen-discovery-daily",ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<PhoneDiscoveryWorker>(24,TimeUnit.HOURS).build())
        }
        fun enqueue(context:Context, libraryId:String) {
            WorkManager.getInstance(context).enqueueUniqueWork("shiwen-discovery-"+libraryId,ExistingWorkPolicy.APPEND_OR_REPLACE,
                OneTimeWorkRequestBuilder<PhoneDiscoveryWorker>().setInputData(workDataOf("library" to libraryId)).build())
        }
    }
    override fun doWork():Result {
        val manager=LibraryManager(applicationContext)
        var retry=false
        try{
            val requested=inputData.getString("library")
            for(row in manager.all().filter { it.role=="standalone" && (requested==null||it.libraryId==requested) }){
                val pool=PhoneExploration(manager.openLibrary(row.libraryId))
                while(!isStopped && migrateLegacy(pool)){}
                if(requested==null){
                    if(pool.config().optBoolean("discovery"))pool.repo.db.runInTransaction {pool.discover("incremental")}
                    if(pool.rows("jobs").any { it.optString("status")=="pending" })enqueue(applicationContext,row.libraryId)
                    continue
                }
                for(job in pool.rows("jobs").filter { it.has("mode") && it.optString("status") in setOf("pending","failed") }){
                    while(!isStopped){
                        when(step(pool,job.getString("jobId"))){
                            "done" -> break
                            "retry" -> {retry=true;break}
                        }
                    }
                }
            }
        } finally { manager.close() }
        return if(isStopped || retry)Result.retry() else Result.success()
    }

    private fun migrateLegacy(pool:PhoneExploration):Boolean=pool.repo.db.runInTransaction(Callable {
        val after=pool.get("legacy","cursor")?.optString("key").orEmpty()
        val page=pool.dao.legacyExplorationCards(after)
        for(entry in page){
            val card=JSONObject(entry.value)
            val sources=card.arrayValue("quotes").objects().filter {it.has("recordId") && it.optLong("sourceRevision")>0}.map {q->
                obj("recordId" to q.getString("recordId"),"revision" to q.getLong("sourceRevision")).apply {
                    q.stringValue("text")?.let {put("quote",it)}
                    for(key in listOf("field","start","end","excerptIndex"))if(!q.isNull(key))put(key,q.get(key))
                }
            }
            val id=card.getString("cardId")
            val result=if(card.optString("question").isNotBlank() && sources.isNotEmpty())pool.suggestion(
                obj("type" to "explore","text" to card.getString("question"),"externalItemId" to id,"sources" to JSONArray(sources)),"legacy-recommendation")
                else obj("status" to "no_source")
            pool.put("legacy",result,id)
            pool.put("legacy",obj("key" to entry.key),"cursor")
        }
        page.isNotEmpty()
    })

    private fun claim(pool:PhoneExploration,id:String,lease:String):JSONObject?=pool.repo.db.runInTransaction(Callable {
        val job=pool.get("jobs",id)?:return@Callable null
        if(job.optString("status")=="ready")return@Callable null
        if(job.optLong("expires")>System.currentTimeMillis())return@Callable obj("busy" to true)
        val history=job.getString("mode")=="history"
        val cursor=job.getLong("cursor")
        val change=if(history)pool.dao.previousDiscoveryChange(cursor) else pool.dao.nextDiscoveryChange(cursor,job.getLong("end"))
        val retry=if(change==null)pool.rows("retry-"+id).firstOrNull() else null
        if(change==null && retry==null){pool.put("jobs",job.put("status","ready"),id);return@Callable null}
        pool.put("jobs",job.put("status","pending").put("lease",lease).put("expires",System.currentTimeMillis()+180000),id)
        val item=retry?:obj("record" to change!!.record,"revision" to change.revision,"seq" to change.seq,"mode" to job.getString("mode"))
        item.put("retried",retry!=null)
    })

    private fun proposals(pool:PhoneExploration,r:LibraryRecord,parent:LibraryRecord,history:Boolean,model:Boolean):List<JSONObject>{
        val personal=JSONArray(parent.sourcesJson).objects().filter { it.optString("origin")=="personal" }.joinToString("\n") { it.optString("text") }
        if(personal.isBlank())return emptyList()
        val annotation=r.annotationOfJson!=null
        val explicit=extractExplorationList(if(annotation||history)r.markdown else personal,history && !annotation)
        if(explicit.isNotEmpty()||history||annotation||!model)return explicit.map { (type,text)->
            obj("type" to type,"text" to text).apply {
                Regex("[“「]([^”」]+)[”」]").findAll(text).map { it.groupValues[1] }.firstOrNull(personal::contains)?.let {put("quote",it)}
            }
        }
        val nearby=pool.rows("exploration_questions").takeLast(35).map { obj("id" to it.getString("id"),"text" to (it.stringValue("wording")?:it.getString("original"))) }
        val prompt="从本人的原文发现待探索或待跟进的问题，已有题仅作参考。返回 JSON 数组，每项含 type（explore 或 follow_up）、text、逐字 quote。无发现返回 []。"
        val raw=PhoneAgent.analyze(applicationContext,prompt,obj("personal" to personal.take(16000),"questions" to JSONArray(nearby)).toString(),2048)
        val items=JSONArray(raw.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim()).objects()
        require(items.size<=100 && items.all { it.getString("type") in setOf("explore","follow_up") &&
            it.getString("text").isNotBlank() && it.getString("text").length<=2000 &&
            it.getString("quote").isNotBlank() && personal.contains(it.getString("quote")) })
        return items
    }

    private fun step(pool:PhoneExploration,id:String):String {
        val lease=freshId()
        val task=claim(pool,id,lease)?:return "done"
        if(task.optBoolean("busy"))return "retry"
        val settings=pool.config()
        val record=pool.dao.record(task.getString("record"))
        val ann=record?.annotationOfJson?.let(::JSONObject)
        val parent=if(ann==null)record else pool.dao.record(ann.getString("recordId"))
        fun current()=record!=null && parent!=null && !record.deleted && !parent.deleted &&
            task.getLong("revision")==record.revision && (ann==null || ann.getString("versionId")==parent.versionId) &&
            pool.dao.record(record.id)?.let { !it.deleted && it.revision==record.revision }==true &&
            pool.dao.record(parent.id)?.let { !it.deleted && it.revision==parent.revision }==true
        val entries=runCatching {
            if(current())proposals(pool,checkNotNull(record),checkNotNull(parent),task.getString("mode")=="history",settings.optBoolean("model")) else emptyList()
        }
        return pool.repo.db.runInTransaction(Callable {
            val job=pool.get("jobs",id)?:return@Callable "done"
            if(isStopped || job.optString("lease")!=lease || job.optLong("expires")<=System.currentTimeMillis())return@Callable "retry"
            job.remove("lease");job.remove("expires")
            val progress=job.getJSONObject("progress")
            val seq=task.getLong("seq")
            if(!task.getBoolean("retried")){
                job.put("cursor",seq)
                if(task.getString("mode")=="incremental")pool.put("progress",obj("cursor" to seq),"cursor")
                progress.put("scanned",progress.getInt("scanned")+1)
            }
            if(current() && (entries.isFailure || pool.config().getInt("revision")!=settings.getInt("revision"))){
                pool.put("retry-"+id,task,seq.toString())
                progress.put("retry",pool.rows("retry-"+id).size)
                pool.put("jobs",job.put("status",if(task.getBoolean("retried"))"failed" else "pending"),id)
                return@Callable if(task.getBoolean("retried"))"retry" else "next"
            }
            if(current() && parent!=null && record!=null){
                val items=entries.getOrThrow()
                val keys=items.associateWith { explorationHash(JSONArray(listOf(record.id,it.getString("type"),it.getString("text")))) }
                val actor="library:"+record.id
                val prior=pool.rows("exploration_discoveries").filter { it.optString("actor")==actor }.map {it.getString("item")}
                val added=keys.values-prior.toSet()
                val removed=prior-keys.values.toSet()
                for(item in items){
                    val source=obj("recordId" to parent.id,"revision" to parent.revision)
                    if(ann!=null)source.put("annotationId",record.id).put("annotationRevision",record.revision).put("originalVersionId",parent.versionId)
                    item.stringValue("quote")?.let { source.put("quote",it) }
                    val key=keys.getValue(item)
                    val stable=if(ann!=null && added.singleOrNull()==key && removed.size==1)removed.single() else key
                    val outcome=pool.suggestion(item.put("externalItemId",stable).put("sources",JSONArray().put(source)),actor).getString("status")
                    progress.put(outcome,progress.optInt(outcome)+1)
                }
            }
            pool.drop("retry-"+id,seq.toString())
            progress.put("retry",pool.rows("retry-"+id).size).put("checked",progress.getInt("checked")+1)
            pool.put("jobs",job,id)
            "next"
        })
    }
}
