package io.github.wyf929597870.shiwen.library

import io.github.wyf929597870.shiwen.model.Canonical
import org.json.JSONArray
import org.json.JSONObject
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.util.concurrent.Callable

/** Read-only statistics from original activity identities and dates, never sync arrival time. */
internal class LibraryReview(private val repo: LibraryRepository, private val clock: Clock = Clock.systemDefaultZone()) {
    private data class Snapshot(val records: List<LibraryRecord>,val versions: List<LibraryVersion>,
        val activities: List<LibraryActivity>,val provenance: List<LibraryProvenance>,val pending: Int)
    fun read(period: String, month: String? = null): JSONObject {
        val today=LocalDate.now(clock);val zone=clock.zone
        val from: LocalDate;val through: LocalDate
        if(period=="month") { require(month?.matches(Regex("\\d{4}-(0[1-9]|1[0-2])"))==true) { "INVALID_REVIEW_MONTH" }
            val selected=YearMonth.parse(month);from=selected.atDay(1);through=selected.atEndOfMonth()
        } else { require(period in setOf("1","7","14","30")) { "INVALID_REVIEW_PERIOD" };from=today.minusDays(period.toLong()-1);through=today }
        val data=repo.db.runInTransaction(Callable { Snapshot(repo.dao.allRecords(),repo.dao.allVersions(),repo.dao.allActivities(),repo.dao.allProvenance(),repo.dao.pendingOutbox(100_000).size) })
        val days=linkedMapOf<String,JSONObject>();var day=from
        while(!day.isAfter(through)){days[day.toString()]=JSONObject().put("day",day.toString()).put("added",0L).put("removed",0L).put("net",0L).put("historical",0L).put("collected",0);day=day.plusDays(1)}
        fun inPeriod(value: String?)=value!=null&&value>=from.toString()&&value<=through.toString()
        fun dayOf(value: String)=runCatching { Instant.parse(value).atZone(zone).toLocalDate().toString() }.getOrNull()
        val imports=data.provenance.associate { it.recordId to runCatching { JSONObject(it.json).optJSONObject("import") }.getOrNull() }
        val historicalIds=data.activities.filter { it.action in setOf("import","copy") }.map { it.recordId }.toSet()+imports.filterValues { it!=null }.keys
        val available=data.records.filter { !it.deleted&&imports[it.id]?.optString("duplicateOf").let { duplicate->duplicate.isNullOrBlank()||duplicate=="null" } }
        val byDate=available.filter { inPeriod(it.contentDay?:dayOf(it.createdAt)) }
        val collected=byDate.filter { it.kind in setOf("web","ai","reference") }
        collected.forEach { row->days[row.contentDay?:dayOf(row.createdAt)]?.let { it.put("collected",it.getInt("collected")+1) } }
        val historical=byDate.filter { it.id in historicalIds&&it.kind in setOf("journal","freewrite","idea","article") }
        historical.forEach { row->days[row.contentDay?:dayOf(row.createdAt)]?.let { it.put("historical",it.getLong("historical")+WritingDelta.count(row.markdown)) } }

        // Hashes bind both exact Markdown and source segments. No assumed chronological baseline.
        val textByHash=HashMap<String,String>();val emptyHash=hash("",JSONArray());textByHash[emptyHash]=""
        for(version in data.versions){val sources=runCatching { JSONArray(version.sourcesJson) }.getOrNull()?:continue
            if(join(sources)==version.markdown)textByHash[hash(version.markdown,sources)]=personal(sources)}
        for(record in data.records){val sources=runCatching { JSONArray(record.sourcesJson) }.getOrNull()?:continue
            if(join(sources)==record.markdown)textByHash[hash(record.markdown,sources)]=personal(sources)}
        for(activity in data.activities){val sources=runCatching { JSONArray(activity.afterSegmentsJson) }.getOrNull()?:continue
            if(hash(join(sources),sources)==activity.afterHash)textByHash[activity.afterHash]=personal(sources)}
        var added=0L;var removed=0L;var missingBaselines=0;var complexEdits=0
        val activeArticles=hashSetOf<String>();val recordsById=data.records.associateBy { it.id }
        for(activity in data.activities.distinctBy { it.activityId }){
            val activityDay=dayOf(activity.occurredAt)?:continue
            if(!inPeriod(activityDay))continue
            if(activity.action!="write")continue
            if(recordsById[activity.recordId]?.let { it.kind=="article"&&!it.deleted }==true)activeArticles.add(activity.recordId)
            // Legacy-derived activities are emitted once per origin. Modern activities
            // carry a complete mixed-source snapshot; their aggregate label can be unknown.
            if(activity.changeId==null&&activity.originDeviceId==null&&activity.authorship!="personal")continue
            val before=textByHash[activity.beforeHash];val after=textByHash[activity.afterHash]
            if(before==null||after==null){missingBaselines++;continue}
            val change=try { WritingDelta.between(before,after) } catch(error: IllegalStateException) {
                if(error.message!="WRITING_DIFF_TOO_COMPLEX")throw error
                complexEdits++;continue
            }
            added+=change.added;removed+=change.removed
            days[activityDay]?.let { it.put("added",it.getLong("added")+change.added).put("removed",it.getLong("removed")+change.removed).put("net",it.getLong("net")+change.added-change.removed) }
        }
        available.filter { it.kind=="article"&&
            (it.id !in historicalIds&&inPeriod(dayOf(it.updatedAt))||it.id in historicalIds&&inPeriod(it.contentDay))
        }.forEach { activeArticles.add(it.id) }
        val totals=JSONObject().put("added",added).put("removed",removed).put("net",added-removed)
            .put("personalRecords",byDate.count { it.kind in setOf("journal","idea","freewrite")&&it.origin=="personal" })
            .put("collected",collected.size).put("web",collected.count { it.kind=="web" }).put("ai",collected.count { it.kind=="ai" })
            .put("reference",collected.count { it.kind=="reference" }).put("articles",activeArticles.size)
            .put("finalized",available.count { it.id in activeArticles&&it.stage=="final" })
            .put("historicalRecords",historical.size).put("historicalChars",historical.sumOf { WritingDelta.count(it.markdown).toLong() })
        return JSONObject().put("libraryId",repo.libraryId).put("start",from.toString()).put("end",through.toString()).put("timeZone",zone.id)
            .put("totals",totals).put("daily",JSONArray(days.values.toList())).put("isComplete",repo.context().integrity=="complete"&&missingBaselines==0&&complexEdits==0)
            .put("completeThrough",repo.registryItem().lastSyncedAt?:JSONObject.NULL).put("localPending",data.pending)
            .put("missingBaselines",missingBaselines).put("complexEdits",complexEdits)
    }
    private fun join(values: JSONArray)=(0 until values.length()).joinToString(""){values.getJSONObject(it).getString("text")}
    private fun personal(values: JSONArray)=(0 until values.length()).map(values::getJSONObject).filter { it.optString("origin")=="personal" }.joinToString(""){it.getString("text")}
    private fun hash(markdown: String, sources: JSONArray)=Canonical.hash(mapOf("markdown" to markdown,"segments" to plain(sources)))
    private fun plain(value: Any?): Any?=when(value){
        JSONObject.NULL->null
        is JSONArray->(0 until value.length()).map { plain(value.get(it)) }
        is JSONObject->value.keys().asSequence().associateWith { plain(value.get(it)) }
        else->value
    }
}
