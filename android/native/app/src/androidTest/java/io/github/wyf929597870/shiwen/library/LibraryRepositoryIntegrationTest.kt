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

    @Test fun linkingMaterialsFiltersBeforePagingAndKeepsExistingQueries() = withRepository { repo ->
        repeat(103) { index ->
            repo.create(UUID.randomUUID().toString(), input().put("title", "Article $index").put("kind", "article").put("contentDay", "2025-03-01"), 1)
        }
        repeat(102) { index ->
            repo.create(UUID.randomUUID().toString(), input().put("title", "Material $index"), 1)
        }
        assertTrue(repo.list(limit = 100).all { it.kind == "article" })
        val first = repo.list(limit = 100, excludeKind = "article")
        val second = repo.list(limit = 100, offset = 100, excludeKind = "article")
        assertEquals(100, first.size)
        assertEquals(2, second.size)
        assertTrue((first + second).all { it.kind == "journal" && !it.deleted })
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
        for(i in 1..25) repo.create(UUID.randomUUID().toString(),input("记录$i").put("title","没有日期的标题$i"),1)
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
