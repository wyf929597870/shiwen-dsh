package io.github.wyf929597870.shiwen.library

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.Callable

/** The card target, the new library item and its retry receipt commit together. */
internal class PhoneRecommendationAction(private val repo: LibraryRepository) {
    fun perform(method: String, args: JSONObject, resolved: JSONArray): JSONObject = repo.db.runInTransaction(Callable {
        check(repo.registryItem().role == "standalone" && args.getString("expectedLibraryId") == repo.libraryId)
        val requestId = UUID.fromString(args.getString("requestId")).toString()
        val receiptKey = "phone-recommendation:action:$requestId"
        val id = args.getString("cardId")
        require(id.matches(Regex("[a-f0-9]{64}")))
        val fingerprint = "$method:$args"
        repo.dao.meta(receiptKey)?.let {
            val receipt = JSONObject(it)
            require(receipt.getString("fingerprint") == fingerprint) { "请求编号冲突" }
            return@Callable receipt.getJSONObject("result")
        }
        val key = "phone-recommendation:card-$id"
        val card = JSONObject(repo.dao.meta(key) ?: error("找不到卡片"))
        check(card.getInt("cardRevision") == args.getInt("cardRevision")) { "卡片已变化，请重新打开" }
        val targets = card.getJSONObject("targets")
        val quotes = (0 until resolved.length()).map(resolved::getJSONObject)
        val stored = card.getJSONArray("quotes")
        for (q in quotes) {
            check((0 until stored.length()).map(stored::getJSONObject).any {
                it.getString("quoteId")==q.getString("quoteId") && it.getString("recordId")==q.getString("recordId") &&
                    it.getString("text")==q.getString("text") && it.getString("field")==q.getString("field")
            }) { "选中的引文不属于当前卡片" }
            val row = repo.read(q.getString("recordId"))
            check(!row.deleted && row.revision == q.getLong("sourceRevision")) { "原文已变化，请重新选择" }
        }
        val result = when (method) {
            "shiwen_assist_save_decision", "shiwen_assist_create_draft" -> {
                val draft = method == "shiwen_assist_create_draft"
                val bucket = targets.getJSONArray(if (draft) "drafts" else "decisions")
                val existing = if (draft && args.optString("mode")=="first")
                    (0 until bucket.length()).map(bucket::getJSONObject).firstOrNull { repo.dao.record(it.getString("id"))?.deleted==false } else null
                if (existing != null) JSONObject().put("articleId",existing.getString("id")).put("status","existing")
                else {
                    if (draft) require(quotes.isNotEmpty())
                    val title = if (draft) args.getString("title").trim() else args.getString("body").trim().lineSequence().first().take(70)
                    val body = if (draft) quotes.joinToString("\n\n") { q ->
                        "> "+q.getString("text").replace("\n","\n> ")+"\n> — "+q.optString("title")
                    }+"\n\n"+card.optString("followup") else args.getString("body").trim()
                    require(body.isNotBlank() && title.isNotBlank())
                    val origin = if (draft) "ai" else "personal"
                    val record = JSONObject().put("id",requestId).put("title",title).put("markdown",body)
                        .put("kind",if (draft) "article" else "idea").put("origin",origin)
                    if (draft) record.put("stage","draft").put("sourceIds",JSONArray(quotes.map { it.getString("recordId") }.distinct()))
                    else record.put("contentDay",LocalDate.parse(args.getString("day")).toString()).put("dateBasis","用户确认的决定日期")
                    val row = repo.create(requestId,record,1)
                    bucket.put(JSONObject().put("id",row.id).put("title",row.title))
                    JSONObject().put(if (draft) "articleId" else "recordId",row.id).put("status","created").put("title",row.title)
                }
            }
            "shiwen_assist_add_to_theme" -> {
                require(quotes.isNotEmpty())
                val themes = WorkspaceThemes(repo)
                fun theme(method: String, a: JSONObject): JSONObject = themes.perform(JSONObject().put("method",method)
                    .put("args",a.put("expectedLibraryId",repo.libraryId))) as JSONObject
                var target = if (args.has("themeId")) theme("themeRead",JSONObject().put("id",args.getString("themeId")))
                    else theme("themeSave",JSONObject().put("title",args.getString("newThemeTitle")))
                if(args.has("themeId")) check(target.getInt("revision")==args.getInt("themeRevision")) { "主题已变化，请重新选择" }
                val themeId = target.getString("id")
                val links = targets.getJSONArray("themes")
                val link = (0 until links.length()).map(links::getJSONObject).firstOrNull { it.getString("themeId")==themeId }
                    ?: JSONObject().put("themeId",themeId).put("title",target.getString("title")).put("items",JSONArray()).also { links.put(it) }
                val results = JSONArray()
                for (q in quotes) {
                    val members=target.optJSONArray("members") ?: JSONArray()
                    val existing=(0 until members.length()).map(members::getJSONObject).firstOrNull {
                        it.getString("sourceRecordId")==q.getString("recordId") && it.getString("field")==q.getString("field") &&
                            it.optInt("excerptIndex",-1)==q.optInt("excerptIndex",-1) && it.getString("quote")==q.getString("text") &&
                            it.optJSONObject("location")?.optInt("start")==q.getInt("start")
                    }
                    val memberId=existing?.getString("id") ?: run {
                        val a=JSONObject().put("themeId",themeId).put("revision",target.getInt("revision")).put("sourceRecordId",q.getString("recordId"))
                            .put("sourceRevision",q.getLong("sourceRevision")).put("field",q.getString("field")).put("start",q.getInt("start"))
                            .put("end",q.getInt("end")).put("quote",q.getString("text"))
                        if (!q.isNull("excerptIndex")) a.put("excerptIndex",q.getInt("excerptIndex"))
                        target=theme("themeMemberAdd",a)
                        target.getJSONArray("members").let { it.getJSONObject(it.length()-1).getString("id") }
                    }
                    val item=JSONObject().put("quoteId",q.getString("quoteId")).put("memberId",memberId).put("status",if(existing==null)"added" else "already_present")
                    results.put(item)
                    val items=link.getJSONArray("items")
                    if((0 until items.length()).none { items.getJSONObject(it).getString("memberId")==memberId })items.put(item)
                }
                JSONObject().put("themeId",themeId).put("items",results)
            }
            else -> error("未知推荐操作")
        }
        val revision = card.getInt("cardRevision")+1
        result.put("cardRevision",revision)
        repo.dao.putMeta(LibraryMeta(key,card.put("cardRevision",revision).toString()))
        val stateKey="phone-recommendation:state"
        val state=JSONObject(checkNotNull(repo.dao.meta(stateKey)))
        repo.dao.putMeta(LibraryMeta(stateKey,state.put("version",state.getInt("version")+1).toString()))
        repo.dao.putMeta(LibraryMeta(receiptKey,JSONObject().put("fingerprint",fingerprint).put("result",result).toString()))
        result
    })
}
