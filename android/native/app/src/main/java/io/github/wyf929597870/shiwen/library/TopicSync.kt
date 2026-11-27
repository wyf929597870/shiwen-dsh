package io.github.wyf929597870.shiwen.library

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Callable

private fun JSONObject.membersById() = getJSONArray("members").objects().associateBy { it.getString("id") }
private fun JSONObject.memberIds() = getJSONArray("ids").let { a -> (0 until a.length()).map(a::getString).toSet() }
private fun topicBase(theme: JSONObject, revision: Int) = obj(
    "title" to theme.getString("title"), "summary" to theme.getString("summary"),
    "updated" to edit(theme), "titleUpdated" to edit(theme,"titleUpdated"), "summaryUpdated" to edit(theme,"summaryUpdated"),
    "ids" to JSONArray(theme.membersById().keys.toList()), "revision" to revision
)
private fun matchesBase(theme: JSONObject?, base: JSONObject?): Boolean {
    if (theme == null || base == null || base.optBoolean("deleted")) return theme==null && (base==null || base.optBoolean("deleted"))
    return theme.getString("title")==base.getString("title") && theme.getString("summary")==base.getString("summary") &&
        theme.membersById().keys == base.memberIds() && listOf("updated","titleUpdated","summaryUpdated").all { edit(theme,it)==edit(base,it) }
}

private val unknownEdit = java.time.Instant.EPOCH.toString()
private fun newer(first:String, second:String) = java.time.Instant.parse(first) > java.time.Instant.parse(second)
private fun edit(row:JSONObject?,key:String="updated") =
    java.time.Instant.parse(row?.stringValue(key) ?: row?.stringValue("updated") ?: unknownEdit).toString()
private fun latest(a:String,b:String) = if (newer(a,b)) a else b

/** Independent passage edits commute. Conflicting field edits use edit time, with desktop winning an exact tie. */
internal fun mergeTopic(base:JSONObject?, phone:JSONObject?, desktop:JSONObject?, phoneDeletion:String?, desktopDeletion:String?):JSONObject? {
    if (matchesBase(phone,base)) return desktop
    if (desktop==null) {
        if (desktopDeletion==null) return phone
        return phone?.takeIf { newer(edit(it),desktopDeletion) }
    }
    if (phone==null) {
        if (matchesBase(desktop,base)) return null
        return if (phoneDeletion!=null && newer(phoneDeletion,edit(desktop))) null else desktop
    }
    val oldIds = base?.optJSONArray("ids")?.let { base.memberIds() }.orEmpty()
    val local = phone.membersById()
    val remote = desktop.membersById()
    val result = JSONObject(desktop.toString())
    for (key in listOf("title","summary")) {
        val clock = key+"Updated"
        val before = base?.stringValue(key)
        val left = phone.getString(key)
        val right = desktop.getString(key)
        val leftChanged = left!=before || edit(phone,clock)!=edit(base,clock)
        val rightChanged = right!=before || edit(desktop,clock)!=edit(base,clock)
        val usePhone = leftChanged && (!rightChanged || newer(edit(phone,clock),edit(desktop,clock)))
        result.put(key,if (usePhone) left else right)
        result.put(clock,if (left==right) latest(edit(phone,clock),edit(desktop,clock)) else edit(if (usePhone) phone else desktop,clock))
    }
    val members = remote.filterKeys { it !in oldIds || it in local }.values +
        local.filterKeys { it !in oldIds && it !in remote }.values
    result.put("updated",latest(edit(phone),edit(desktop))).put("members",JSONArray(members))
    return result
}

internal class TopicSync(
    private val repo: LibraryRepository, private val epoch: String,
    private val rpc: (String,JSONObject)->JSONObject,
    private val download: (JSONObject)->JSONObject,
    private val submit: (JSONObject)->JSONObject
) {
    private val docs = TopicDocuments(repo.dao)
    private fun local(id:String) = docs.read("workspace-theme:$id")
    private fun base(id:String) = docs.read("topic-base:$id")
    private fun dirty(id:String) = repo.dao.meta("topic-dirty:$id") != null

    private fun readRemote(id:String,revision:Int):JSONObject? {
        if (revision==0) return null
        val members = mutableListOf<JSONObject>()
        var after = ""
        while (true) {
            val reply = rpc("topicPage",obj("id" to id,"revision" to revision,"after" to after))
            val page = reply.optJSONObject("pageRef")?.let(download) ?: reply
            if (page.optBoolean("stale")) throw StalePage(page.getInt("revision"))
            if (page.optBoolean("deleted")) return page
            val header = page.getJSONObject("theme")
            check(header.getString("id")==id && header.getInt("revision")==revision)
            members.addAll(page.getJSONArray("members").objects())
            val next = page.stringValue("next") ?: return header.put("members",JSONArray(
                members.sortedWith(compareBy({it.optString("created")},{it.getString("id")}))))
            check(next > after)
            after = next
        }
    }
    private class StalePage(val revision:Int):Exception()

    // Commit the remote baseline, visible local merge and retryable outbound request together.
    private fun stage(id:String,snapshot:JSONObject?) {
        val previous = local(id)
        val remote = snapshot?.takeUnless { it.optBoolean("deleted") }
        val deletion = repo.dao.meta("topic-dirty:$id")?.takeUnless { it=="1" }
        // An empty, rebuilt coordinator has no deletion marker. Seed it from the surviving replica.
        val commonBase = if (snapshot == null) null else base(id)
        val theme = mergeTopic(commonBase,previous,remote,deletion,snapshot?.takeIf { it.optBoolean("deleted") }?.stringValue("updated"))
        val serverRevision = snapshot?.getInt("revision") ?: 0
        val serverBase = remote?.let { topicBase(it,serverRevision) } ?: snapshot
        if (theme!=null && remote==null && !theme.has("updated")) {
            // Legacy standalone themes did not record an edit time. Date their first import once.
            val imported = java.time.Instant.ofEpochMilli(System.currentTimeMillis()).toString()
            theme.put("updated",imported).put("titleUpdated",imported).put("summaryUpdated",imported)
        }
        val generation = (previous?.getInt("revision") ?: 0)+1
        if (theme != null) theme.put("revision",generation)
        docs.write("workspace-theme:$id",theme)
        repo.dao.putMeta(LibraryMeta("topic-changes",UUID.randomUUID().toString()))
        docs.write("topic-base:$id",serverBase)
        if (matchesBase(theme,serverBase)) {
            repo.dao.removeWorkspaceMeta("topic-dirty:$id")
            return
        }
        val op = obj("id" to id,"operationId" to UUID.randomUUID().toString(),
            "expectedRevision" to serverRevision, "deleted" to (theme==null),
            "updated" to (theme?.let { edit(it) } ?: deletion ?: unknownEdit))
        if (theme != null) {
            val oldIds = remote?.membersById()?.keys.orEmpty()
            val members = theme.membersById()
            op.put("titleUpdated",edit(theme,"titleUpdated")).put("summaryUpdated",edit(theme,"summaryUpdated"))
            op.put("title",theme.getString("title")).put("summary",theme.getString("summary"))
                .put("add",JSONArray(members.filterKeys { it !in oldIds }.values))
                .put("remove",JSONArray((oldIds - members.keys).toList()))
        }
        repo.dao.putMeta(LibraryMeta("topic-dirty:$id",op.getString("updated")))
        docs.write("topic-flight:$id",obj("epoch" to epoch,"operation" to op,
            "base" to theme?.let { topicBase(it,0) }, "generation" to generation))
    }

    // Replay exactly the saved bytes after a lost reply, even if the user edited or deleted the theme meanwhile.
    private fun flush(id:String):Int? {
        val flight = repo.db.runInTransaction(Callable { docs.read("topic-flight:$id") }) ?: return null
        if (flight.getString("epoch")!=epoch) {
            repo.db.runInTransaction { docs.write("topic-flight:$id",null) }
            return null
        }
        val ack = submit(flight.getJSONObject("operation"))
        return repo.db.runInTransaction(Callable {
            docs.write("topic-flight:$id",null)
            val revision = ack.getInt("revision")
            if (!ack.optBoolean("stale")) {
                docs.write("topic-base:$id",(flight.optJSONObject("base") ?: obj("deleted" to true)).put("revision",revision).put("refresh",true))
                val current = local(id)
                if (current?.optInt("revision")==flight.getInt("generation") || current==null && flight.isNull("base"))
                    repo.dao.removeWorkspaceMeta("topic-dirty:$id")
            }
            revision
        })
    }

    fun sync() {
        // Resolve uncertain writes before reading current versions and deletion markers.
        for (id in docs.ids("topic-flight:")) flush(id)
        val heads = mutableMapOf<String,Int>()
        var after = ""
        while (true) {
            val page = rpc("topicHeads",obj("after" to after))
            for (row in page.getJSONArray("heads").objects()) heads[row.getString("id")] = row.getInt("revision")
            val next = page.stringValue("next") ?: break
            check(next > after)
            after = next
        }
        val ids = heads.keys + docs.ids("workspace-theme:") + docs.ids("topic-base:") + docs.ids("topic-dirty:")
        val epochChanged = repo.dao.meta("topic-epoch")!=epoch
        for (id in ids) {
            var revision = heads[id] ?: 0
            val old = repo.db.runInTransaction(Callable { base(id) })
            if (!epochChanged && old!=null && revision==old.getInt("revision") && !old.optBoolean("refresh") && !dirty(id)) continue
            var finished = false
            for (attempt in 1..6) {
                val remote = try { readRemote(id,revision) } catch (change:StalePage) { revision=change.revision; continue }
                repo.db.runInTransaction { stage(id,remote) }
                val nextRevision = flush(id)
                if (nextRevision==null) {
                    finished = true
                    break
                }
                revision = nextRevision
            }
            check(finished) { "TOPIC_CHANGED_DURING_SYNC" }
        }
        repo.dao.putMeta(LibraryMeta("topic-epoch",epoch))
    }
}
