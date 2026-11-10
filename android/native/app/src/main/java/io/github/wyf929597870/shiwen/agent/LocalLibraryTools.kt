package io.github.wyf929597870.shiwen.agent

import ai.koog.agents.core.tools.ToolRegistry
import io.github.wyf929597870.shiwen.model.Canonical
import io.github.wyf929597870.shiwen.probe.ProbeDraft
import io.github.wyf929597870.shiwen.library.AgentLibraryAccess
import io.github.wyf929597870.shiwen.library.LibraryRepository
import org.json.JSONObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** Bound to one native repository. Suggestions require a separate explicit user decision. */
internal fun localLibraryTools(repository: AgentLibraryAccess, approvedDraft: ProbeDraft? = null,
    taskId: String? = null, conversationId: String? = null): ToolRegistry = ToolRegistry {
    tool(LibraryTool("search_records", "在当前手机资料库按标题或正文检索，返回最多 20 条标题和日期。", listOf("query")) { args ->
        val query = args.getValue("query")
        require(query.isNotBlank() && query.length <= 200)
        withContext(Dispatchers.IO) {
            Canonical.encode(repository.searchForAgent(query).map {
                mapOf("id" to it.id, "title" to it.title, "createdAt" to it.createdAt,
                    "contentDay" to it.contentDay, "origin" to it.origin, "kind" to it.kind)
            })
        }
    })
    tool(LibraryTool("read_record", "读取当前手机资料库的记录，正文过长时截取前 16000 字符并明确标记。", listOf("id")) { args ->
        withContext(Dispatchers.IO) {
            val row = checkNotNull(repository.readForAgent(args.getValue("id"))) { "RECORD_NOT_FOUND" }
            Canonical.encode(mapOf("id" to row.id, "title" to row.title,
                "markdown" to row.markdown.take(16_000), "truncated" to (row.markdown.length > 16_000),
                "kind" to row.kind, "revision" to row.revision, "annotation" to row.annotation,
                "origin" to row.origin, "contentDay" to row.contentDay, "libraryId" to repository.libraryId))
        }
    })
    tool(LibraryTool("read_record_chunk", "分段读取长文，offset是上一段返回的nextOffset（首段填0）。一次最多16000字符，不会跨资料库读取。",listOf("id","offset")) { args ->
        withContext(Dispatchers.IO) {
            val row = checkNotNull(repository.readForAgent(args.getValue("id"))) { "RECORD_NOT_FOUND" }
            val start = args.getValue("offset").toIntOrNull() ?: error("INVALID_RECORD_OFFSET")
            require(start in 0..row.markdown.length) { "INVALID_RECORD_OFFSET" }
            var end = minOf(row.markdown.length,start+16_000)
            if(end<row.markdown.length&&end>start&&row.markdown[end-1].isHighSurrogate()) end--
            Canonical.encode(mapOf("id" to row.id,"title" to row.title,"offset" to start,"markdown" to row.markdown.substring(start,end),
                "kind" to row.kind,"revision" to row.revision,"annotation" to row.annotation,
                "totalCharacters" to row.markdown.length,"nextOffset" to if(end<row.markdown.length) end else null,"libraryId" to repository.libraryId))
        }
    })
    if (approvedDraft != null) tool(LibraryTool("save_approved_record",
        "保存本轮由用户明确确认的原文，正文与类型不可改写。重复调用返回同一条记录。", emptyList()) {
        withContext(Dispatchers.IO) {
            currentCoroutineContext().ensureActive()
            val row = repository.saveApprovedDraft(approvedDraft)
            Canonical.encode(mapOf("status" to "applied", "recordId" to row.id,
                "requestId" to approvedDraft.requestId, "libraryId" to repository.libraryId, "origin" to "personal"))
        }
    })
    if (repository is LibraryRepository && taskId != null && conversationId != null) {
        val actions = AgentRecordActions(repository)
        tool(LibraryTool("list_records_by_date", "按内容日期倒序分页列出本库资料，start/end为YYYY-MM-DD，cursor首段填0，之后填nextCursor。可连续读取超过200条的完整月份。",listOf("start","end","cursor")) { args ->
            withContext(Dispatchers.IO) { AgentLibraryQuery(repository).byDate(args.getValue("start"),args.getValue("end"),
                args.getValue("cursor").toIntOrNull() ?: error("INVALID_DATE_CURSOR")).toString() }
        })
        tool(LibraryTool("propose_memory", "只有用户明确希望记住时提出长期记忆候选。候选不会注入上下文，必须在本机人设设置里由用户确认。",listOf("body")) { args ->
            withContext(Dispatchers.IO) { LocalAgentProfileStore(repository).propose(taskId,args.getValue("body")).toString() }
        })
        tool(LibraryTool("review_library", "按内容日期查看当前完整资料库，起止日期使用 YYYY-MM-DD；统计是否覆盖完整副本会明确返回。",listOf("start","end")) { args ->
            withContext(Dispatchers.IO) { actions.review(args.getValue("start"),args.getValue("end")).toString() }
        })
        tool(LibraryTool("propose_save_record", "提出保存新记录建议。patch是JSON字符串，包含kind/title/markdown及可选contentDay/dateBasis/url/annotation/stage；读书笔记用kind=reading_note，title为书名、markdown只含感想；annotation为JSON字符串，结构是{schema:shiwen.reading-note.v1,chapter:章节,page:页码,excerpts:[{text:摘录,page:页码}]}，摘录不计感想字数，同书每次记录独立保存。生成正文标为AI。仅创建待确认建议，用户确认前不能声称已保存。",listOf("patch")) { args ->
            withContext(Dispatchers.IO) { actions.propose(taskId,conversationId,"create",null,JSONObject(args.getValue("patch"))).toString() }
        })
        tool(LibraryTool("propose_update_record", "提出单条记录的修改建议。patch是JSON字符串，仅含要修改的kind/title/markdown/origin/processing/contentDay/dateBasis/url/annotation/stage。读书笔记的annotation保存章节页码与摘录，修改时读取并保留未修改的内容，不把摘录混入markdown。可以更正已有资料的类型和来源；正文改写始终标为AI，须用户确认。",listOf("id","patch")) { args ->
            withContext(Dispatchers.IO) { actions.propose(taskId,conversationId,"update",args.getValue("id"),JSONObject(args.getValue("patch"))).toString() }
        })
        for (action in listOf("delete","restore")) tool(LibraryTool("propose_${action}_record",
            if(action=="delete") "提出将一条记录移入回收站的建议，必须由用户确认。" else "提出恢复一条回收站记录的建议，必须由用户确认。",listOf("id")) { args ->
            withContext(Dispatchers.IO) { actions.propose(taskId,conversationId,action,args.getValue("id"),JSONObject()).toString() }
        })
    }
}
