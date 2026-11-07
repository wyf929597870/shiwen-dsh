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

/** Focused conflict CAS/history tests; every fixture uses an isolated synthetic database. */
@RunWith(AndroidJUnit4::class)
class LibraryConflictResolutionTest {
    private fun withRepository(block: (LibraryRepository) -> Unit) {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val libraryId = UUID.randomUUID().toString()
        val registryFile = "conflict-fixture-registry-$libraryId.sqlite"
        val libraryFile = "conflict-fixture-library-$libraryId.sqlite"
        val registry = Room.databaseBuilder(context, LibraryRegistryDatabase::class.java, registryFile).build()
        val row = LibraryRegistryRow(libraryId, "Conflict fixture", UUID.randomUUID().toString(), libraryFile,
            "coordinated", "complete", UUID.randomUUID().toString(), UUID.randomUUID().toString(), 1,
            null, null, null, "0", null, 1, true, false, false, "{}")
        registry.dao().insert(row)
        val repo = LibraryRepository(context, libraryId, row.deviceId, row.name, registry, row)
        try { block(repo) }
        finally {
            repo.executor.shutdownNow(); repo.db.close(); registry.close()
            context.deleteDatabase(libraryFile); context.deleteDatabase(registryFile)
            java.io.File(context.filesDir, "libraries/$libraryId").deleteRecursively()
        }
    }

    private fun input(markdown: String, sources: JSONArray = JSONArray().put(JSONObject().put("text", markdown).put("origin", "personal"))) =
        JSONObject().put("kind", "journal").put("title", "Conflict fixture").put("markdown", markdown)
            .put("origin", "personal").put("processing", "original").put("contentDay", "2026-11-07")
            .put("dateBasis", "user-confirmed").put("sources", sources)

    private fun wire(record: LibraryRecord, versionId: String, changeId: String) = JSONObject()
        .put("id", record.id).put("kind", record.kind).put("title", record.title).put("markdown", record.markdown)
        .put("origin", record.origin).put("processing", record.processing).put("contentDay", record.contentDay ?: JSONObject.NULL)
        .put("dateBasis", record.dateBasis).put("url", record.url ?: "").put("annotation", record.annotation ?: "")
        .put("stage", record.stage ?: "draft").put("sourceIds", JSONArray(record.sourceIdsJson)).put("sources", JSONArray(record.sourcesJson))
        .put("attachmentDescriptors", JSONArray(record.attachmentDescriptorsJson)).put("createdAt", record.createdAt)
        .put("updatedAt", record.updatedAt).put("deleted", record.deleted).put("createdByDevice", record.createdByDevice ?: JSONObject.NULL)
        .put("versionId", versionId).put("changeId", changeId)

    private fun addRemoteHead(repo: LibraryRepository, row: LibraryRecord, revision: Long = 2): LibraryRemoteHead {
        val versionId = UUID.randomUUID().toString(); val changeId = UUID.randomUUID().toString()
        val json = wire(row, versionId, changeId)
        val head = LibraryRemoteHead(row.id, revision, versionId, changeId, row.deleted, json.toString(), "2026-11-07T10:00:00Z")
        repo.dao.putRemoteHead(head)
        return head
    }

    private fun conflict(repo: LibraryRepository, local: LibraryRecord, remote: LibraryRemoteHead, id: String = UUID.randomUUID().toString()): LibraryConflict {
        val remoteRecord = JSONObject(remote.recordJson)
        val remoteSources = remoteRecord.optJSONArray("sources") ?: JSONArray()
        val localSnapshot = JSONObject().put("record", wire(local, local.versionId, local.changeId))
            .put("version", repo.dao.versions(local.id).firstOrNull { it.id == local.versionId }?.docJson?.let(::JSONObject) ?: JSONObject.NULL)
        return LibraryConflict(id, local.id, UUID.randomUUID().toString(), "{}", localSnapshot.toString(),
            remoteRecord.put("currentVersion", JSONObject().put("id", remote.versionId)
                .put("recordId", local.id).put("revision", remote.revision).put("markdown", remoteRecord.optString("markdown"))
                .put("title", remoteRecord.optString("title")).put("createdAt", "2026-11-07T10:00:00Z").put("reason", "update")
                .put("doc", JSONObject(remote.recordJson)).put("sources", JSONArray(remoteSources.toString()))
                .put("parentVersionIds", JSONArray())).toString(), remote.revision, "open", "2026-11-07T10:00:00Z")
            .also(repo.dao::putConflict)
    }

    @Test fun keepLocalRebasesAgainstExactRemoteHeadAndPreservesLocalHistory() = withRepository { repo ->
        val created = repo.create(UUID.randomUUID().toString(), input("初稿"), 1)
        val local = repo.update(created.id, created.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "本机保留的正文"))
        val remoteRecord = local.copy(title = "服务器标题", markdown = "服务器已经有的正文", origin = "external",
            sourcesJson = JSONArray().put(JSONObject().put("text", "服务器已经有的正文").put("origin", "external")).toString())
        val remote = addRemoteHead(repo, remoteRecord)
        val conflict = conflict(repo, local, remote)
        val priorVersions = repo.versions(local.id).map { it.id }.toSet()

        val merged = repo.update(local.id, local.revision, UUID.randomUUID().toString(),
            JSONObject().put("title", local.title).put("markdown", local.markdown).put("sources", JSONArray(local.sourcesJson)),
            remote, "resolve", conflict.id)

        assertEquals(local.markdown, merged.markdown)
        assertEquals("pending", merged.syncState)
        assertEquals("resolved-local", repo.dao.conflict(conflict.id)!!.state)
        assertTrue(repo.versions(local.id).map { it.id }.containsAll(priorVersions))
        val resolutionOperation = repo.dao.allOutbox().single { it.versionId == merged.versionId }
        assertEquals(remote.versionId, resolutionOperation.baseVersionId)
        assertEquals(remote.revision, resolutionOperation.baseRevision)
        val parents = JSONObject(resolutionOperation.payloadJson).getJSONArray("parentVersionIds")
        assertEquals(1, parents.length()); assertEquals(remote.versionId, parents.getString(0))
        val activity = repo.dao.activities(local.id).first { it.changeId == merged.changeId }
        assertEquals("resolve", activity.action); assertEquals(0, activity.added); assertEquals(0, activity.removed)
    }

    @Test fun mergeUsesWritingDeltaToKeepUnchangedAIAndExternalSegments() = withRepository { repo ->
        val oldText = "个人开头。AI观点。外部结尾。"
        val sources = JSONArray()
            .put(JSONObject().put("text", "个人开头。").put("origin", "personal"))
            .put(JSONObject().put("text", "AI观点。").put("origin", "ai").put("sourceRef", "conversation:source"))
            .put(JSONObject().put("text", "外部结尾。").put("origin", "external").put("sourceRef", "article:source"))
        val created = repo.create(UUID.randomUUID().toString(), input(oldText, sources), 1)
        val local = repo.update(created.id, created.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "本机改写。AI观点。外部结尾。"))
        val remote = addRemoteHead(repo, local.copy(title = "远端版本"))
        val conflict = conflict(repo, local, remote)
        val mergedText = "本机改写。AI观点。补充结尾。"

        val merged = repo.update(local.id, local.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", mergedText),
            remote, "resolve", conflict.id)

        val finalSources = JSONArray(merged.sourcesJson)
        assertEquals(mergedText, (0 until finalSources.length()).joinToString("") { finalSources.getJSONObject(it).getString("text") })
        assertTrue((0 until finalSources.length()).any { i ->
            val segment = finalSources.getJSONObject(i)
            segment.optString("origin") == "ai" && segment.optString("sourceRef") == "conversation:source"
        })
        assertFalse((0 until finalSources.length()).any { finalSources.getJSONObject(it).optString("origin") == "personal" &&
            finalSources.getJSONObject(it).getString("text") == "AI观点。" })
        assertEquals("resolved-local", repo.dao.conflict(conflict.id)!!.state)
    }

    @Test fun keepRemoteChangesCurrentRecordButRetainsLocalVersionsAndConfirmsCAS() = withRepository { repo ->
        val created = repo.create(UUID.randomUUID().toString(), input("原稿"), 1)
        val local = repo.update(created.id, created.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "本地分支"))
        val remoteRecord = local.copy(title = "远端定稿", markdown = "远端正文", origin = "external",
            sourcesJson = JSONArray().put(JSONObject().put("text", "远端正文").put("origin", "external")).toString())
        val remote = addRemoteHead(repo, remoteRecord)
        val conflict = conflict(repo, local, remote)
        val oldVersionIds = repo.versions(local.id).map { it.id }.toSet()

        assertNotNull(runCatching { repo.resolveConflictRemote(conflict.id, remote.revision - 1, UUID.randomUUID().toString()) }.exceptionOrNull())
        assertEquals("open", repo.dao.conflict(conflict.id)!!.state)
        val resultId = UUID.randomUUID().toString()
        val accepted = repo.resolveConflictRemote(conflict.id, remote.revision, resultId)
        val replay = repo.resolveConflictRemote(conflict.id, remote.revision, resultId)

        assertEquals("远端正文", accepted.markdown)
        assertEquals(remoteRecord.sourcesJson, accepted.sourcesJson)
        assertEquals(accepted.versionId, replay.versionId)
        assertTrue(repo.versions(local.id).map { it.id }.containsAll(oldVersionIds))
        assertTrue(repo.versions(local.id).any { it.id == remote.versionId && it.markdown == "远端正文" })
        assertEquals("resolved-remote", repo.dao.conflict(conflict.id)!!.state)
        assertTrue(repo.dao.pendingOutbox(100).none { it.recordId == local.id })
        assertTrue(repo.dao.allOutbox().filter { it.recordId == local.id }.all {
            it.state == "rejected" && it.lastError == "CONFLICT_DISCARDED"
        })
        val activity = repo.dao.activities(local.id).first { it.action == "resolve" }
        assertEquals(0, activity.added); assertEquals(0, activity.removed)
    }

    @Test fun sameRevisionDifferentChangeIdIsAStaleCASConflict() = withRepository { repo ->
        val created = repo.create(UUID.randomUUID().toString(), input("起点"), 1)
        val local = repo.update(created.id, created.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "本地"))
        val remote = addRemoteHead(repo, local.copy(markdown = "远端"), 2)
        val stale = remote.copy(versionId = UUID.randomUUID().toString(), changeId = UUID.randomUUID().toString())
        repo.dao.putRemoteHead(stale)
        val conflict = conflict(repo, local, remote)
        val before = repo.read(local.id)

        val error = runCatching {
            repo.update(local.id, local.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "错误合并"),
                remote, "resolve", conflict.id)
        }.exceptionOrNull()

        assertEquals("CONFLICT_HEAD_CHANGED", error?.message)
        assertEquals(before.markdown, repo.read(local.id).markdown)
        assertEquals("open", repo.dao.conflict(conflict.id)!!.state)
    }
}
