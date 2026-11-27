package io.github.wyf929597870.shiwen.library

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

internal class ExplorationSteps(private val pool: PhoneExploration) {
    private val entity = "exploration_steps"
    val supported get() = !pool.bound || pool.get("sync","stepCapability",area=pool.local)?.optBoolean("enabled")==true
    private fun data(row:JSONObject)=JSONObject(row.getString("data"))
    private val selectionOrder=compareByDescending<JSONObject> {it.getLong("selected")}.thenBy {it.getString("id")}

    fun project(id:String,responses:List<JSONObject>):JSONObject {
        val byRecord=responses.associateBy {it.getString("recordId")}
        val steps=pool.entries(entity,id).map {row->
            data(row).apply {
                val response=stringValue("responseId")
                if(response!=null && byRecord[response]?.getLong("revision")!=optLong("responseRevision"))remove("quote")
                for(key in listOf("id","created","selected"))put(key,row.get(key))
            }
        }.sortedWith(compareBy<JSONObject> {it.getLong("created")}.thenBy {it.getString("id")})
        return obj("steps" to JSONArray(steps),"stepsSupported" to supported,
            "nextStep" to steps.filter {it.optLong("selected")>0}.minWithOrNull(selectionOrder))
    }

    fun choices(day:String):Pair<List<String>,Set<String>> {
        val selected=pool.rows(entity).filter {it.optLong("selected")>0}.sortedWith(selectionOrder)
            .distinctBy {pool.canonical(it.getString("question"))}
        val (later,due)=selected.partition {(data(it).stringValue("reviewDay")?:"")>day}
        return due.map {pool.canonical(it.getString("question"))} to later.map {pool.canonical(it.getString("question"))}.toSet()
    }

    fun change(q:JSONObject,a:JSONObject) {
        check(supported){"请先连接支持探索下一步的电脑"}
        check(q.getString("status")=="accepted" || q.getString("status")=="pending" && a.getString("action")=="add" && a.optBoolean("accept")){"请先收下或继续探索这个问题"}
        val id=q.getString("id")
        val rows=pool.entries(entity,id)
        val stepId=a.getString("stepId")
        require(stepId.length in 1..128)
        fun completed(step:String)=rows.any {val d=data(it);d.optString("kind")=="result" && d.optString("parentId")==step}
        fun clear(){
            for(row in rows.filter {it.optLong("selected")>0})pool.put(entity,row.put("selected",0),row.getString("question"),row.getString("id"))
        }
        val now=System.currentTimeMillis()
        when(a.getString("action")){
            "pause","select"->{
                val target=rows.singleOrNull {it.getString("id")==stepId}?:error("TARGET_CHANGED")
                val pause=a.getString("action")=="pause"
                check(if(pause)target.optLong("selected")>0 else !completed(stepId)){"TARGET_CHANGED"}
                clear()
                if(!pause)pool.put(entity,target.put("selected",now),target.getString("question"),stepId)
            }
            "add"->{
                check(pool.rows(entity).none {it.getString("id")==stepId}){"REVISION_CONFLICT"}
                val kind=a.getString("kind")
                require(kind in setOf("ask","judgment","trial","result"))
                val payload=obj("kind" to kind,"text" to a.getString("text").trim().also {require(it.length in 1..10000)})
                val parent=a.stringValue("parentId")?.let {key->rows.singleOrNull {it.getString("id")==key}?:error("TARGET_CHANGED")}
                require(parent==null || !a.has("responseId"))
                if(kind=="result")check(parent!=null && data(parent).getString("kind")=="trial" && !completed(parent.getString("id"))){"TARGET_CHANGED"}
                var owner=parent?.getString("question")?:id
                parent?.let {payload.put("parentId",it.getString("id"))}
                a.stringValue("responseId")?.let {recordId->
                    val link=pool.entries("exploration_responses",id).filter {it.getString("record")==recordId}.minByOrNull {it.getString("question")}?:error("SOURCE_CHANGED")
                    val record=pool.dao.record(recordId)?:error("SOURCE_CHANGED")
                    val rev=a.getLong("responseRevision")
                    check(!record.deleted && pool.evidenceRevision(record)==rev){"SOURCE_CHANGED"}
                    a.stringValue("quote")?.let {quote->
                        require(quote.length in 1..16000)
                        check(JSONArray(record.sourcesJson).objects().any {it.optString("origin")=="personal" && it.getString("text").contains(quote)}){"SOURCE_CHANGED"}
                        payload.put("quote",quote)
                    }
                    owner=link.getString("question")
                    payload.put("responseId",recordId).put("responseRevision",rev)
                }
                for(key in listOf("observation","takeaway"))a.stringValue(key)?.let {raw->
                    require(kind==(if(key=="observation") "trial" else "result"))
                    payload.put(key,raw.trim().also {require(it.length in 1..2000)})
                }
                a.stringValue("reviewDay")?.let {require(kind=="trial" && LocalDate.parse(it).toString()==it);payload.put("reviewDay",it)}
                clear()
                pool.put(entity,obj("id" to stepId,"question" to owner,"data" to payload.toString(),"created" to now,"selected" to now),owner,stepId)
            }
            else->error("INVALID_ACTION")
        }
    }
}
