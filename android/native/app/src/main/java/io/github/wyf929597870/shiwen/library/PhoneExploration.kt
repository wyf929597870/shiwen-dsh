package io.github.wyf929597870.shiwen.library

import io.github.wyf929597870.shiwen.model.Canonical
import org.json.JSONArray
import org.json.JSONObject
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters
import java.util.UUID
import java.util.concurrent.Callable

internal fun obj(vararg pairs: Pair<String, Any?>) = JSONObject().apply { pairs.forEach { put(it.first,it.second ?: JSONObject.NULL) } }
internal fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
internal fun JSONArray.strings() = (0 until length()).map { getString(it) }
internal fun JSONObject.arrayValue(key: String): JSONArray = optJSONArray(key) ?: optString(key).takeIf { it.startsWith("[") }?.let(::JSONArray) ?: JSONArray()
internal fun JSONObject.stringValue(key: String): String? = if (isNull(key)) null else getString(key)
internal fun explorationHash(value: Any?): String {
    fun plain(v: Any?): Any? = when (v) {
        null, JSONObject.NULL -> null
        is JSONObject -> v.keys().asSequence().associateWith { plain(v.get(it)) }
        is JSONArray -> (0 until v.length()).map { plain(v.get(it)) }
        else -> v
    }
    return Canonical.hash(plain(value))
}
internal fun freshId(): String = UUID.randomUUID().toString()

internal class PhoneExploration(val repo: LibraryRepository) {
    val bound = repo.registryItem().role != "standalone"
    val binding = JSONArray(listOf(repo.libraryId,repo.registryItem().serverId,repo.registryItem().epoch,repo.deviceId)).toString()
    val scope = if (bound) "$binding/view" else "standalone"
    val local = "$binding/local"
    val base = "$binding/base"
    private val steps = ExplorationSteps(this)
    val dao = repo.dao
    fun rows(kind: String, area: String = scope) = dao.explorationList(area,kind).map { JSONObject(it.data) }
    fun get(kind: String, vararg key: String, area: String = scope): JSONObject? =
        dao.explorationObject(area,kind,JSONArray(key.toList()).toString())?.let { JSONObject(it.data) }
    fun put(kind: String, data: JSONObject, vararg key: String, area: String = scope) {
        dao.putExploration(ExplorationObject(area,kind,JSONArray(key.toList()).toString(),data.toString()))
    }
    fun drop(kind: String, vararg key: String, area: String = scope) = dao.dropExploration(area,kind,JSONArray(key.toList()).toString())
    fun config() = get("settings","settings") ?: obj("revision" to 1,"enabled" to false,"discovery" to true,"model" to false,
        "timezone" to ZoneId.systemDefault().id)
    private fun dates(): Map<String,String> {
        val today=LocalDate.now(ZoneId.of(config().optString("timezone",ZoneId.systemDefault().id)))
        return mapOf("day" to today.toString(),"week" to today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)).toString())
    }
    fun canonical(id: String): String {
        var q=id; val seen=mutableSetOf<String>()
        while(seen.add(q)) q=get("exploration_aliases",q)?.getString("parent")
            ?: get("questionMapping",q,area=local)?.getString("id") ?: return q
        error("EXPLORATION_ALIAS_CYCLE")
    }
    private fun question(id: String) = get("exploration_questions",id) ?: error("QUESTION_MISSING")
    private fun period(p: String,key: String) = get("exploration_periods",p,key) ?: obj("period" to p,"period_key" to key,
        "revision" to 0,"batch" to 0,"pins" to "[]","auto" to "[]")
    internal fun evidenceRevision(record:LibraryRecord):Long =
        if(bound && record.syncState=="synced")record.serverRevision?:record.revision else record.revision

    private fun evidenceRevision(record:ExplorationRecordState):Long =
        if(bound && record.syncState=="synced")record.serverRevision?:record.revision else record.revision

    // Evidence and response compound keys start with the quoted original question ID.
    internal fun entries(kind:String,id:String):List<JSONObject>{
        val family=listOf(id)+rows("exploration_aliases").map {it.getString("child")}.filter {canonical(it)==id}
        return family.flatMap { member->
            val prefix=JSONArray(listOf(member)).toString().dropLast(1)
            dao.explorationQuestionEntries(scope,kind,prefix+",",prefix+"-").map {JSONObject(it.data)}
        }
    }

    private fun live(s: JSONObject): Boolean {
        fun current(id: String,revision: Long): Boolean {
            val known=get("source_state",id)
            if(known!=null && (known.optInt("deleted")!=0 || known.getLong("revision")>revision)) return false
            val r=dao.explorationRecordState(id) ?: return false
            return !r.deleted && evidenceRevision(r)==revision && !(bound && r.syncState!="synced" && r.serverRevision==revision)
        }
        return current(s.getString("recordId"),s.getLong("revision")) &&
            (s.isNull("annotationId") || current(s.getString("annotationId"),s.getLong("annotationRevision")))
    }
    private fun evidenceKey(s:JSONObject,provenance:Boolean):String{
        val fields=mutableListOf("recordId","revision","scope","field","excerptIndex","start","end")
        if(provenance || s.optString("field")=="annotation")fields.addAll(listOf("annotationId","annotationRevision","originalVersionId"))
        return explorationHash(JSONArray(fields.map {s.opt(it)?:JSONObject.NULL}))
    }
    private fun sources(id:String,valid:Boolean=true):List<JSONObject>{
        val found=linkedMapOf<String,JSONObject>()
        for(row in entries("exploration_evidence",id)){
            val s=JSONObject(row.getString("source"))
            if(valid && !live(s))continue
            val key=evidenceKey(s,false)
            if(row.optInt("confirmed")==1)found[key]=s.put("personal",true).put("confirmed",true)
            else if(key !in found)found[key]=s
        }
        return found.values.toList()
    }
    private fun matches(id: String) = rows("exploration_pairs").filter { it.optString("state")=="pending" &&
        (it.optString("left_id")==id || it.optString("right_id")==id) }.mapNotNull { p ->
        val other=if(p.getString("left_id")==id)p.getString("right_id") else p.getString("left_id")
        if(canonical(other)!=other || other==id) null else question(other).let { q ->
            obj("questionId" to other,"text" to (q.stringValue("wording")?:q.getString("original")),"revision" to q.getInt("revision"),
                "recordIds" to p.arrayValue("records"),"evidenceFingerprint" to p.getString("basis"))
        }
    }
    private fun responsesFor(id:String):List<JSONObject> {
        return entries("exploration_responses",id).mapNotNull { e ->
            val record=dao.explorationRecordState(e.getString("record"))?:return@mapNotNull null
            val revision=evidenceRevision(record)
            if(record.deleted || !live(obj("recordId" to record.id,"revision" to revision)) && record.syncState=="synced")return@mapNotNull null
            val passage=e.stringValue("passage")?.let(::JSONObject)?.takeIf {it.getLong("revision")==revision}
            val preview=passage?.optString("quote") ?: dao.explorationResponseSpans(record.id)?.let {spans->
                JSONArray(spans).objects().firstOrNull {it.optString("origin")=="personal" && it.optString("text").isNotBlank()}?.getString("text")?.trim()
            }
            obj("recordId" to record.id,"revision" to revision,"kind" to record.kind,"title" to record.title,
                "created" to record.createdAt,"linkedAt" to e.optLong("linked_at"),"contentDay" to record.contentDay,"preview" to preview.orEmpty().take(180)).apply {
                if(passage!=null)put("passage",passage)
            }
        }.sortedWith(compareByDescending<JSONObject> {it.optLong("linkedAt")}.thenByDescending {it.stringValue("contentDay").orEmpty()}
            .thenByDescending {it.getString("created")}.thenBy {it.getString("recordId")}).distinctBy {it.getString("recordId")}
    }

    private fun pendingClues(id: String, wording: String): List<JSONObject> {
        val excluded=(entries("exploration_responses",id)+entries("exploration_evidence",id)).map {it.getString("record")}.toSet()
        return entries("exploration_clues",id).filter {it.optInt("dismissed")==0 && it.getString("wording")==wording && it.getString("record") !in excluded}
            .map {JSONObject(it.getString("passage"))}.filter(::live)
            .distinctBy {it.getString("recordId")}.sortedWith(compareByDescending<JSONObject> {it.optString("contentDay")}
                .thenByDescending {it.optString("created")}.thenBy {it.getString("recordId")}).take(3)
    }

    fun discoverFollowups(record: LibraryRecord) {
        val day=record.contentDay ?: return
        val passages=FollowupPassages.extract(record)
        if(passages.isEmpty())return
        data class Match(val score:Int,val id:String,val wording:String,val locator:JSONObject)
        val matches=rows("exploration_questions").filter {it.optString("status")=="accepted"}.mapNotNull {q->
            val id=q.getString("id")
            val wording=q.stringValue("wording")?:q.getString("original")
            val evidence=sources(id)
            if(evidence.any {it.getString("recordId")==record.id} ||
                evidence.none {val date=it.stringValue("contentDay");date!=null && (date<day || date==day && (dao.explorationRecordState(it.getString("recordId"))?.createdAt ?: record.createdAt)<record.createdAt)} ||
                entries("exploration_responses",id).any {it.getString("record")==record.id})return@mapNotNull null
            val context=evidence.filter {it.optBoolean("personal")}.joinToString(" ") {it.optString("quote")} + " " + responsesFor(id).firstOrNull()?.optString("preview").orEmpty()
            FollowupPassages.match(passages,wording,context)?.let {(score,locator)->Match(score,id,wording,locator)}
        }.sortedWith(compareByDescending<Match> {it.score}.thenBy {it.id}).take(3)
        for(m in matches){
            if(get("exploration_clues",m.id,record.id)?.optInt("dismissed")==1)continue
            val passage=source(record,m.locator).put("created",record.createdAt)
            if(passage.optString("scope")!="passage"||!passage.optBoolean("personal"))continue
            put("exploration_clues",obj("question" to m.id,"record" to record.id,"revision" to evidenceRevision(record),
                "wording" to m.wording,"dismissed" to 0,"passage" to passage.toString()),m.id,record.id)
        }
    }

    fun detail(raw: String): JSONObject {
        val id=canonical(raw);val q=question(id)
        val placements=JSONObject()
        for((p,k) in dates()) { val state=period(p,k);placements.put(p,obj("key" to k,"revision" to state.getInt("revision"),"pinned" to state.arrayValue("pins").strings().contains(id))) }
        val responses=responsesFor(id)
        val merged=rows("exploration_aliases").filter { it.getString("parent")==id }.map { a ->
            val child=question(a.getString("child"));obj("decisionId" to a.getString("decision"),"questionId" to child.getString("id"),
                "revision" to child.getInt("revision"),"text" to child.getString("original"))
        }
        val evidence=sources(id)
        val clues=if(q.getString("status")=="accepted" && evidence.isNotEmpty())pendingClues(id,q.stringValue("wording")?:q.getString("original")) else emptyList()
        return obj("questionId" to id,"libraryId" to repo.libraryId,"revision" to q.getInt("revision"),"type" to q.getString("type"),
            "originalText" to q.getString("original"),"text" to (q.stringValue("wording")?:q.getString("original")),"status" to q.getString("status"),
            "sources" to JSONArray(evidence),"clues" to JSONArray(clues),"responses" to JSONArray(responses),"placements" to placements,
            "possibleDuplicates" to JSONArray(matches(id)),"mergedQuestions" to JSONArray(merged)).apply {
            val progress=steps.project(id,responses)
            for(key in progress.keys())put(key,progress.get(key))
        }
    }
    private fun card(id: String): JSONObject = detail(id).apply {
        val src=getJSONArray("sources");put("cardId",id);put("cardRevision",getInt("revision"));put("question",getString("text"));put("scene",getString("type"))
        put("valid",src.length()>0 && getString("status")=="accepted");put("reason",src.optJSONObject(0)?.optString("title").orEmpty());put("quoteCount",src.length());put("todayUpdate",JSONObject.NULL)
        put("quotes",JSONArray(src.objects().map { JSONObject(it.toString()).put("text",it.optString("quote")).put("quoteId",explorationHash(it)) }))
    }
    private fun valid(id: String,manual: Boolean): Boolean = get("exploration_questions",id)?.optString("status")=="accepted" && sources(id).any { manual||it.optBoolean("personal") }
    private fun page(items: List<JSONObject>,cursor: Int) = obj("items" to JSONArray(items.drop(cursor).take(20)),"nextCursor" to (cursor+20).takeIf { it<items.size })
    private fun feed(a: JSONObject): JSONObject {
        val dates=dates()
        val (chosen,later)=steps.choices(dates.getValue("day"))
        val due=chosen.filter {valid(it,true)}
        fun visible(p: String): List<String> {
            val state=period(p,dates.getValue(p))
            return (state.arrayValue("pins").strings().filter { valid(it,true) } + due +
                state.arrayValue("auto").strings().filter { it !in later && valid(it,false) && config().optBoolean("enabled") }).distinct()
        }
        val day=visible("day").take(2)
        val history=if(config().optBoolean("enabled"))period("week",dates.getValue("week")).arrayValue("seen").strings().filter {it !in later && valid(it,false)} else emptyList()
        val week=(visible("week")+history).distinct()
        val items=when(a.optString("view","week")){"week"->week;"daily"->day;else->emptyList()}
        return page(items.map { card(it).put("alsoToday",it in day) },a.optInt("cursor"))
            .put("daily",JSONArray(day.map(::card))).put("week",dates["week"]).put("day",dates["day"]).put("todayCount",get("legacy_updates","today")?.takeIf {it.optString("day")==dates["day"]}?.optInt("count")?:0)
            .put("libraryId",repo.libraryId).put("cachedDay",dates["day"])
            .put("nextDayAt",LocalDate.parse(dates.getValue("day")).plusDays(1).atStartOfDay(ZoneId.of(config().getString("timezone"))).toInstant().toEpochMilli())
    }
    private fun checked(a: JSONObject): JSONObject {
        val id=a.getString("questionId");check(canonical(id)==id){"TARGET_CHANGED"}
        return question(id).also { check(it.getInt("revision")==a.getInt("expectedRevision")){"REVISION_CONFLICT"} }
    }
    private fun bump(q: JSONObject){q.put("revision",q.getInt("revision")+1);put("exploration_questions",q,q.getString("id"))}
    private fun review(a: JSONObject): JSONObject {
        val action=a.getString("action")
        if(action=="resolve_source")return resolveSource(a)
        if(action in setOf("merge","keep_separate","undo_merge"))return decide(a)
        val q=checked(a);val id=q.getString("id");val old=q.getString("status")
        val status=when(action){
            "accept","continue","rewrite"->"accepted";"observe"->"observing";"answered"->"answered";"skip"->"skipped"
            "restore"->{check(old=="skipped");q.optString("previous_status","pending")}
            "dismiss_clue"->{
                val record=a.getString("recordId")
                val revision=a.getLong("sourceRevision")
                check(pendingClues(id,q.stringValue("wording")?:q.getString("original")).any {it.getString("recordId")==record && it.getLong("revision")==revision}){"SOURCE_CHANGED"}
                for(clue in entries("exploration_clues",id).filter {it.getString("record")==record && it.getLong("revision")==revision}){
                    put("exploration_clues",clue.put("dismissed",1),clue.getString("question"),record)
                }
                old
            }
            "confirm_personal_context"->{
                val entry=dao.explorationList(scope,"exploration_evidence").firstOrNull {
                    val e=JSONObject(it.data);val s=JSONObject(e.getString("source"))
                    canonical(e.getString("question"))==id && s.optString("scope")=="record" && s.optBoolean("hasPersonal") && live(s) &&
                        s.getString("recordId")==a.getString("recordId") && s.getLong("revision")==a.getLong("sourceRevision")
                }?:error("SOURCE_CHANGED")
                dao.putExploration(entry.copy(data=JSONObject(entry.data).put("confirmed",1).toString()));old
            }
            else->error("INVALID_ACTION")
        }
        if(action=="rewrite"||action=="accept"&&a.has("text"))q.put("wording",a.getString("text").also { require(it.isNotBlank()) })
        if(old!="skipped")q.put("previous_status",old)
        q.put("status",status);bump(q)
        if(status!="accepted")for((p,k) in dates()) {
            val state=period(p,k);val pins=state.arrayValue("pins").strings();val auto=state.arrayValue("auto").strings()
            if(id in pins||id in auto)put("exploration_periods",state.put("pins",JSONArray(pins-id).toString()).put("auto",JSONArray(auto-id).toString())
                .put("revision",state.getInt("revision")+1).put("batch",state.getInt("batch")+1),p,k)
        }
        return detail(id)
    }
    private fun place(a: JSONObject): JSONObject {
        val q=checked(a);val id=q.getString("id");val p=a.getString("period");val k=dates().getValue(p);val s=period(p,k)
        check(k==a.getString("periodKey")&&s.getInt("revision")==a.getInt("expectedPlacementRevision")){"PLACEMENT_CHANGED"}
        val pins=s.arrayValue("pins").strings().filter { valid(it,true) }.toMutableList()
        if(a.getString("action")=="unpin"){
            pins.remove(id)
            for(key in listOf("seen","auto"))s.put(key,JSONArray(s.arrayValue(key).strings()-id).toString())
        } else {
            check(sources(id).isNotEmpty()){"SOURCE_CHANGED"}
            if(id !in pins) {
                if(pins.size>=(if(p=="day")2 else 10)){
                    val at=pins.indexOf(a.optString("replaceQuestionId"))
                    if(at<0)return obj("status" to "full","replaceable" to JSONArray(pins))
                    pins[at]=id
                }else pins.add(id)
            }
            if(q.getString("status")!="accepted"){check(q.getString("status")=="pending"&&a.optBoolean("accept"));review(JSONObject(a.toString()).put("action","accept"))}
        }
        put("exploration_periods",s.put("pins",JSONArray(pins).toString()).put("revision",s.getInt("revision")+1).put("batch",s.getInt("batch")+1),p,k)
        return detail(id)
    }
    private fun decide(a: JSONObject): JSONObject {
        val from=question(a.getString("questionId"));val to=question(a.getString("targetQuestionId"));val id=from.getString("id");val target=to.getString("id")
        check(id!=target&&canonical(target)==target&&from.getInt("revision")==a.getInt("expectedRevision")&&to.getInt("revision")==a.getInt("expectedTargetRevision")){"REVISION_CONFLICT"}
        val decision=if(bound)explorationHash(JSONArray(listOf("bound:"+binding,a.getString("requestId")))) else a.getString("requestId");val action=a.getString("action")
        if(action=="undo_merge"){
            val alias=get("exploration_aliases",id)?:error("MERGE_MISSING")
            check(alias.getString("parent")==target&&alias.getString("decision")==a.getString("decisionId"))
            val prior=get("exploration_decisions",alias.getString("decision"))?:error("MERGE_MISSING")
            val data=JSONObject(prior.getString("data"));from.put("status",data.getString("status"));drop("exploration_aliases",id)
            for(saved in data.arrayValue("periods").objects()){
                val p=saved.getString("period");val k=saved.getString("key");val state=period(p,k)
                if(state.getInt("revision")==saved.getInt("afterRevision")&&state.getInt("batch")==saved.getInt("afterBatch")){
                    state.put("pins",saved.getJSONArray("pins").toString()).put("auto",saved.getJSONArray("auto").toString())
                    put("exploration_periods",state.put("revision",state.getInt("revision")+1).put("batch",state.getInt("batch")+1),p,k)
                }
            }
        }else if(action=="merge"){
            check(canonical(id)==id)
            val periods=JSONArray()
            for((p,k) in dates()){
                val s=period(p,k);val pins=s.arrayValue("pins").strings();val auto=s.arrayValue("auto").strings()
                if(id !in pins && id !in auto)continue
                fun moved(ids:List<String>)=ids.mapNotNull { if(it!=id)it else target.takeIf { to.getString("status")=="accepted" } }.distinct()
                val v=s.getInt("revision")+1;val batch=s.getInt("batch")+1
                periods.put(obj("period" to p,"key" to k,"pins" to JSONArray(pins),"auto" to JSONArray(auto),"afterRevision" to v,"afterBatch" to batch))
                put("exploration_periods",s.put("revision",v).put("batch",batch).put("pins",JSONArray(moved(pins)).toString()).put("auto",JSONArray(moved(auto)-moved(pins).toSet()).toString()),p,k)
            }
            put("exploration_decisions",obj("id" to decision,"source" to id,"target" to target,"data" to obj("status" to from.getString("status"),"periods" to periods).toString()),decision)
            put("exploration_aliases",obj("child" to id,"parent" to target,"decision" to decision),id);from.put("status","merged")
        }else{
            val pair=listOf(id,target).sorted();val basis=a.getString("evidenceFingerprint")
            val existing=get("exploration_pairs",pair[0],pair[1],basis)?:error("EVIDENCE_CHANGED")
            put("exploration_pairs",existing.put("state","separate"),pair[0],pair[1],basis)
        }
        bump(from);bump(to);return detail(if(action=="merge")target else id).put("decisionId",decision)
    }
    private fun resolveSource(a: JSONObject): JSONObject {
        val id=a.getString("reviewItemId");val r=get("exploration_reviews",id)?:error("REVIEW_MISSING")
        check(r.optInt("revision")==a.getInt("expectedReviewRevision")&&r.isNull("resolution"))
        val payload=JSONObject(r.getString("payload"));val mappings=a.getJSONArray("mappings").objects().associateBy { it.getString("externalSourceId") }
        payload.put("sources",JSONArray(payload.getJSONArray("sources").objects().map { if(it.has("externalSourceId"))mappings.getValue(it.getString("externalSourceId")) else it }))
        val result=suggestion(payload,r.getString("actor"));if(result.optString("status")!="source_changed")put("exploration_reviews",r.put("resolution",result.toString()).put("revision",r.getInt("revision")+1),id)
        return result
    }
    private fun source(r: LibraryRecord,input: JSONObject): JSONObject {
        val spans=JSONArray(r.sourcesJson).objects()
        val personal=spans.any { it.optString("origin")=="personal"&&it.optString("text").isNotBlank() }
        val reading=r.kind=="reading_note"
        val base=obj("recordId" to r.id,"revision" to evidenceRevision(r),"scope" to "record","title" to r.title,"kind" to r.kind,
            "contentDay" to r.contentDay,"hasPersonal" to personal,"personal" to (!reading&&personal&&spans.all { it.optString("origin")=="personal"||it.optString("text").isBlank() }),
            "label" to if(reading)"来自这篇笔记" else "来自这篇记录")
        for(k in listOf("annotationId","annotationRevision","originalVersionId"))if(input.has(k))base.put(k,input.get(k))
        val quote=input.stringValue("quote")?:return base
        require(quote.isNotEmpty())
        val matches=mutableListOf<JSONObject>()
        fun locate(text:String,field:String,origin:String,offset:Int,index:Int?=null){
            if(input.has("field")&&input.optString("field")!=field||input.has("excerptIndex")&&index!=input.optInt("excerptIndex"))return
            var at=text.indexOf(quote)
            while(at>=0 && matches.size<2){
                val start=offset+at
                if(!input.has("start")||input.optInt("start")==start&&input.optInt("end")==start+quote.length){
                    val s=JSONObject(base.toString()).put("field",field).put("scope","passage").put("origin",origin).put("personal",origin=="personal")
                        .put("label",if(field=="excerpt")"书中原文" else if(origin=="personal")"我的原句" else if(origin=="ai")"AI 原话" else "来源原文")
                        .put("quote",quote).put("start",start).put("end",start+quote.length)
                    if(index!=null)s.put("excerptIndex",index)
                    matches.add(s)
                }
                at=text.indexOf(quote,at+1)
            }
        }
        var offset=0
        for(span in spans){val text=span.optString("text");locate(text,if(reading)"reflection" else if(r.kind=="ai_annotation")"annotation" else "body",span.optString("origin"),offset);offset+=text.length}
        if(reading)r.annotation?.let { runCatching {JSONObject(it)}.getOrNull()?.optJSONArray("excerpts")?.objects()?.forEachIndexed { i,e->locate(e.optString("text"),"excerpt","external",0,i) } }
        return matches.singleOrNull()?:base.put("personal",false)
    }
    internal fun suggestion(item: JSONObject, actor: String): JSONObject {
        val external=item.getString("externalItemId");val text=item.getString("text").trim();val type=item.getString("type")
        require(text.isNotEmpty()&&text.length<=2000&&type in setOf("follow_up","explore"))
        val refs=item.getJSONArray("sources").objects();require(refs.isNotEmpty())
        if(refs.any {it.isNull("recordId")}){
            val rid=explorationHash(JSONArray(listOf(actor,external)))
            val old=get("exploration_reviews",rid)
            val revision=(old?.optInt("revision")?:0)+1
            if(old?.optString("payload")!=item.toString())put("exploration_reviews",obj("id" to rid,"actor" to actor,"item" to external,"payload" to item.toString(),
                "reason" to "source_unmapped","revision" to revision,"candidates" to "[]"),rid)
            else if(!old.isNull("resolution"))return JSONObject(old.getString("resolution")).put("status","existing")
            return obj("externalItemId" to external,"status" to "needs_review","reviewItemId" to rid,"reason" to "source_unmapped")
        }
        val changed=mutableSetOf<String>();val located=mutableListOf<JSONObject>()
        for(ref in refs){
            val rid=ref.getString("recordId");val rec=dao.record(rid)
            if(rec==null||rec.deleted||evidenceRevision(rec)!=ref.getLong("revision")){changed.add(rid);continue}
            if(ref.has("annotationId")){
                val ann=dao.record(ref.getString("annotationId"))
                if(ann==null||ann.deleted||evidenceRevision(ann)!=ref.getLong("annotationRevision")||ann.annotationOfJson?.let(::JSONObject)?.let { it.optString("versionId")==ref.getString("originalVersionId") && it.optString("recordId")==rid }!=true || rec.versionId!=ref.getString("originalVersionId")){
                    changed.add(ref.getString("annotationId"));continue
                }
            }
            val annotation=if(ref.optString("field")=="annotation"&&ref.has("annotationId"))dao.record(ref.getString("annotationId")) else null
            val locatedSource=source(annotation?:rec,ref)
            located.add(locatedSource.put("recordId",rid).put("revision",evidenceRevision(rec)))
        }
        fun outcome(status:String)=obj("externalItemId" to external,"status" to status)
        if(changed.isNotEmpty())return outcome("source_changed").put("recordIds",JSONArray(changed.toList()))
        val prior=rows("exploration_discoveries").firstOrNull { it.optString("actor")==actor&&it.optString("item")==external }
        val normal=text.replace(Regex("\\s+")," ");val ids=located.map { it.getString("recordId") }.toSet()
        val related=rows("exploration_questions").filter { q->q.getString("type")==type&&q.getString("status")!="merged"&&sources(q.getString("id"),false).any { it.getString("recordId") in ids } }
        val exact=related.filter { q->
            val old=sources(q.getString("id"),false)
            val compatible=located.all { s->s.optString("scope")=="record"||old.none { it.getString("recordId")==s.getString("recordId")&&it.getString("scope")=="passage" }||
                old.any { it.getString("recordId")==s.getString("recordId")&&it.optString("quote")==s.optString("quote")&&it.optString("field")==s.optString("field")&&it.optInt("start")==s.optInt("start") } }
            q.getString("normalized")==normal && compatible && (old.map { it.getString("recordId") }.toSet()==ids ||
                located.any { s->s.getString("scope")=="passage"&&old.any { explorationHash(it)==explorationHash(s) } })
        }
        val target=prior?.getString("question")?:exact.singleOrNull()?.getString("id")
        if(prior!=null&&question(prior.getString("question")).getString("normalized")!=normal){
            val rid=explorationHash(JSONArray(listOf(actor,external)))
            put("exploration_reviews",obj("id" to rid,"actor" to actor,"item" to external,"reason" to "revised_discovery","payload" to item.toString(),"revision" to 1,"candidates" to JSONArray(listOf(target)).toString()),rid)
            return outcome("needs_review").put("reviewItemId",rid).put("reason","revised_discovery")
        }
        val id=target?:if(bound && actor.startsWith("bound:"))explorationHash(JSONArray(listOf("phone-question",actor,external))) else freshId()
        if(target==null)put("exploration_questions",obj("id" to id,"type" to type,"original" to text,"normalized" to normal,"status" to "pending","revision" to 1),id)
        if(prior==null){val d=freshId();put("exploration_discoveries",obj("id" to d,"actor" to actor,"item" to external,"question" to id,"sources" to JSONArray(located).toString()),d)}
        var added=false
        for(s in located){
            val anchor=evidenceKey(s,true)
            if(get("exploration_evidence",id,anchor)==null){put("exploration_evidence",obj("question" to id,"record" to s.getString("recordId"),"revision" to s.getLong("revision"),"anchor" to anchor,"source" to s.toString(),"confirmed" to 0),id,anchor);added=true}
        }
        if(added&&target!=null)bump(question(target))
        if(target==null)for(q in related){
            fun grams(s:String)=s.lowercase().replace(Regex("[\\p{P}\\s]"),"").windowed(2).toSet()
            val x=grams(normal);val y=grams(q.getString("normalized"));val shared=x.intersect(y).size
            if(Regex("[0-9.]+").findAll(normal).map {it.value}.toList()!=Regex("[0-9.]+").findAll(q.getString("normalized")).map {it.value}.toList())continue
            if(normal!=q.getString("normalized")&&(shared<2||2.0*shared/(x.size+y.size)<0.36))continue
            val pair=listOf(id,q.getString("id")).sorted()
            val records=sources(q.getString("id"),false).map { it.getString("recordId") }.filter { it in ids }.distinct().sorted()
            val basis=explorationHash(JSONArray(listOf(pair[0],pair[1],question(pair[0]).getString("normalized"),question(pair[1]).getString("normalized"),JSONArray(records))))
            if(get("exploration_pairs",pair[0],pair[1],basis)==null)put("exploration_pairs",obj("left_id" to pair[0],"right_id" to pair[1],"basis" to basis,"records" to JSONArray(records).toString(),"state" to "pending"),pair[0],pair[1],basis)
        }
        val possible=matches(canonical(id))
        return outcome(if(possible.isNotEmpty())"needs_review" else if(target==null)"created" else "existing").put("sources",JSONArray(located)).put("questionId",canonical(id))
            .apply { if(possible.isNotEmpty()){put("reason","possible_duplicate");put("matches",JSONArray(possible))} }
    }
    private fun arrange():Int {
        if(bound || !config().optBoolean("enabled"))return 0
        var changed=0
        val candidates=rows("exploration_questions").sortedByDescending {it.optString("type")=="follow_up"}.map { it.getString("id") }.filter { valid(it,false) }
        val withClues=candidates.filter {id->val q=question(id);pendingClues(id,q.stringValue("wording")?:q.getString("original")).isNotEmpty()}.toSet()
        val periods=dates()
        val weekly=period("week",periods.getValue("week"))
        val filling=(weekly.arrayValue("pins").strings().filter {valid(it,true)}+weekly.arrayValue("auto").strings().filter {valid(it,false)}).distinct().size<7
        for(p in listOf("week","day")){
            val k=periods.getValue(p)
            val state=period(p,k)
            val pins=state.arrayValue("pins").strings().filter { valid(it,true) }
            val prior=state.arrayValue("auto").strings()
            val capacity=(if(p=="day")2 else 10)-pins.size
            val keep=prior.filter { it !in pins&&valid(it,false) }.take(capacity).toMutableList()
            val seen=state.arrayValue("seen").strings()
            val extra=(candidates-pins.toSet()-keep.toSet()).sortedWith(compareByDescending<String> {it in withClues}.thenBy {seen.indexOf(it)})
            val limit=if(filling && p=="week")minOf(capacity,7-pins.size) else capacity
            if(!filling && keep.size>=limit && keep.isNotEmpty() && extra.isNotEmpty())keep.removeAt(0)
            val added=extra.take(minOf(if(filling)limit else 1,maxOf(0,limit-keep.size)))
            keep.addAll(added)
            if(keep!=prior){
                changed+=added.size
                put("exploration_periods",state.put("auto",JSONArray(keep).toString()).put("seen",JSONArray(seen-added.toSet()+added).toString())
                    .put("batch",state.getInt("batch")+1),p,k)
            }
        }
        return changed
    }
    fun discover(mode:String): JSONObject {
        check(!bound && mode in setOf("history","incremental"))
        val running=rows("jobs").firstOrNull { it.optString("mode")==mode && it.optString("status") in setOf("pending","failed") }
        if(running!=null){
            put("jobs",running.put("status","pending"),running.getString("jobId"))
            return obj("jobId" to running.getString("jobId"))
        }
        val jobId="explore-"+freshId()
        val cursor=if(mode=="incremental")get("progress","cursor") else null
        val end=dao.discoveryCut()
        val job=obj("jobId" to jobId,"mode" to mode,"status" to "pending","cursor" to (if(mode=="history")end+1 else cursor?.optLong("cursor")?:0),"end" to end,
            "progress" to obj("scanned" to 0,"checked" to 0,"created" to 0,"existing" to 0,"needs_review" to 0,"retry" to 0))
        put("jobs",job,jobId)
        return obj("jobId" to jobId)
    }
    fun execute(method:String,a:JSONObject): JSONObject = repo.db.runInTransaction(Callable {
        if(a.has("expectedLibraryId"))check(a.getString("expectedLibraryId")==repo.libraryId){"STALE_CONTEXT"}
        val id=a.stringValue("requestId")
        val fp=explorationHash(obj("method" to method,"args" to a))
        if(id!=null)get("receipts",id,area=local)?.let {check(it.getString("fingerprint")==fp){"REQUEST_REUSED"};return@Callable it.getJSONObject("result")}
        val originalText=a.stringValue("questionId")?.let { runCatching {detail(it).getString("text")}.getOrNull() }
        val result=apply(method,a)
        if(id!=null){
            put("receipts",obj("fingerprint" to fp,"result" to result),id,area=local)
            if(bound&&method in setOf("shiwen_exploration_step","shiwen_exploration_suggest","shiwen_exploration_review","shiwen_exploration_place","shiwen_exploration_respond")&&result.optString("status")!="full"){
                val args=JSONObject(a.toString()).put("expectedLibraryId",repo.libraryId);val dependency=if(method=="shiwen_exploration_respond")args.getString("responseRecordId") else null
                if(args.has("body")){args.remove("body");args.put("sourceRevision",repo.read(checkNotNull(dependency)).revision)}
                if(method=="shiwen_exploration_suggest"){
                    for(item in result.getJSONArray("items").objects()){
                        val q=item.stringValue("questionId")?:continue
                        if(get("questionOwner",q,area=local)==null && get("exploration_questions",q,area=base)==null)
                            put("questionOwner",obj("operation" to id),q,area=local)
                    }
                }
                val operation=obj("method" to method,"args" to args)
                put("outbox",obj("id" to id,"operation" to operation,"fingerprint" to explorationHash(operation),"state" to "pending","dependency" to dependency,
                    "created" to System.currentTimeMillis(),"originalText" to originalText),id,area=local)
            }
        }
        result
    })
    fun apply(method:String,a:JSONObject): JSONObject {
        val c=config()
        return when(method){
            "explorationSyncStatus"->obj("role" to repo.registryItem().role,
                "recordChanges" to dao.discoveryCut(),"explorationCursor" to get("sync","cursor",area=local)?.optLong("cursor"),"status" to get("sync","status",area=local),"items" to JSONArray(rows("outbox",local).map { intent->
                val receipt=intent.optJSONObject("receipt")
                if(receipt!=null && intent.optString("state")=="conflict"){
                    val q=receipt.stringValue("target")?.let { runCatching {detail(it)}.getOrNull() }
                    if(q!=null)receipt.put("targetRevision",q.getInt("revision")).put("targetText",q.getString("text"))
                }
                intent
            }))
            "explorationConflictResolve"->{
                val id=a.getString("operationId");val intent=get("outbox",id,area=local)?:error("CONFLICT_MISSING")
                val receipt=intent.getJSONObject("receipt");check(receipt.getString("conflictId")==a.getString("conflictId"))
                val args=obj("operationId" to id,"fingerprint" to intent.getString("fingerprint"),"conflictId" to receipt.getString("conflictId"),"choice" to a.getString("choice"))
                if(a.getString("choice")=="replace"){
                    val chosen=a.stringValue("questionId")?:receipt.getString("target")
                    check(receipt.optString("code")=="question_missing" || chosen==receipt.getString("target"))
                    val target=detail(chosen);check(a.getLong("expectedTargetRevision")==target.getLong("revision"))
                    val old=intent.getJSONObject("operation");val next=JSONObject(old.getJSONObject("args").toString());val newId=freshId()
                    next.put("requestId",newId).put("expectedRevision",target.getLong("revision")).put("questionId",target.getString("questionId"))
                    if(old.getString("method")=="shiwen_exploration_place"){
                        val period=target.getJSONObject("placements").getJSONObject(next.getString("period"))
                        check(period.getString("key")==next.getString("periodKey"))
                        next.put("expectedPlacementRevision",period.getInt("revision"))
                    }
                    val op=obj("method" to old.getString("method"),"args" to next)
                    args.put("replacement",obj("operationId" to newId,"operation" to op,"fingerprint" to explorationHash(op)))
                }
                put("outbox",intent.put("resolution",args).put("state","resolving"),id,area=local);obj("status" to "pending")
            }
            "themeContext"->obj("libraryId" to repo.libraryId)
            "explorationRecordSearch"->{val rs=repo.list(a.optString("query"),null,false,20,a.optInt("offset"))
                obj("items" to JSONArray(rs.map { obj("id" to it.id,"revision" to evidenceRevision(it),"origin" to it.origin,"day" to it.contentDay,"title" to it.title,"excerpt" to it.markdown.take(250)) }),
                    "nextOffset" to (a.optInt("offset")+20).takeIf { rs.size==20 })}
            "shiwen_exploration_read"->if(a.has("reviewItemId"))reviewDetail(get("exploration_reviews",a.getString("reviewItemId"))?:error("REVIEW_MISSING")) else detail(a.getString("questionId"))
            "shiwen_exploration_list"->{
                val view=a.optString("view","raw")
                if(view=="reviews")page(rows("exploration_reviews").filter { it.isNull("resolution")&&(!a.has("reason")||a.getString("reason")==it.getString("reason")) }.map(::reviewDetail),a.optInt("cursor"))
                else page(rows("exploration_questions").asReversed().filter { q-> val s=q.getString("status");s!="merged"&&when(view){"raw"->s=="pending";"accepted"->s in setOf("accepted","answered","observing");"skipped"->s=="skipped";else->true} &&
                    (!a.has("type")||q.getString("type")==a.getString("type"))&&(!a.has("recordId")||sources(q.getString("id"),false).any { it.getString("recordId")==a.getString("recordId") }) }.map { detail(it.getString("id")) },a.optInt("cursor"))
            }
            "shiwen_exploration_suggest"->obj("requestId" to a.getString("requestId"),"items" to JSONArray(a.getJSONArray("suggestions").objects().map { suggestion(it,if(bound)"bound:"+binding else "phone:"+repo.deviceId) }))
            "shiwen_exploration_step"->{
                val q=checked(a);steps.change(q,a)
                if(q.getString("status")=="pending")q.put("status","accepted").put("previous_status","pending")
                bump(q);detail(q.getString("id"))
            }
            "shiwen_exploration_review"->review(a)
            "shiwen_exploration_place"->place(a)
            "shiwen_exploration_respond"->{
                val q=checked(a);val response=a.getString("responseRecordId")
                if(a.has("body")){
                    check(dao.record(response)==null)
                    repo.create(a.getString("requestId"),obj("id" to response,"kind" to "freewrite","origin" to "personal","markdown" to a.getString("body"),"contentDay" to dates().getValue("day"),"dateBasis" to "用户在手机记录"),0)
                    if(bound)put("bodyOwner",obj("binding" to binding,"recordId" to response,"version" to repo.read(response).versionId),response,area="exploration-body-owners")
                }else{
                    val r=repo.read(response);check(!r.deleted&&r.origin=="personal"&&evidenceRevision(r)==a.getLong("sourceRevision")){"SOURCE_CHANGED"}
                }
                val passage=a.optJSONObject("passage")?.let {ref->
                    val r=repo.read(response)
                    check(!a.has("body") && ref.getString("recordId")==response && ref.getLong("revision")==evidenceRevision(r)){"SOURCE_CHANGED"}
                    source(r,ref).also {check(it.getString("scope")=="passage" && it.getBoolean("personal")){"SOURCE_CHANGED"}}
                }
                val id=q.getString("id")
                if(rows("exploration_responses").none {it.getString("record")==response&&canonical(it.getString("question"))==id}){
                    put("exploration_responses",obj("question" to id,"record" to response,"linked_at" to System.currentTimeMillis(),"passage" to passage?.toString()),id,response);bump(q)
                }
                detail(id)
            }
            "shiwen_exploration_import"->discover(a.getString("mode"))
            "shiwen_exploration_settings"->{
                if(a.has("requestId")){
                    check(!bound&&c.getInt("revision")==a.getInt("expectedRevision"));if(a.has("enabled"))c.put("discovery",a.getBoolean("enabled"))
                    if(a.has("model"))c.put("model",a.getBoolean("model"));put("settings",c.put("revision",c.getInt("revision")+1),"settings")
                }
                obj("revision" to c.getInt("revision"),"enabled" to c.optBoolean("discovery"),"model" to c.optBoolean("model"),
                    "jobId" to rows("jobs").lastOrNull { it.has("mode") }?.optString("jobId"))
            }
            "shiwen_recommendation_settings"->{
                if(a.has("enabled")){check(!bound&&a.getInt("revision")==c.getInt("revision"));put("settings",c.put("enabled",a.getBoolean("enabled")).put("revision",c.getInt("revision")+1),"settings")}
                JSONObject(c.toString()).put("poolBased",true).put("libraryId",repo.libraryId).put("week",dates()["week"])
            }
            "shiwen_recommendation_refresh"->{val changed=arrange();val job="arrange-"+a.getString("requestId");put("jobs",obj("status" to "ready","result" to obj("changed" to changed)),job);obj("jobId" to job)}
            "shiwen_assist_result"->get("jobs",a.getString("jobId"))?:error("JOB_MISSING")
            "shiwen_recommendation_list"->feed(a)
            "shiwen_recommendation_read"->card(a.getString("cardId"))
            "shiwen_recommendation_feedback_list"->page(emptyList(),0)
            else->error("UNKNOWN_EXPLORATION_METHOD")
        }
    }
    private fun reviewDetail(r:JSONObject)=obj("reviewItemId" to r.getString("id"),"revision" to r.getInt("revision"),"reason" to r.getString("reason"),
        "discovery" to JSONObject(r.getString("payload")),"candidates" to r.arrayValue("candidates"))
}

internal fun extractExplorationList(markdown:String,legacy:Boolean=false):List<Pair<String,String>> {
    val out=mutableListOf<Pair<String,String>>();var section:String?=null;var level=0;var fence="";var current="";var aiLevel=0
    fun flush(){val s=section;if(s!=null&&current.trim().length in 1..2000)out.add(s to current.trim());current=""}
    for(line in markdown.lines()){
        val trimmed=line.trimStart()
        val marker=Regex("^(`{3,}|~{3,})").find(trimmed)?.value
        if(marker!=null){if(fence.isEmpty())fence=marker else if(marker[0]==fence[0]&&marker.length>=fence.length)fence="";continue}
        if(fence.isNotEmpty()||trimmed.startsWith(">"))continue
        val h=Regex("^ {0,3}(#{1,6})\\s+(.+?)\\s*#*\\s*$").matchEntire(line)
        if(h!=null){
            flush();val name=h.groupValues[2];val n=h.groupValues[1].length
            if(legacy){
                if(n<=aiLevel)aiLevel=0
                if(Regex("^(AI|人工智能)\\s*(批注|点评|分析)$",RegexOption.IGNORE_CASE).matches(name))aiLevel=n
                if(aiLevel==0 || n<=aiLevel){section=null;continue}
            }
            if(name in setOf("待探索","待跟进")||n<=level){section=when(name){"待探索"->"explore";"待跟进"->"follow_up";else->null};level=n}
            continue
        }
        if(section==null)continue
        val li=Regex("^ {0,3}(?:[-*+]|[0-9]+[.)])\\s+(.+)$").matchEntire(line)
        if(li!=null){flush();current=li.groupValues[1]}else if(current.isNotEmpty()&&line.startsWith(" "))current+="\n"+trimmed else if(trimmed.isNotBlank())flush()
    }
    flush();return out
}
