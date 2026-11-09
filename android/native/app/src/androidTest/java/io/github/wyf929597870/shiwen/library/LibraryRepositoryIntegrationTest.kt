package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import io.github.wyf929597870.shiwen.agent.AgentRecordActions
import io.github.wyf929597870.shiwen.agent.LocalAgentProfileStore
import io.github.wyf929597870.shiwen.agent.AgentLibraryQuery

/** Every database here has a unique synthetic name; no test opens the installed user's P0 library. */
@RunWith(AndroidJUnit4::class)
class LibraryRepositoryIntegrationTest {
    private fun withRepository(role: String = "standalone", block: (LibraryRepository) -> Unit) {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val libraryId = UUID.randomUUID().toString()
        val registryFile = "formal-fixture-registry-$libraryId.sqlite"
        val libraryFile = "formal-fixture-library-$libraryId.sqlite"
        val registry = Room.databaseBuilder(context, LibraryRegistryDatabase::class.java, registryFile).build()
        val row = LibraryRegistryRow(libraryId, "Synthetic library", UUID.randomUUID().toString(), libraryFile,
            role, "complete", null, null, 1, null, null, null, null, null, 1, true, false, false, "{}")
        registry.dao().insert(row)
        val repository = LibraryRepository(context, libraryId, row.deviceId, row.name, registry, row)
        try { block(repository) }
        finally {
            repository.executor.shutdownNow(); repository.db.close(); registry.close()
            context.deleteDatabase(libraryFile); context.deleteDatabase(registryFile)
        }
    }
    private fun input(markdown: String = "保留这段原文", origin: String = "personal") = JSONObject()
        .put("kind", "journal").put("title", "Synthetic record").put("markdown", markdown)
        .put("origin", origin).put("processing", "original")
        .put("contentDay", "2024-03-01").put("dateBasis", "用户确认")
        .put("sources", JSONArray().put(JSONObject().put("text", markdown).put("origin", origin)))

    @Test fun annotationsKeepVersionAndSurviveParentDeletionWithoutEnteringOrdinaryLists() = withRepository("coordinated") { repo ->
        val original = repo.create(UUID.randomUUID().toString(), input("原文"), 1)
        val info = repo.originalVersionInfo(original.id)
        val annotation = repo.annotationCreate(original.id, info.getString("versionId"), info.getString("contentHash"), "标注", "AI 文本", UUID.randomUUID().toString())
        assertEquals("ai", annotation.origin)
        assertEquals(info.getString("versionId"), JSONObject(annotation.annotationOfJson!!).getString("versionId"))
        assertEquals(1, repo.list().size)
        assertEquals(1, repo.annotationList(original.id).size)
        assertThrows(IllegalArgumentException::class.java) { repo.update(annotation.id, annotation.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "错误")) }
        val updated = repo.update(original.id, original.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "新原文"))
        assertEquals("AI 文本", repo.annotationRead(annotation.id).markdown)
        assertNotEquals(updated.versionId, JSONObject(annotation.annotationOfJson!!).getString("versionId"))
        val deleted = repo.update(original.id, updated.revision, UUID.randomUUID().toString(), JSONObject().put("deleted", true))
        assertTrue(repo.annotationList(original.id).isEmpty())
        repo.update(original.id, deleted.revision, UUID.randomUUID().toString(), JSONObject().put("deleted", false))
        assertEquals(annotation.id, repo.annotationList(original.id).single().id)
        val outbox = repo.dao.allOutbox().first { it.recordId == annotation.id }
        assertEquals(original.id, JSONObject(outbox.payloadJson).getJSONObject("payload").getJSONObject("annotationOf").getString("recordId"))
    }

    @Test fun journalAliasPreservesAnnotationSourceAndFrozenOperation() = withRepository("coordinated") { repo ->
        val journal = repo.create(UUID.randomUUID().toString(), input("手机原文"), 1)
        val info = repo.originalVersionInfo(journal.id)
        val unsentRequest = UUID.randomUUID().toString()
        val unsent = repo.annotationCreate(journal.id, info.getString("versionId"), info.getString("contentHash"), "未发送", "批注", unsentRequest)
        val attempted = repo.annotationCreate(journal.id, info.getString("versionId"), info.getString("contentHash"), "已发送", "批注", UUID.randomUUID().toString())
        val originalOp = repo.dao.allOutbox().single { it.recordId == attempted.id }
        repo.dao.updateOutbox(originalOp.copy(attempts = 1, state = "unknown"))
        val journalOp = repo.dao.allOutbox().single { it.recordId == journal.id }
        val canonical = UUID.randomUUID().toString(); val mergedVersion = UUID.randomUUID().toString()
        val remote = JSONObject(journalOp.payloadJson).getJSONObject("payload").put("id", canonical).put("markdown", "已有日记\n\n手机原文")
            .put("sources", JSONArray().put(JSONObject().put("text", "已有日记\n\n手机原文").put("origin", "personal")))
        val version = JSONObject().put("id", mergedVersion).put("recordId", canonical).put("revision", 3).put("markdown", remote.getString("markdown"))
            .put("title", remote.getString("title")).put("createdAt", remote.getString("updatedAt")).put("reason", "合并")
            .put("sources", remote.getJSONArray("sources")).put("parentVersionIds", JSONArray())
        val receipt = JSONObject().put("recordId", canonical).put("revision", 3).put("versionId", mergedVersion).put("changeId", journalOp.changeId)
            .put("inputVersionId", journal.versionId).put("inputVersionRevision", 2)
        repo.acceptJournalAppend(journalOp, receipt, remote, version)
        assertEquals("手机原文", repo.dao.versions(canonical).single { it.id == journal.versionId }.markdown)
        assertEquals(unsent.id, repo.annotationCreate(journal.id, info.getString("versionId"), info.getString("contentHash"), "未发送", "批注", unsentRequest).id)
        assertEquals(2, repo.annotationList(canonical).size)
        val anchor = JSONObject(repo.annotationRead(unsent.id).annotationOfJson!!)
        assertEquals(canonical, anchor.getString("recordId")); assertEquals(journal.versionId, anchor.getString("versionId")); assertEquals(info.getString("contentHash"), anchor.getString("contentHash"))
        val rewritten = repo.dao.allOutbox().single { it.recordId == unsent.id }
        assertEquals(canonical, JSONObject(rewritten.payloadJson).getJSONObject("payload").getJSONObject("annotationOf").getString("recordId"))
        val frozen = repo.dao.allOutbox().single { it.recordId == attempted.id }
        assertEquals(originalOp.payloadJson, frozen.payloadJson); assertEquals(originalOp.fingerprint, frozen.fingerprint)
    }

    @Test fun annotationReceiptReplaySurvivesParentDeletionAndRejectsChangedArguments() = withRepository { repo ->
        val parent = repo.create(UUID.randomUUID().toString(), input("原文"), 1)
        val info = repo.originalVersionInfo(parent.id)
        val request = UUID.randomUUID().toString()
        val annotation = repo.annotationCreate(parent.id, info.getString("versionId"), info.getString("contentHash"), "标题", "标注", request)
        val editRequest = UUID.randomUUID().toString()
        val updated = repo.annotationUpdate(annotation.id, annotation.revision, editRequest, JSONObject().put("markdown", "新标注"))
        repo.update(parent.id, parent.revision, UUID.randomUUID().toString(), JSONObject().put("deleted", true))
        assertEquals(annotation.id, repo.annotationCreate(parent.id, info.getString("versionId"), info.getString("contentHash"), "标题", "标注", request).id)
        assertEquals(updated.revision, repo.annotationUpdate(annotation.id, annotation.revision, editRequest, JSONObject().put("markdown", "新标注")).revision)
        assertThrows(IllegalStateException::class.java) { repo.annotationCreate(parent.id, info.getString("versionId"), info.getString("contentHash"), "篡改", "标注", request) }
        assertThrows(IllegalStateException::class.java) { repo.annotationUpdate(annotation.id, annotation.revision, editRequest, JSONObject().put("markdown", "篡改")) }
    }

    @Test fun dailyCaptureAppendsOnceAndEditingReplacesTheWholeDiary() = withRepository { repo ->
        val first = repo.create(UUID.randomUUID().toString(), input("早晨"), 1)
        val request = UUID.randomUUID().toString()
        val second = repo.create(request, input("晚上", "ai"), 1)
        assertEquals(first.id, second.id)
        assertEquals("早晨\n\n晚上", second.markdown)
        assertEquals(1, repo.list(kind = "journal").size)
        assertEquals(second.revision, repo.create(request, input("晚上", "ai"), 1).revision)
        val edited = repo.update(first.id, second.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "编辑后的全文"))
        assertEquals("编辑后的全文", edited.markdown)
        assertEquals(1, repo.list(kind = "journal").size)
        assertNotEquals(first.id, repo.create(UUID.randomUUID().toString(), input("另一天").put("contentDay", "2024-03-02"), 1).id)
    }

    @Test fun dailySyncAdoptsOneCanonicalRecordAndKeepsOfflineAppendQueue() = withRepository("coordinated") { repo ->
        val firstRequest = UUID.randomUUID().toString()
        val first = repo.create(firstRequest, input("手机第一段"), 1)
        val secondRequest = UUID.randomUUID().toString()
        repo.create(secondRequest, input("手机第二段"), 1)
        val firstOp = repo.dao.allOutbox().first { it.action == "create" }
        val target = UUID.randomUUID().toString()
        fun accept(row: LibraryOutbox, text: String, revision: Long) {
            val remote = JSONObject(JSONObject(row.payloadJson).getJSONObject("payload").toString())
                .put("id", target).put("markdown", text).put("title", "电脑上的日记")
                .put("sources", JSONArray().put(JSONObject().put("text", text).put("origin", "personal")))
            val version = JSONObject().put("id", row.versionId).put("recordId", target).put("revision", revision)
                .put("markdown", text).put("title", remote.getString("title")).put("createdAt", remote.getString("updatedAt"))
                .put("reason", "同步日记追加").put("sources", remote.getJSONArray("sources")).put("parentVersionIds", JSONArray())
            val receipt = JSONObject().put("recordId", target).put("revision", revision).put("versionId", row.versionId).put("changeId", row.changeId)
            repo.acceptJournalAppend(row, receipt, remote, version)
        }
        accept(firstOp, "电脑记录\n\n手机第一段", 2)
        assertEquals(1, repo.list(kind = "journal").size)
        assertEquals(target, repo.dao.receipt(firstRequest)!!.recordId)
        assertEquals(target, repo.dao.receipt(secondRequest)!!.recordId)
        assertNull(repo.dao.record(first.id))
        val pending = repo.dao.pendingOutbox(100).single()
        assertEquals(target, pending.recordId)
        assertEquals(target, JSONObject(pending.payloadJson).getJSONObject("payload").getString("id"))
        assertEquals("手机第一段\n\n手机第二段", repo.read(target).markdown)
        accept(pending, "电脑记录\n\n手机第一段\n\n手机第二段", 3)
        assertTrue(repo.dao.pendingOutbox(100).isEmpty())
        assertEquals("synced", repo.read(target).syncState)
        assertEquals("电脑记录\n\n手机第一段\n\n手机第二段", repo.read(target).markdown)
        assertEquals(target, repo.create(secondRequest, input("手机第二段"), 1).id)
        assertTrue(repo.dao.versions(target).any { it.markdown == "手机第一段" })
        assertTrue(repo.dao.allOutbox().all { it.recordId == target })
        assertTrue(repo.dao.allHeads().all { it.recordId == target })
    }

    @Test fun standaloneLegacyDuplicatesKeepTheirHistoryAfterConsolidation() = withRepository { repo ->
        repo.create(UUID.randomUUID().toString(), input("旧日记一"), 1)
        val other = repo.create(UUID.randomUUID().toString(), input("旧日记二").put("kind", "reference"), 1)
        repo.dao.updateRecord(other.copy(kind = "journal"))
        val active = repo.list(kind = "journal").single()
        assertTrue(active.markdown.contains("旧日记一")); assertTrue(active.markdown.contains("旧日记二"))
        val retired = repo.dao.allRecords().single { it.deleted }
        assertTrue(repo.dao.versions(retired.id).isNotEmpty())
        assertEquals(1, repo.list(kind = "journal").size)
    }

    @Test fun linkingMaterialsFiltersBeforePagingAndKeepsExistingQueries() = withRepository { repo ->
        repeat(103) { index ->
            repo.create(UUID.randomUUID().toString(), input().put("title", "Article $index").put("kind", "article").put("contentDay", "2025-03-01"), 1)
        }
        repeat(102) { index ->
            repo.create(UUID.randomUUID().toString(), input().put("title", "Material $index").put("kind", "reference"), 1)
        }
        assertTrue(repo.list(limit = 100).all { it.kind == "article" })
        val first = repo.list(limit = 100, excludeKind = "article")
        val second = repo.list(limit = 100, offset = 100, excludeKind = "article")
        assertEquals(100, first.size)
        assertEquals(2, second.size)
        assertTrue((first + second).all { it.kind == "reference" && !it.deleted })
        assertEquals(102, (first + second).map { it.id }.toSet().size)
        assertEquals(1, repo.list(query = "Material 101", excludeKind = "article").size)
        assertEquals(100, repo.list(kind = "article", limit = 100).size)
    }

    @Test fun localSaveIsAtomicIdempotentAndPreservesNewerComposerDraft() = withRepository { repo ->
        val requestId = UUID.randomUUID().toString()
        repo.saveDraft(requestId, "Synthetic record", "保留这段原文", "journal", 2)
        val first = repo.create(requestId, input(), 1)
        val again = repo.create(requestId, input(), 1)
        assertEquals(first.id, again.id)
        assertEquals(1, repo.dao.recordCount())
        assertEquals(1, repo.versions(first.id).size)
        assertEquals(1, repo.dao.activities(first.id).size)
        assertEquals(2L, repo.readDraft()!!.generation)
        assertNotNull(runCatching { repo.create(requestId, input("不能替换"), 1) }.exceptionOrNull())
        assertEquals("保留这段原文", repo.read(first.id).markdown)
    }

    @Test fun legacyEditorPendingRequestIgnoresDisplayStateAndReplaysOnce() = withRepository { repo ->
        val original = repo.create(UUID.randomUUID().toString(), input(), 1)
        val requestId = UUID.randomUUID().toString()
        val patch = input("手机修改后的正文").put("state", "synced").put("syncState", "synced")
        val saved = repo.update(original.id, original.revision, requestId, patch)
        val replay = repo.update(original.id, original.revision, requestId, patch)
        assertEquals("手机修改后的正文", saved.markdown)
        assertEquals(saved.revision, replay.revision)
        assertNotEquals("synced", saved.syncState)
        assertEquals(2, repo.versions(saved.id).size)
    }

    @Test fun reviewCountsOnlyPersonalUnicodeTextAndUsesOriginalActivityDay() = withRepository { repo ->
        val body="甲😀 \n乙AI整理内容"
        val segments=JSONArray().put(JSONObject().put("text","甲😀 \n乙").put("origin","personal"))
            .put(JSONObject().put("text","AI整理内容").put("origin","ai"))
        val record=repo.create(UUID.randomUUID().toString(),input(body).put("sources",segments),1)
        val first=LibraryReview(repo,java.time.Clock.systemUTC()).read("1")
        assertEquals(3L,first.getJSONObject("totals").getLong("added"))
        assertTrue(first.getBoolean("isComplete"))
        assertEquals(0,first.getJSONObject("totals").getInt("personalRecords")) // contentDay is historical
        assertEquals(first.toString(),LibraryReview(repo,java.time.Clock.systemUTC()).read("1").toString())
        val activity=repo.dao.activities(record.id).single()
        repo.db.openHelper.writableDatabase.execSQL("UPDATE activities SET occurredAt=? WHERE activityId=?",arrayOf("2024-03-01T12:00:00.000Z",activity.activityId))
        assertEquals(0L,LibraryReview(repo,java.time.Clock.systemUTC()).read("1").getJSONObject("totals").getLong("added"))
        assertEquals(3L,LibraryReview(repo,java.time.Clock.systemUTC()).read("month","2024-03").getJSONObject("totals").getLong("added"))
    }

    @Test fun originalReviewUsesContentDaysForTotalsTrendAndAllPersonalKinds() = withRepository { repo ->
        val original=repo.create(UUID.randomUUID().toString(),input("个人原文").put("kind","freewrite").put("contentDay","2024-03-09"),1)
        repo.create(UUID.randomUUID().toString(),input("我的参考").put("kind","reference").put("contentDay","2024-03-08"),1)
        repo.create(UUID.randomUUID().toString(),input("外部资料","external").put("kind","reference").put("contentDay","2024-03-09"),1)
        val anchor=repo.originalVersionInfo(original.id)
        repo.annotationCreate(original.id,anchor.getString("versionId"),anchor.getString("contentHash"),"历史 AI 标注","独立分析不计入原文",UUID.randomUUID().toString())
        val review=LibraryReview(repo,java.time.Clock.fixed(java.time.Instant.parse("2024-03-09T12:00:00Z"),java.time.ZoneOffset.UTC))
        val month=review.preview("month","2024-03")
        assertEquals(8L,month.getLong("personalOriginalCharacters"))
        assertEquals(2,month.getJSONArray("records").length())
        assertEquals(9,month.getJSONArray("daily").length())
        assertEquals(4L,month.getJSONArray("daily").getJSONObject(7).getLong("personalOriginalCharacters"))
        assertEquals(4L,month.getJSONArray("daily").getJSONObject(8).getLong("personalOriginalCharacters"))
        assertEquals(4L,review.preview("1").getLong("personalOriginalCharacters"))
    }

    @Test fun incompleteActivityBaselineIsReportedInsteadOfInventingWritingCounts() = withRepository { repo ->
        val record=repo.create(UUID.randomUUID().toString(),input("正文"),1)
        val activity=repo.dao.activities(record.id).single()
        repo.db.openHelper.writableDatabase.execSQL("UPDATE activities SET beforeHash=? WHERE activityId=?",arrayOf("a".repeat(64),activity.activityId))
        val result=LibraryReview(repo).read("1")
        assertFalse(result.getBoolean("isComplete"));assertEquals(1,result.getInt("missingBaselines"))
        assertEquals(0L,result.getJSONObject("totals").getLong("added"))
    }

    @Test fun localEditsHaveDurableHistoryAndLostAckCanBeReplayed() = withRepository { repo ->
        val first = repo.create(UUID.randomUUID().toString(), input(), 1)
        val editId = UUID.randomUUID().toString()
        val patch = input("修改之后的内容")
        val changed = repo.update(first.id, first.revision, editId, patch)
        val replay = repo.update(first.id, first.revision, editId, patch)
        assertEquals(changed.versionId, replay.versionId)
        assertEquals(2, repo.versions(first.id).size)
        assertEquals(2, repo.dao.activities(first.id).size)
        assertNotNull(runCatching { repo.update(first.id, first.revision, UUID.randomUUID().toString(), patch) }.exceptionOrNull())
        assertNotNull(runCatching { repo.update(first.id, first.revision, editId, input("换了内容")) }.exceptionOrNull())
    }

    @Test fun wireOutboxMatchesStrictSharedRecordAndActivityContracts() = withRepository("coordinated") { repo ->
        val record = repo.create(UUID.randomUUID().toString(), input(), 1)
        val outbox = repo.dao.pendingOutbox(10).single()
        val operation = JSONObject(outbox.payloadJson)
        assertEquals(record.id, operation.getString("recordId"))
        assertTrue(operation.isNull("baseVersionId")); assertTrue(operation.isNull("baseRevision"))
        val payload = operation.getJSONObject("payload")
        val expected = setOf("id", "kind", "title", "markdown", "origin", "processing", "contentDay", "dateBasis",
            "url", "annotation", "stage", "sourceIds", "sources", "attachmentDescriptors", "createdAt", "updatedAt", "deleted", "createdByDevice")
        assertEquals(expected, payload.keys().asSequence().toSet())
        assertEquals("", payload.getString("url")); assertEquals("draft", payload.getString("stage"))
        val activity = operation.getJSONArray("activities").getJSONObject(0)
        assertFalse(activity.has("recordId")); assertFalse(activity.has("changeId"))
        assertTrue(activity.getString("action") in setOf("write", "copy", "restore", "resolve"))
        assertTrue(activity.getString("authorship") in setOf("personal", "external", "ai", "translation", "unknown"))
    }

    @Test fun externalMaterialDoesNotBecomePersonalWriting() = withRepository { repo ->
        val created = repo.create(UUID.randomUUID().toString(), input("来源于文章", "external").put("kind", "web"), 1)
        assertEquals("external", repo.read(created.id).origin)
        assertEquals("external", repo.dao.activities(created.id).single().authorship)
        assertEquals("external", repo.readForAgent(created.id)!!.origin)
        assertTrue(repo.dao.pendingOutbox(10).isEmpty())
    }

    @Test fun approvedSourceCorrectionPreservesTextAndDoesNotInventNewWriting() = withRepository { repo ->
        val original=repo.create(UUID.randomUUID().toString(),input("被错误标记的口述原话","ai"),1)
        val actions=AgentRecordActions(repo)
        val proposal=actions.propose("source-task","source-conversation","update",original.id,
            JSONObject().put("origin","personal").put("processing","formatting"))
        assertEquals("ai",repo.read(original.id).origin)
        actions.decide(proposal.getString("id"),"source-conversation",true)
        val corrected=repo.read(original.id)
        assertEquals(original.markdown,corrected.markdown)
        assertEquals("personal",JSONArray(corrected.sourcesJson).getJSONObject(0).getString("origin"))
        assertEquals(0L,LibraryReview(repo).read("1").getJSONObject("totals").getLong("added"))
        assertEquals(2,repo.versions(original.id).size)
    }

    @Test fun agentDateQueriesReturnEveryPageWithoutDependingOnDateInTitle() = withRepository { repo ->
        for(i in 1..25) repo.create(UUID.randomUUID().toString(),input("记录$i").put("title","没有日期的标题$i").put("contentDay", "2024-03-${i.toString().padStart(2, '0')}"),1)
        val query=AgentLibraryQuery(repo)
        val first=query.byDate("2024-03-01","2024-03-31")
        assertEquals(25,first.getInt("count"));assertEquals(20,first.getJSONArray("records").length())
        val second=query.byDate("2024-03-01","2024-03-31",first.getString("nextCursor").toInt())
        assertEquals(5,second.getJSONArray("records").length());assertTrue(second.isNull("nextCursor"))
        val ids=mutableSetOf<String>()
        for(page in listOf(first,second))for(i in 0 until page.getJSONArray("records").length())ids.add(page.getJSONArray("records").getJSONObject(i).getString("id"))
        assertEquals(25,ids.size)
    }

    @Test fun deletingAndRestoringKeepOriginalVersions() = withRepository { repo ->
        val created = repo.create(UUID.randomUUID().toString(), input(), 1)
        val removed = repo.remove(created.id, created.revision, UUID.randomUUID().toString())
        assertTrue(removed.deleted)
        assertTrue(repo.list().isEmpty())
        val restored = repo.update(removed.id, removed.revision, UUID.randomUUID().toString(), JSONObject().put("deleted", false))
        assertFalse(restored.deleted)
        assertEquals(created.markdown, restored.markdown)
        assertEquals(3, repo.versions(created.id).size)
    }

    @Test fun generatedRecordRequiresExplicitApprovalAndCannotImpersonatePersonalWriting() = withRepository { repo ->
        val actions=AgentRecordActions(repo)
        val proposal=actions.propose("task-fixture","conversation-fixture","create",null,
            JSONObject().put("title","AI draft").put("kind","idea").put("markdown","模型整理的想法"))
        assertEquals(0,repo.dao.recordCount())
        assertEquals("pending",proposal.getString("status"))
        val applied=actions.decide(proposal.getString("id"),"conversation-fixture",true)
        val repeated=actions.decide(proposal.getString("id"),"conversation-fixture",true)
        assertEquals(applied.getString("recordId"),repeated.getString("recordId"))
        assertEquals(1,repo.dao.recordCount())
        val saved=repo.read(applied.getString("recordId"))
        assertEquals("ai",saved.origin)
        assertEquals("ai",JSONArray(saved.sourcesJson).getJSONObject(0).getString("origin"))
        assertEquals(1,repo.dao.activities(saved.id).size)
    }

    @Test fun staleAgentSuggestionCannotOverwriteHumanChangesOrCrossConversation() = withRepository { repo ->
        val original=repo.create(UUID.randomUUID().toString(),input(),1)
        val actions=AgentRecordActions(repo)
        val proposed=actions.propose("task-fixture","conversation-a","delete",original.id,JSONObject())
        assertNotNull(runCatching { actions.decide(proposed.getString("id"),"conversation-b",true) }.exceptionOrNull())
        val edited=repo.update(original.id,original.revision,UUID.randomUUID().toString(),JSONObject().put("title","Edited by user"))
        assertNotNull(runCatching { actions.decide(proposed.getString("id"),"conversation-a",true) }.exceptionOrNull())
        assertFalse(repo.read(original.id).deleted)
        assertEquals(edited.versionId,repo.read(original.id).versionId)
        assertEquals("pending",actions.list("conversation-a").getJSONObject(0).getString("status"))
        assertEquals("rejected",actions.decide(proposed.getString("id"),"conversation-a",false).getString("status"))
    }

    @Test fun localPersonaOnlyInjectsConfirmedMemoriesAndRejectsStaleEdits() = withRepository { repo ->
        val profile=LocalAgentProfileStore(repo)
        val initial=profile.snapshot()
        val proposed=profile.propose("synthetic-task","PRIVATE_MEMORY_FIXTURE")
        assertFalse(profile.snapshot().getString("systemContext").contains("PRIVATE_MEMORY_FIXTURE"))
        assertEquals(initial.getString("revision"),profile.snapshot().getString("revision"))
        val old=profile.read()
        profile.memory(old.getLong("revision"),proposed.getString("id"),null,"accept")
        assertTrue(profile.snapshot().getString("systemContext").contains("PRIVATE_MEMORY_FIXTURE"))
        assertNotEquals(initial.getString("revision"),profile.snapshot().getString("revision"))
        assertNotNull(runCatching { profile.save(old.getLong("revision"),"stale","","") }.exceptionOrNull())
    }
}
