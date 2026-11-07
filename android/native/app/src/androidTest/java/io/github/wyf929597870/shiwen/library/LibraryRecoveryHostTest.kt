package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.content.ContextWrapper
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.wyf929597870.shiwen.network.NodeConnection
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LibraryRecoveryHostTest {
    @get:org.junit.Rule val foreground = ForegroundIntegrationRule()
    @Test fun phoneFirstLibraryInitializesEmptyRealServiceWithoutChangingIdentityOrHistory() {
        val args = InstrumentationRegistry.getArguments()
        val host = args.getString("syntheticRecoveryHost"); val password = args.getString("syntheticPassword")
        assumeTrue(!host.isNullOrBlank() && !password.isNullOrBlank())
        require(java.net.URI(host!!).host == "127.0.0.1")
        val context = ApplicationProvider.getApplicationContext<Context>(); val suffix = UUID.randomUUID().toString()
        val nodes = NodeSettingsStore(context, "recovery-host-node-$suffix")
        val manager = LibraryManager(context, "recovery-host-registry-$suffix", "recovery-host-legacy-$suffix")
        val sync = LibrarySyncCoordinator(context, manager, nodes)
        val recovery = LibraryRecoveryCoordinator(context, manager, nodes, sync)
        try {
            val repo = manager.create("Phone first fixture")
            val libraryId = repo.libraryId; val deviceId = repo.deviceId
            val first = repo.create(UUID.randomUUID().toString(),JSONObject().put("kind","journal").put("origin","personal")
                .put("processing","original").put("contentDay","2024-04-01").put("title","Phone-first journal").put("markdown","第一版"),1)
            manager.update(manager.row(libraryId).copy(role = "coordinated", integrity = "complete",
                serverId = UUID.randomUUID().toString(), epoch = UUID.randomUUID().toString()))
            val second = repo.update(first.id,first.revision,UUID.randomUUID().toString(),JSONObject().put("markdown","第一版\n第二版"))
            repo.update(second.id,second.revision,UUID.randomUUID().toString(),JSONObject().put("markdown","第一版\n第二版\n第三版"))
            val bytes = "# Original attachment\n完整保留原件".toByteArray()
            val imported = repo.importMarkdown(UUID.randomUUID().toString(),"Phone-first original",bytes.decodeToString(),
                JSONObject().put("kind","reference").put("origin","external").put("processing","original"),"original.md",bytes,"import")
            val frozenOutboxIds = repo.dao.pendingOutbox(100_000).map { it.operationId }.toSet()
            assertTrue("Fixture must contain coordinated writes before initialize", frozenOutboxIds.isNotEmpty())
            val historyIds = repo.dao.allVersions().map { it.id }.toSet()
            val activityIds = repo.dao.allActivities().map { it.activityId }.toSet()
            val node = nodes.save(null,"Empty synthetic service",host,true)
            val nodeId = node.getString("id"); val configRevision = node.getString("configRevision")
            NodeConnection(nodes).refresh(nodeId,password)
            val inspected = recovery.inspect(libraryId,nodeId,configRevision)
            assertTrue(inspected.getJSONObject("target").getBoolean("isEmpty"))
            val task = recovery.start(libraryId,nodeId,configRevision,"initialize",inspected.getJSONObject("target"))
            val deadline = System.nanoTime()+90_000_000_000L
            var completed = false
            var lastProgress = JSONObject()
            while(System.nanoTime()<deadline) {
                lastProgress = recovery.progress(libraryId,nodeId,configRevision,task.getString("taskId"))
                if(lastProgress.optString("state")=="completed") { completed=true;break }
                if(lastProgress.optString("state")=="needsReview" || lastProgress.optString("localAlignment")=="needs-review")
                    fail("Initialization needs review: ${safeProgress(lastProgress)}; ${bootstrapConflictFields(repo)}")
                if(lastProgress.optString("state") in setOf("failed","error","blocked"))fail("Recovery failed: ${safeProgress(lastProgress)}")
                Thread.sleep(100)
            }
            assertTrue("Initialization did not complete: ${safeProgress(lastProgress)}",completed)
            assertEquals("complete", lastProgress.optString("localAlignment"))
            assertEquals("No false conflicts after snapshot bootstrap: ${safeProgress(lastProgress)}; ${bootstrapConflictFields(repo)}", 0,
                lastProgress.optInt("conflictCount", 0))
            assertEquals(libraryId,repo.libraryId);assertEquals(deviceId,repo.deviceId)
            assertEquals("coordinated",manager.row(libraryId).role);assertEquals("complete",manager.row(libraryId).integrity)
            val covered = repo.dao.allOutbox().filter { it.state == "snapshot-covered" }.map { it.operationId }.toSet()
            assertEquals("Only operations frozen into the committed initialize snapshot are covered", frozenOutboxIds, covered)
            assertTrue(repo.dao.allOutbox().isNotEmpty())
            assertEquals(0, repo.dao.pendingOutbox(100_000).size)
            val taskMetaBeforeRead = repo.dao.meta("mobile-recovery-task-v2")
            val observed = recovery.progress(libraryId, nodeId, configRevision, task.getString("taskId"))
            assertEquals("completed", observed.optString("state"))
            assertEquals(taskMetaBeforeRead, repo.dao.meta("mobile-recovery-task-v2"))
            assertEquals(historyIds,repo.dao.allVersions().map { it.id }.toSet())
            assertEquals(activityIds,repo.dao.allActivities().map { it.activityId }.toSet())
            assertEquals("第一版\n第二版\n第三版",repo.read(first.id).markdown)
            val attachmentId = JSONArray(imported.attachmentDescriptorsJson).getJSONObject(0).getString("id")
            assertArrayEquals(bytes,repo.attachmentBytes(attachmentId))

            // A post-recovery child may use the final version whose older outbox row
            // is covered by the initialize snapshot. It must rebase against the
            // matching remote head instead of treating that parent as unconfirmed.
            val coveredParentVersion = repo.read(first.id).versionId
            assertEquals("snapshot-covered", repo.dao.outboxByVersionId(coveredParentVersion)?.state)
            val continued = repo.update(first.id, repo.read(first.id).revision, UUID.randomUUID().toString(),
                JSONObject().put("markdown", "第一版\n第二版\n第三版\n恢复后继续写"))
            val continuedOperation = repo.dao.outboxByVersionId(continued.versionId)
            assertEquals(coveredParentVersion, continuedOperation?.baseVersionId)
            val continuedSync = sync.syncNow(libraryId, "manual")
            awaitSync(sync, libraryId, continuedSync.getString("operationId"))
            assertEquals(0, repo.dao.pendingOutbox(100).size)
            assertEquals(continued.markdown, remoteRecord(nodes, nodeId, configRevision, libraryId,
                checkNotNull(manager.row(libraryId).epoch), deviceId, first.id).getString("markdown"))

            val identity = NodeConnection(nodes).mobileSync(nodeId,"identity",JSONObject().put("protocolVersion","1.0.0-draft.2")
                .put("deviceId",deviceId),configRevision).getJSONObject("data")
            assertEquals(libraryId,identity.getString("libraryId"))

            // The isolated Host started empty, standing in for a lost coordinator.
            // A second Android replica must bootstrap the rebuilt library, add an
            // offline edit, push it, and let the original replica converge.
            val replicaContext = IsolatedStorageContext(context, "recovery-replica-$suffix")
            val replicaNodes = NodeSettingsStore(replicaContext, "recovery-host-replica-node-$suffix")
            val replicaManager = LibraryManager(replicaContext, "recovery-host-replica-registry-$suffix",
                "recovery-host-replica-legacy-$suffix")
            val replicaSync = LibrarySyncCoordinator(replicaContext, replicaManager, replicaNodes)
            try {
                val replicaNode = replicaNodes.save(null, "Rebuilt synthetic service", host, true)
                val replicaNodeId = replicaNode.getString("id"); val replicaRevision = replicaNode.getString("configRevision")
                NodeConnection(replicaNodes).refresh(replicaNodeId, password)
                val joined = replicaSync.connect(replicaNodeId)
                assertEquals(libraryId, joined.getString("libraryId"))
                awaitSync(replicaSync, libraryId, joined.getString("operationId"))

                val replica = replicaManager.openLibrary(libraryId)
                assertNotEquals("Replicas must use separate device identities", deviceId, replica.deviceId)
                assertEquals("第一版\n第二版\n第三版\n恢复后继续写", replica.read(first.id).markdown)
                assertArrayEquals(bytes, replica.attachmentBytes(attachmentId))
                val edited = replica.update(first.id, replica.read(first.id).revision, UUID.randomUUID().toString(),
                    JSONObject().put("markdown", "第一版\n第二版\n第三版\n恢复后继续写\n来自另一副本"))
                val pushed = replicaSync.syncNow(libraryId, "manual")
                awaitSync(replicaSync, libraryId, pushed.getString("operationId"))
                val replicaStatus = replicaSync.status(libraryId)
                assertEquals("Replica outbox was not fully applied: ${safeProgress(replicaStatus)}", 0,
                    replicaStatus.optInt("pendingCount", -1))
                assertEquals("Replica write was rejected: ${safeProgress(replicaStatus)}", 0,
                    replicaStatus.optInt("rejectedCount", -1))
                val serverRecord = remoteRecord(replicaNodes, replicaNodeId, replicaRevision, libraryId,
                    checkNotNull(replicaManager.row(libraryId).epoch), replica.deviceId, first.id)
                assertEquals("Replica push did not reach rebuilt Host", edited.markdown,
                    serverRecord.getString("markdown"))

                val pulled = sync.syncNow(libraryId, "manual")
                awaitSync(sync, libraryId, pulled.getString("operationId"))
                assertEquals(edited.markdown, repo.read(first.id).markdown)
                assertEquals(edited.markdown, replica.read(first.id).markdown)
                assertEquals(6, repo.dao.allVersions().size)
                assertEquals(6, repo.dao.allActivities().size)
                assertEquals(0, replica.dao.pendingOutbox(100).size)
                val rebuiltIdentity = NodeConnection(nodes).mobileSync(nodeId, "identity",
                    JSONObject().put("protocolVersion", "1.0.0-draft.2").put("deviceId", deviceId), configRevision)
                    .getJSONObject("data")
                assertEquals(libraryId, rebuiltIdentity.getString("libraryId"))
            } finally {
                replicaSync.closeForTest(); replicaManager.closeForTest(); replicaNodes.clearForTest(); replicaContext.cleanup()
            }
        } finally { recovery.close();sync.closeForTest();manager.closeForTest();nodes.clearForTest() }
    }

    private fun awaitSync(sync: LibrarySyncCoordinator, libraryId: String, operationId: String): JSONObject {
        val deadline = System.nanoTime() + 90_000_000_000L
        var progress = JSONObject()
        while (System.nanoTime() < deadline) {
            progress = sync.progress(libraryId, operationId)
            if (progress.optString("state") == "completed") return progress
            if (progress.optString("state") == "needsReview" || progress.optString("localAlignment") == "needs-review")
                throw AssertionError("Replica sync needs review: ${safeProgress(progress)}")
            if (progress.optString("state") in setOf("failed", "error", "blocked"))
                throw AssertionError("Replica sync failed: ${safeProgress(progress)}")
            Thread.sleep(100)
        }
        throw AssertionError("Replica sync timed out: ${safeProgress(progress)}")
    }

    private fun remoteRecord(nodes: NodeSettingsStore, nodeId: String, revision: String, libraryId: String,
        epoch: String, deviceId: String, recordId: String): JSONObject {
        val connection = NodeConnection(nodes)
        val snapshot = connection.mobileSync(nodeId, "bootstrapBegin", JSONObject().put("libraryId", libraryId)
            .put("epoch", epoch).put("deviceId", deviceId), revision).getJSONObject("data")
        val page = connection.mobileSync(nodeId, "bootstrapPage", JSONObject().put("libraryId", libraryId).put("epoch", epoch).put("deviceId", deviceId).put("snapshotId", snapshot.getString("snapshotId"))
            .put("entityType", "records").put("limit", 100), revision).getJSONObject("data").getJSONArray("items")
        for (index in 0 until page.length()) {
            val item = page.getJSONObject(index)
            if (item.optString("id") == recordId) return JSONObject(item.toString())
        }
        throw AssertionError("Record missing from server bootstrap snapshot")
    }

    /** Safe diagnostics: show only conflict phase and differing record field names, never values. */
    private fun bootstrapConflictFields(repo: LibraryRepository): String {
        val fields = listOf("id", "title", "markdown", "kind", "origin", "processing", "contentDay", "dateBasis",
            "deleted", "sourceIds", "sources")
        val conflicts = repo.dao.allConflicts().filter { it.operationId in setOf("bootstrap", "bootstrap-head") }
        if (conflicts.isEmpty()) return "bootstrapConflicts=none"
        return conflicts.joinToString(prefix = "bootstrapConflicts=[", postfix = "]") { conflict ->
            val local = runCatching { JSONObject(conflict.localJson) }.getOrDefault(JSONObject())
            val remote = runCatching { JSONObject(conflict.remoteJson) }.getOrDefault(JSONObject())
            val different = fields.filter { key ->
                if (key == "sourceIds" || key == "sources") {
                    val left = local.optJSONArray(key)?.toString() ?: "[]"
                    val right = remote.optJSONArray(key)?.toString() ?: "[]"
                    !canonicalJsonArrayEquals(left, right)
                } else local.opt(key)?.toString() != remote.opt(key)?.toString()
            }
            val basis = if ("dateBasis" in different)
                "(dateBasis=${local.optString("dateBasis", "<missing>")}->${remote.optString("dateBasis", "<missing>")})" else ""
            "${conflict.operationId}:${different.joinToString(",").ifEmpty { "unknown" }}$basis"
        }
    }

    /** Include only bounded state/progress/error codes so failures never print document content. */
    private fun safeProgress(value: JSONObject): JSONObject {
        val local = value.optJSONObject("localSync")
        val result = JSONObject()
        for (key in listOf("state", "phase", "completed", "total", "pendingCount", "rejectedCount", "conflictCount", "localAlignment", "localAlignmentError",
            "remoteKind", "serverTaskId", "error", "errorCode", "remoteCommitStatus")) {
            value.opt(key)?.takeIf { it != JSONObject.NULL }?.let { result.put(key, it.toString().take(160)) }
        }
        local?.let {
            result.put("localState", it.optString("state")).put("localPhase", it.optString("phase"))
            it.optString("error").takeIf { code -> code.isNotBlank() }?.let { code -> result.put("localError", code.take(160)) }
        }
        return result
    }
}

/** Separate files and Room databases to model another Android installation. */
private class IsolatedStorageContext(base: Context, name: String) : ContextWrapper(base) {
    private val root = java.io.File(base.cacheDir, "shiwen-$name").apply { mkdirs() }

    override fun getApplicationContext(): Context = this
    override fun getFilesDir(): java.io.File = java.io.File(root, "files").apply { mkdirs() }
    override fun getCacheDir(): java.io.File = java.io.File(root, "cache").apply { mkdirs() }
    override fun getDatabasePath(name: String): java.io.File = java.io.File(java.io.File(root, "databases").apply { mkdirs() }, name)
    override fun databaseList(): Array<String> = java.io.File(root, "databases").list() ?: emptyArray()
    override fun openOrCreateDatabase(name: String, mode: Int, factory: SQLiteDatabase.CursorFactory?): SQLiteDatabase =
        SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name), factory)
    override fun openOrCreateDatabase(name: String, mode: Int, factory: SQLiteDatabase.CursorFactory?,
        errorHandler: DatabaseErrorHandler?): SQLiteDatabase = openOrCreateDatabase(name, mode, factory)
    override fun deleteDatabase(name: String): Boolean {
        val file = getDatabasePath(name)
        return file.delete() and java.io.File(file.path + "-journal").delete() and
            java.io.File(file.path + "-wal").delete() and java.io.File(file.path + "-shm").delete()
    }
    fun cleanup() { root.deleteRecursively() }
}
