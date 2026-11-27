package io.github.wyf929597870.shiwen.library

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Callable

internal class WorkspaceThemes(private val repo: LibraryRepository) {
    private val documents = TopicDocuments(repo.dao)
    private fun load(id: String): JSONObject {
        UUID.fromString(id)
        return documents.read("workspace-theme:$id") ?: error("主题不存在")
    }
    private fun summary(row: JSONObject) = JSONObject().put("id",row.getString("id"))
        .put("title",row.getString("title")).put("summary",row.getString("summary"))
        .put("revision",row.getInt("revision")).put("memberCount",row.optJSONArray("members")?.length() ?: row.getInt("memberCount"))
    private fun sourceTexts(row: LibraryRecord, field: String): List<String> = when (field) {
        "excerpt" -> {
            require(row.kind == "reading_note")
            val excerpts = JSONObject(row.annotation ?: "{}").optJSONArray("excerpts")
            (0 until (excerpts?.length() ?: 0)).map { excerpts!!.getJSONObject(it).getString("text") }
        }
        "reflection","body" -> listOf(row.markdown)
        else -> error("来源字段无效")
    }
    private fun located(theme: JSONObject): JSONObject {
        val members = theme.getJSONArray("members")
        for (i in 0 until members.length()) {
            val member = members.getJSONObject(i)
            val row = repo.dao.record(member.getString("sourceRecordId"))
            val location = JSONObject().put("status","changed")
            if (member.optBoolean("sourceBlocked") || member.optString("sourceLibraryId") != repo.libraryId) location.put("status","library_mismatch")
            else if (row == null || row.deleted) location.put("status","deleted")
            else if (row.kind == member.getString("sourceKind")) {
                member.put("currentTitle", row.title).put("currentKind",row.kind)
                val quote = member.getString("quote")
                val fields = sourceTexts(row, member.getString("field"))
                val index = member.optInt("excerptIndex",0)
                val start = member.getInt("start")
                val whole = member.getBoolean("whole")
                val same = row.revision == member.getLong("sourceRevision") && fields.getOrNull(index)?.let { if (whole) it == quote else it.startsWith(quote,start) } == true
                if (same) location.put("status","current").put("start",start).put("end",start+quote.length).put("excerptIndex",index)
                else if (quote.isNotEmpty()) {
                    var count = 0
                    for ((n,text) in fields.withIndex()) {
                        val at = text.indexOf(quote)
                        if (at < 0 || whole && text != quote) continue
                        count += if (text.indexOf(quote,at+1) >= 0) 2 else 1
                        location.put("start",at).put("end",at+quote.length).put("excerptIndex",n)
                    }
                    location.put("status", when(count) { 0 -> "changed"; 1 -> "moved"; else -> "ambiguous" })
                }
            }
            member.put("location",location)
        }
        return theme
    }
    fun perform(request: JSONObject): Any = repo.db.runInTransaction(Callable {
        val method = request.getString("method")
        val args = request.optJSONObject("args") ?: JSONObject()
        when (method) {
            "themeList" -> JSONArray(repo.dao.workspaceThemes().map { summary(JSONObject(it)) }.sortedBy { it.optString("title") })
            "themeRead" -> located(load(args.getString("id")))
            else -> {
                require(args.optString("expectedLibraryId") == repo.libraryId) { "资料库已切换" }
                val existing = args.optString("themeId",args.optString("id"))
                val theme = if (existing.isNotEmpty()) load(existing).also {
                    require(it.getInt("revision") == args.getInt("revision")) { "主题已更新，请重新读取" }
                } else {
                    require(method == "themeSave")
                    JSONObject().put("id",UUID.randomUUID().toString()).put("revision",0).put("members",JSONArray())
                }
                val members = theme.getJSONArray("members")
                val id = theme.getString("id")
                val key = "workspace-theme:$id"
                val editedAt = java.time.Instant.ofEpochMilli(System.currentTimeMillis()).toString()
                if (repo.registryItem().role != "standalone") repo.dao.putMeta(LibraryMeta("topic-dirty:$id",editedAt))
                for (field in listOf("titleUpdated","summaryUpdated")) {
                    if (!theme.has(field)) theme.put(field,theme.optString("updated",java.time.Instant.EPOCH.toString()))
                }
                theme.put("updated",editedAt)
                when (method) {
                    "themeSave" -> {
                        val title = args.getString("title").trim()
                        require(title.length in 1..200 && args.optString("summary").length <= 10000)
                        if (theme.optString("title") != title || !theme.has("titleUpdated")) theme.put("titleUpdated",editedAt)
                        if (!theme.has("summary") || theme.optString("summary") != args.optString("summary")) theme.put("summaryUpdated",editedAt)
                        theme.put("title",title).put("summary",args.optString("summary"))
                    }
                    "themeDelete" -> { documents.write(key,null); return@Callable JSONObject().put("deleted",true) }
                    "themeMemberAdd" -> {
                        val row = repo.read(args.getString("sourceRecordId"))
                        require(!row.deleted && row.kind != "ai_annotation" && row.revision == args.getLong("sourceRevision")) { "请重新读取当前原文" }
                        val field = args.getString("field")
                        val n = args.optInt("excerptIndex",0)
                        require(field == "excerpt" && row.kind == "reading_note" || field == "reflection" && row.kind == "reading_note" || field == "body" && row.kind != "reading_note")
                        val source = sourceTexts(row,field)[n]
                        val whole = !args.has("quote")
                        val start = if (whole) 0 else args.getInt("start")
                        val quote = if (whole) source else args.getString("quote")
                        require(quote.length <= 1_000_000 && members.length() < 10000 && start >= 0 && source.startsWith(quote,start) && (whole || quote.isNotEmpty() && args.getInt("end") == start + quote.length))
                        members.put(JSONObject().put("id",UUID.randomUUID().toString()).put("sourceRecordId",row.id)
                            .put("sourceTitle",row.title).put("sourceKind",row.kind).put("sourceRevision",row.revision)
                            .put("created",java.time.Instant.now().toString())
                            .put("prefix",source.substring(maxOf(0,start-64),start))
                            .put("suffix",source.substring(start+quote.length,minOf(source.length,start+quote.length+64)))
                            .put("sourceLibraryId",repo.libraryId).put("field",field).put("whole",whole)
                            .put("start",start).put("end",start+quote.length).put("quote",quote)
                            .apply { if (field == "excerpt") put("excerptIndex",n) })
                    }
                    "themeMemberRemove" -> {
                        val index = (0 until members.length()).firstOrNull { members.getJSONObject(it).getString("id") == args.getString("memberId") } ?: error("未找到片段")
                        members.remove(index)
                    }
                    else -> error("无效的主题操作")
                }
                theme.put("revision",theme.getInt("revision")+1)
                documents.write(key,theme)
                if (method == "themeSave") summary(theme) else located(theme)
            }
        }
    })
}
