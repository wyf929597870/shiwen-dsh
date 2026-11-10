package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LibraryIncrementalIdentityTest {
    @Test fun editingAnIncrementallyReceivedRecordUsesTheEventVersion() = withReplica { repo, sync ->
        val event = event()
        sync.applyChange(repo, event)
        val record = repo.read(event.getJSONObject("record").getString("id"))
        assertEquals(event.getString("versionId"), record.versionId)
        assertEquals(event.getString("changeId"), record.changeId)
        val updated = repo.update(record.id, record.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "手机修改"))
        val operation = repo.dao.outboxByVersionId(updated.versionId)!!
        assertEquals(event.getString("versionId"), operation.baseVersionId)
        assertEquals(8L, operation.baseRevision)
        assertEquals(event.getString("versionId"), JSONObject(operation.payloadJson).getJSONArray("parentVersionIds").getString(0))
    }

    @Test fun oldUnsentEmptyParentIsRepairedOnlyWhenItsBaselineIsProven() = withReplica { repo, sync ->
        val event = event()
        sync.applyChange(repo, event)
        val record = repo.read(event.getJSONObject("record").getString("id"))
        // Reproduce the old reader, which discarded envelope identity before an edit.
        repo.dao.updateRecord(record.copy(versionId = "", changeId = ""))
        val edit = repo.update(record.id, record.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "未上传的手机修改"))
        val pending = repo.dao.outboxByVersionId(edit.versionId)!!.copy(state = "blocked-dependency", lastError = "PARENT_NOT_CONFIRMED")
        repo.dao.updateOutbox(pending)
        assertEquals("", pending.baseVersionId)

        val sent = pending.copy(attempts = 1)
        assertEquals(sent, sync.repairMissingBaseVersion(repo, sent))
        val head = repo.dao.remoteHead(record.id)!!
        repo.dao.putRemoteHead(head.copy(revision = 9))
        assertEquals(pending, sync.repairMissingBaseVersion(repo, pending))
        repo.dao.putRemoteHead(head.copy(recordJson = JSONObject(head.recordJson).put("markdown", "不同基线").toString()))
        assertEquals(pending, sync.repairMissingBaseVersion(repo, pending))
        repo.dao.putRemoteHead(head)

        val repaired = sync.repairMissingBaseVersion(repo, pending)
        assertEquals("pending", repaired.state)
        assertEquals(head.versionId, repaired.baseVersionId)
        assertEquals(pending.operationId, repaired.operationId)
        assertEquals(pending.versionId, repaired.versionId)
        assertEquals(pending.changeId, repaired.changeId)
        assertEquals(0, repaired.attempts)
        assertEquals("未上传的手机修改", repo.read(record.id).markdown)
        assertEquals(head.versionId, repo.read(record.id).baseVersionId)
        assertEquals(head.versionId, JSONArray(repo.dao.versions(record.id).first { it.id == edit.versionId }.parentVersionIdsJson).getString(0))
        assertEquals(repaired, sync.repairMissingBaseVersion(repo, repaired))
    }

    private fun event(): JSONObject {
        val id = UUID.randomUUID().toString()
        val version = UUID.randomUUID().toString()
        val change = UUID.randomUUID().toString()
        val sources = JSONArray().put(JSONObject().put("text", "电脑内容").put("origin", "personal"))
        val record = JSONObject().put("id", id).put("kind", "idea").put("title", "Identity fixture")
            .put("markdown", "电脑内容").put("sources", sources).put("origin", "personal").put("processing", "original")
            .put("createdAt", "2026-11-09T00:00:00Z").put("updatedAt", "2026-11-09T00:00:00Z")
        return JSONObject().put("record", record).put("revision", 8).put("versionId", version).put("changeId", change)
            .put("version", JSONObject().put("id", version).put("recordId", id).put("revision", 8)
                .put("changeId", change).put("markdown", "电脑内容").put("sources", sources).put("doc", record))
    }

    private fun withReplica(block: (LibraryRepository, LibrarySyncCoordinator) -> Unit) {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "incremental-identity-${UUID.randomUUID()}"
        val libraryId = UUID.randomUUID().toString()
        val manager = LibraryManager(context, namespace, "$namespace-legacy")
        val nodes = NodeSettingsStore(context, "$namespace-nodes")
        val sync = LibrarySyncCoordinator(context, manager, nodes)
        try {
            manager.attachRemote(libraryId, UUID.randomUUID().toString(), UUID.randomUUID().toString(), 1, "fixture", "fixture", "Fixture")
            manager.update(manager.row(libraryId).copy(integrity = "complete"))
            block(manager.openLibrary(libraryId), sync)
        } finally {
            sync.closeForTest()
            manager.closeForTest()
            nodes.clearForTest()
            File(context.filesDir, "libraries/$libraryId").deleteRecursively()
        }
    }
}
