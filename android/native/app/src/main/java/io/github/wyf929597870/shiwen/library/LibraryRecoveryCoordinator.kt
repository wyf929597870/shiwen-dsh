package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.util.Base64
import io.github.wyf929597870.shiwen.model.Canonical
import io.github.wyf929597870.shiwen.network.NodeConnection
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors

/** Durable, owner-authenticated recovery over the fixed mobileSync protocol. */
internal class LibraryRecoveryCoordinator(context: Context, private val manager: LibraryManager,
    private val nodes: NodeSettingsStore, private val syncCoordinator: LibrarySyncCoordinator) {
    private val app = context.applicationContext
    private val executor = Executors.newSingleThreadExecutor()
    private val running = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val connection get() = NodeConnection(nodes)

    init {
        executor.execute {
            for (row in manager.all()) {
                val repo = manager.openLibrary(row.libraryId)
                task(repo)?.let { resumeIfNeeded(repo, it) }
            }
        }
    }

    fun inspect(libraryId: String, nodeId: String, configRevision: String): JSONObject {
        val repo = manager.openLibrary(libraryId)
        val source = sourceIdentity(repo)
        val target = targetIdentity(nodeId, configRevision, repo.deviceId)
        val targetSnapshot = rpc(nodeId, configRevision, "bootstrapBegin", JSONObject().put("libraryId", target.getString("libraryId"))
            .put("epoch", target.getString("epoch")).put("deviceId", repo.deviceId))
        val targetManifest = targetSnapshot.getJSONObject("manifest")
        val targetRecords = targetManifest.getJSONObject("counts").optInt("records", -1)
        check(targetRecords >= 0) { "RECOVERY_TARGET_COUNT_MISSING" }
        val archive = repo.archiveSnapshot()
        val sourceCount = archive.getJSONArray("records").length()
        val sourceVersions = archive.getJSONArray("versions").length()
        val sourceActivities = archive.getJSONArray("activities").length()
        val sourceLinks = archive.getJSONArray("links").length()
        val sourceBranches = archive.getJSONArray("branches").length()
        val sourceAttachments = arr(archive, "attachments")
        val sourceBranchAttachments = arr(archive, "branchAttachments")
        var missingAttachments = 0
        for (item in sourceAttachments) if (runCatching {
                val bytes = repo.attachmentBytes(item.getString("id")); bytes.size.toLong() == item.getLong("byteLength") && sha256(bytes) == item.getString("hash")
            }.getOrDefault(false).not()) missingAttachments++
        for (item in sourceBranchAttachments) if (runCatching {
                val bytes = repo.branchAttachmentBytes(item.getString("branchId"), item.getString("attachmentId"));
                bytes.size.toLong() == item.getLong("byteLength") && sha256(bytes) == item.getString("hash")
            }.getOrDefault(false).not()) missingAttachments++
        val sourceIntegrity = if (repo.registryItem().integrity == "complete" && missingAttachments == 0) "complete" else "incomplete"
        val modes = JSONArray()
        if (targetRecords == 0) modes.put("initialize")
        if (source.getString("libraryId") == target.getString("libraryId")) {
            modes.put("coordinator-recovery")
            modes.put("device-restore")
        }
        val active = task(repo)
        val targetDto = JSONObject().put("serverId", target.getString("serverId"))
            .put("libraryId", target.getString("libraryId")).put("epoch", target.getString("epoch"))
            .put("targetGeneration", target.optLong("targetGeneration")).put("revision", target.optLong("revision"))
            .put("configRevision", configRevision).put("recordCount", targetRecords).put("isEmpty", targetRecords == 0)
            .put("integrity", "complete")
        val sourceDto = JSONObject().put("serverId", source.getString("serverId")).put("libraryId", source.getString("libraryId"))
            .put("epoch", source.getString("epoch")).put("deviceId", source.getString("deviceId"))
            .put("recordCount", sourceCount).put("integrity", sourceIntegrity)
            .put("counts", JSONObject().put("records", sourceCount).put("versions", sourceVersions)
                .put("activities", sourceActivities).put("links", sourceLinks)
                .put("attachments", sourceAttachments.size + sourceBranchAttachments.size).put("branches", sourceBranches))
            .put("missingAttachments", missingAttachments)
            .put("pendingOperationCount", repo.dao.pendingOutbox(100_000).size)
        return JSONObject().put("libraryId", libraryId).put("nodeId", nodeId).put("configRevision", configRevision)
            .put("target", targetDto).put("source", sourceDto).put("allowedModes", modes)
            .put("activeTask", active?.let { publicTask(it) } ?: JSONObject.NULL)
    }

    fun start(libraryId: String, nodeId: String, configRevision: String, mode: String, expectedTarget: JSONObject): JSONObject {
        require(mode in MODES) { "RECOVERY_MODE_INVALID" }
        val repo = manager.openLibrary(libraryId)
        task(repo)?.let { old ->
            if (old.optString("state") in ACTIVE_STATES) {
                resumeIfNeeded(repo, old)
                return publicTask(old)
            }
        }
        val target = targetIdentity(nodeId, configRevision, repo.deviceId)
        check(targetMatches(expectedTarget, target, configRevision)) { "RECOVERY_TARGET_CHANGED" }
        check(mode != "initialize" || expectedTarget.optBoolean("isEmpty")) { "RECOVERY_TARGET_NOT_EMPTY" }
        check(mode == "initialize" || target.optString("libraryId") == libraryId) { "RECOVERY_LIBRARY_MISMATCH" }
        val taskId = UUID.randomUUID().toString()
        val file = snapshotFile(libraryId, taskId)
        val current = JSONObject().put("taskId", taskId).put("libraryId", libraryId).put("nodeId", nodeId)
            .put("configRevision", configRevision).put("mode", mode).put("state", "queued")
            .put("phase", "freeze").put("snapshotFile", file.absolutePath).put("target", target)
            .put("createdAt", Instant.now().toString()).put("completed", 0).put("total", JSONObject.NULL)
        saveTask(repo, current)
        launch(repo, current)
        return publicTask(current)
    }

    fun progress(libraryId: String, nodeId: String, configRevision: String, taskId: String): JSONObject {
        val repo = manager.openLibrary(libraryId)
        val current = requireTask(repo, taskId, nodeId, configRevision)
        val alignment = current.optString("localAlignment")
        if (alignment in setOf("complete", "needs-review", "failed")) {
            val result = publicTask(current).put("state", recoveryState(alignment, current.optString("state")))
            val localOperationId = current.optString("localSyncOperationId")
            if (localOperationId.isNotBlank()) result.put("localSync", syncCoordinator.progress(libraryId, localOperationId))
            if (current.optString("localAlignmentError").isNotBlank()) result.put("localAlignmentError", current.optString("localAlignmentError"))
            return result
        }
        val serverId = current.optString("serverTaskId")
        if (serverId.isBlank() || current.optString("remoteKind") !in setOf("setup", "reconcile")) return publicTask(current)
        val action = if (current.optString("remoteKind") == "setup") "setupStatus" else "reconcileStatus"
        val remote = rpc(nodeId, configRevision, action, remoteTaskRequest(repo, current))
        val result = decorateProgress(current, remote)
        val localOperationId = current.optString("localSyncOperationId")
        if (localOperationId.isNotBlank()) {
            val local = syncCoordinator.progress(libraryId, localOperationId)
            val currentAlignment = current.optString("localAlignment", "syncing")
            result.put("localSync", local).put("localAlignment", currentAlignment)
            if (current.optString("localAlignmentError").isNotBlank()) result.put("localAlignmentError", current.optString("localAlignmentError"))
            result.put("state", recoveryState(currentAlignment, result.optString("state")))
        }
        return result
    }

    fun candidates(libraryId: String, nodeId: String, configRevision: String, taskId: String,
        cursor: Int, limit: Int): JSONObject {
        require(cursor >= 0 && limit in 1..100) { "RECOVERY_PAGE_INVALID" }
        val repo = manager.openLibrary(libraryId); val current = requireTask(repo, taskId, nodeId, configRevision)
        check(current.optString("remoteKind") == "reconcile") { "RECOVERY_TASK_NOT_RECONCILE" }
        return rpc(nodeId, configRevision, "reconcileCandidates", remoteTaskRequest(repo, current)
            .put("cursor", cursor).put("limit", limit))
    }

    fun branchRead(libraryId: String, nodeId: String, configRevision: String, taskId: String, branchId: String): JSONObject {
        UUID.fromString(branchId)
        val repo = manager.openLibrary(libraryId); val current = requireTask(repo, taskId, nodeId, configRevision)
        check(current.optString("remoteKind") == "reconcile") { "RECOVERY_TASK_NOT_RECONCILE" }
        val response = rpc(nodeId, configRevision, "reconcileBranchRead", remoteTaskRequest(repo, current).put("branchId", branchId))
        val reference = response.optJSONObject("branchRef") ?: return response
        return downloadPayload(nodeId, configRevision, repo, current, reference)
    }

    fun decide(libraryId: String, nodeId: String, configRevision: String, taskId: String, branchId: String,
        resolution: String, expectedTargetHead: JSONObject?, resolutionId: String = UUID.randomUUID().toString()): JSONObject {
        require(resolution in RESOLUTIONS) { "RECOVERY_RESOLUTION_INVALID" }
        UUID.fromString(branchId); UUID.fromString(resolutionId)
        val repo = manager.openLibrary(libraryId); val current = requireTask(repo, taskId, nodeId, configRevision)
        check(current.optString("remoteKind") == "reconcile") { "RECOVERY_TASK_NOT_RECONCILE" }
        val response = rpc(nodeId, configRevision, "reconcileDecide", remoteTaskRequest(repo, current)
            .put("branchId", branchId).put("resolution", resolution).put("resolutionId", resolutionId)
            .put("expectedTargetHead", expectedTargetHead ?: JSONObject.NULL))
        current.put("state", "awaiting-decisions").put("phase", "deciding").put("updatedAt", Instant.now().toString())
        saveTask(repo, current)
        return JSONObject(response.toString()).put("state", response.optString("status"))
    }

    fun complete(libraryId: String, nodeId: String, configRevision: String, taskId: String): JSONObject {
        val repo = manager.openLibrary(libraryId); val current = requireTask(repo, taskId, nodeId, configRevision)
        check(current.optString("remoteKind") == "reconcile") { "RECOVERY_TASK_NOT_RECONCILE" }
        if (current.optString("state") in setOf("aligning", "completed", "needs-review", "failed"))
            return publicTask(current).put("state", recoveryState(current.optString("localAlignment"), current.optString("state")))
        val snapshot = readSnapshot(current)
        val operations = snapshot.getJSONArray("operations")
        val decidedRecords = mutableSetOf<String>(); var candidateCursor = 0
        while (true) {
            val page = rpc(nodeId, configRevision, "reconcileCandidates", remoteTaskRequest(repo, current)
                .put("cursor", candidateCursor).put("limit", 100))
            val items = page.getJSONArray("items")
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                if (item.optBoolean("resolved")) decidedRecords.add(item.getString("recordId"))
            }
            val next = page.opt("nextCursor")
            if (next == null || next == JSONObject.NULL) break
            candidateCursor = (next as? Number)?.toInt() ?: next.toString().toIntOrNull() ?: error("RECOVERY_CURSOR_INVALID")
        }
        for (start in 0 until operations.length() step 100) {
            val batch = (start until minOf(start + 100, operations.length())).map { operations.getJSONObject(it) }
            if (batch.isEmpty()) continue
            val ids = JSONArray(batch.map { it.getJSONObject("operation").getString("operationId") })
            val receipts = rpc(nodeId, configRevision, "reconcileReceipts", remoteTaskRequest(repo, current).put("operationIds", ids))
                .getJSONArray("receipts")
            for (index in 0 until receipts.length()) {
                val receipt = receipts.getJSONObject(index)
                val item = batch[index]
                val op = item.getJSONObject("operation")
                if (receipt.optString("status") == "applied") {
                    val result = receipt.optJSONObject("result") ?: error("RECOVERY_RECEIPT_RESULT_MISSING")
                    if (op.getJSONObject("payload").optString("kind") == "journal" &&
                        result.optString("recordId") != op.getString("recordId")) {
                        check(result.optBoolean("journalMerged")) { "RECOVERY_JOURNAL_MAPPING_MISSING" }
                        val sent = checkNotNull(repo.dao.outbox(op.getString("operationId"))) { "RECOVERY_OUTBOX_MISSING" }
                        check(Canonical.hash(plain(JSONObject(sent.payloadJson))) == Canonical.hash(plain(op))) { "RECOVERY_OUTBOX_CHANGED" }
                        val epoch = current.getJSONObject("target").getString("epoch")
                        val record = result.optJSONObject("currentRecord") ?: result.optJSONObject("currentRecordRef")?.let {
                            syncCoordinator.downloadPayloadObject(repo, nodeId, configRevision, epoch, it)
                        } ?: error("RECOVERY_JOURNAL_RECORD_MISSING")
                        val version = result.optJSONObject("currentVersion") ?: result.optJSONObject("currentVersionRef")?.let {
                            syncCoordinator.downloadPayloadObject(repo, nodeId, configRevision, epoch, it)
                        } ?: error("RECOVERY_JOURNAL_VERSION_MISSING")
                        repo.acceptJournalAppend(sent, result, record, version)
                    }
                    continue
                }
                check(op.getString("recordId") in decidedRecords) { "RECOVERY_OPERATION_REQUIRES_BRANCH_DECISION" }
                val result = rpc(nodeId, configRevision, "reconcileApply", remoteTaskRequest(repo, current)
                    .put("resolutionId", stableTransferId("operation-discard\u0000${current.getString("taskId")}\u0000${op.getString("operationId")}"))
                    .put("operationId", op.getString("operationId"))
                    .put("resolution", "discard").put("deviceId", repo.deviceId))
                check(result.optString("status") == "discarded") { "RECOVERY_OPERATION_UNRESOLVED" }
            }
        }
        current.put("state", "completing").put("phase", "finalize"); saveTask(repo, current)
        val result = rpc(nodeId, configRevision, "reconcileComplete", remoteTaskRequest(repo, current))
        val localSync = bindAndBootstrap(repo, current, nodeId, configRevision, result.optString("targetEpoch"))
        current.put("localSyncOperationId", localSync.getString("operationId"))
        current.put("state", "aligning").put("phase", "local-alignment")
            .put("result", result).put("localAlignment", "syncing")
        saveTask(repo, current)
        val remoteStatus = rpc(nodeId, configRevision, "reconcileStatus", remoteTaskRequest(repo, current))
        launchLocalAlignment(repo, current)
        return decorateProgress(current, remoteStatus).put("state", "aligning").put("localAlignment", "syncing")
            .put("localSyncOperationId", current.optString("localSyncOperationId"))
    }

    fun close() { executor.shutdownNow(); running.clear() }

    private fun resumeIfNeeded(repo: LibraryRepository, current: JSONObject) {
        if (current.optString("state") in ACTIVE_STATES && current.optString("state") !in setOf("awaiting-decisions", "awaiting-recovery")) launch(repo, current)
    }

    private fun resumeRemote(repo: LibraryRepository, current: JSONObject) {
        val nodeId = current.getString("nodeId"); val revision = current.getString("configRevision")
        val snapshot = readSnapshot(current)
        if (current.optString("remoteKind") == "setup") transferSetup(repo, current, snapshot)
        else transferReconcile(repo, current, snapshot)
    }

    private fun runInitialize(repo: LibraryRepository, task: JSONObject) {
        val snapshot = readSnapshot(task); val target = task.getJSONObject("target")
        val manifest = snapshot.getJSONObject("manifest")
        val beginArgs = JSONObject().put("setupId", task.getString("taskId")).put("mode", "initialize")
            .put("libraryId", manifest.getString("libraryId")).put("sourceEpoch", manifest.getString("epoch"))
            .put("manifestDigest", manifest.getString("manifestDigest")).put("manifest", manifest)
            .put("expectedLibraryId", target.getString("libraryId")).put("expectedEpoch", target.getString("epoch"))
            .put("targetGeneration", target.optLong("targetGeneration"))
        val begun = rpc(task.getString("nodeId"), task.getString("configRevision"), "setupBegin", beginArgs)
        task.put("remoteKind", "setup").put("serverTaskId", begun.getString("setupId"))
            .put("fencingToken", begun.getLong("fencingToken")).put("state", "running").put("phase", "transfer")
        saveTask(repo, task)
        transferSetup(repo, task, snapshot)
    }

    private fun transferSetup(repo: LibraryRepository, task: JSONObject, snapshot: JSONObject) {
        val nodeId = task.getString("nodeId"); val revision = task.getString("configRevision")
        val manifest = snapshot.getJSONObject("manifest"); val setupId = task.getString("serverTaskId")
        renewLease(repo, task)
        var token = task.getLong("fencingToken"); val target = task.getJSONObject("target")
        val entities = snapshot.getJSONObject("entities")
        val types = manifest.getJSONArray("entityTypes")
        for (typeIndex in 0 until types.length()) {
            val type = types.getString(typeIndex); val items = entities.getJSONArray(type)
            var ordinal = 0
            while (ordinal < items.length()) {
                token = maintainLease(repo, task)
                val batch = JSONArray(); var bytes = 2
                while (ordinal + batch.length() < items.length() && batch.length() < 100) {
                    val item = items.getJSONObject(ordinal + batch.length()); val encoded = Canonical.encode(plain(item)).toByteArray(Charsets.UTF_8)
                    if (encoded.size > MAX_INLINE_BYTES) break
                    if (bytes + encoded.size + 1 > MAX_PAGE_BYTES && batch.length() > 0) break
                    batch.put(item); bytes += encoded.size + 1
                }
                if (batch.length() > 0) {
                    val body = JSONObject().put("setupId", setupId).put("fencingToken", token).put("entityType", type)
                        .put("startOrdinal", ordinal).put("items", batch)
                    rpc(nodeId, revision, "setupPage", body, type); ordinal += batch.length()
                } else {
                    val item = items.getJSONObject(ordinal); val encoded = Canonical.encode(plain(item)).toByteArray(Charsets.UTF_8)
                    uploadPayload(nodeId, revision, "setupPayload", JSONObject().put("targetLibraryId", target.getString("libraryId"))
                        .put("expectedLibraryId", target.getString("libraryId")).put("setupId", setupId).put("fencingToken", token)
                        .put("entityType", type).put("ordinal", ordinal), encoded)
                    ordinal++
                }
                updateProgress(repo, task, "transfer", ordinal, items.length())
            }
        }
        uploadAttachments(repo, task, snapshot, "setup")
        token = maintainLease(repo, task)
        val result = commitSetupWithStatus(repo, task, token)
        val epoch = result.getString("epoch")
        val sync = bindAndBootstrap(repo, task, nodeId, revision, epoch, snapshotCoverage(snapshot))
        task.put("state", "aligning").put("phase", "local-alignment").put("result", result)
            .put("localAlignment", "syncing").put("localSyncOperationId", sync.getString("operationId"))
        saveTask(repo, task)
        awaitLocalAlignment(repo, task)
    }

    private fun runReconcile(repo: LibraryRepository, task: JSONObject) {
        val snapshot = readSnapshot(task); val target = task.getJSONObject("target"); val manifest = snapshot.getJSONObject("manifest")
        val operations = snapshot.getJSONArray("operations"); val operationDigest = snapshot.getString("operationDigest")
        val sourceServerId = task.getString("sourceServerId"); val sourceDeviceId = task.getString("sourceDeviceId")
        val outerDigest = Canonical.hash(mapOf("sourceServerId" to sourceServerId, "sourceDeviceId" to sourceDeviceId,
            "sourceManifest" to plain(manifest), "operationCount" to operations.length(), "operationDigest" to operationDigest))
        val args = JSONObject().put("taskId", task.getString("taskId")).put("mode", task.getString("mode"))
            .put("libraryId", target.getString("libraryId")).put("sourceEpoch", manifest.getString("epoch"))
            .put("targetEpoch", target.getString("epoch")).put("sourceDeviceId", sourceDeviceId)
            .put("sourceServerId", sourceServerId).put("sourceManifest", manifest).put("manifestDigest", outerDigest)
            .put("operationCount", operations.length()).put("operationDigest", operationDigest)
            .put("targetGeneration", target.optLong("targetGeneration"))
        val begun = rpc(task.getString("nodeId"), task.getString("configRevision"), "reconcileBegin", args)
        task.put("remoteKind", "reconcile").put("serverTaskId", begun.getString("taskId"))
            .put("fencingToken", begun.getLong("fencingToken")).put("state", "running").put("phase", "transfer")
        saveTask(repo, task)
        transferReconcile(repo, task, snapshot)
    }

    private fun transferReconcile(repo: LibraryRepository, task: JSONObject, snapshot: JSONObject) {
        val nodeId = task.getString("nodeId"); val revision = task.getString("configRevision")
        val entities = snapshot.getJSONObject("entities"); val manifest = snapshot.getJSONObject("manifest")
        renewLease(repo, task)
        val taskId = task.getString("serverTaskId"); var token = task.getLong("fencingToken")
        val types = manifest.getJSONArray("entityTypes")
        for (typeIndex in 0 until types.length()) {
            val type = types.getString(typeIndex); val items = entities.getJSONArray(type)
            var ordinal = 0
            while (ordinal < items.length()) {
                token = maintainLease(repo, task)
                val batch = JSONArray(); var bytes = 2
                while (ordinal + batch.length() < items.length() && batch.length() < 100) {
                    val item = items.getJSONObject(ordinal + batch.length()); val encoded = Canonical.encode(plain(item)).toByteArray(Charsets.UTF_8)
                    if (encoded.size > MAX_INLINE_BYTES) break
                    if (bytes + encoded.size + 1 > MAX_PAGE_BYTES && batch.length() > 0) break
                    batch.put(item); bytes += encoded.size + 1
                }
                if (batch.length() > 0) {
                    rpc(nodeId, revision, "reconcilePage", JSONObject().put("taskId", taskId).put("fencingToken", token)
                        .put("entityType", type).put("startOrdinal", ordinal).put("items", batch)); ordinal += batch.length()
                } else {
                    val item = items.getJSONObject(ordinal); val encoded = Canonical.encode(plain(item)).toByteArray(Charsets.UTF_8)
                    uploadPayload(nodeId, revision, "reconcilePayload", JSONObject().put("libraryId", task.getJSONObject("target").getString("libraryId"))
                        .put("taskId", taskId).put("fencingToken", token).put("entityType", type).put("ordinal", ordinal), encoded)
                    ordinal++
                }
                updateProgress(repo, task, "transfer", ordinal, items.length())
            }
        }
        val operations = snapshot.getJSONArray("operations")
        var opIndex = 0
        while (opIndex < operations.length()) {
            token = maintainLease(repo, task)
            val batch = JSONArray(); var bytes = 2
            while (opIndex + batch.length() < operations.length() && batch.length() < 100) {
                val item = operations.getJSONObject(opIndex + batch.length())
                val encoded = Canonical.encode(plain(item)).toByteArray(Charsets.UTF_8)
                if (encoded.size > MAX_INLINE_BYTES) break
                if (bytes + encoded.size + 1 > MAX_PAGE_BYTES && batch.length() > 0) break
                batch.put(item); bytes += encoded.size + 1
            }
            if (batch.length() > 0) {
                rpc(nodeId, revision, "reconcilePage", JSONObject().put("taskId", taskId).put("fencingToken", token)
                    .put("entityType", "operations").put("startOrdinal", opIndex).put("items", batch))
                opIndex += batch.length()
            } else {
                val item = operations.getJSONObject(opIndex); val encoded = Canonical.encode(plain(item)).toByteArray(Charsets.UTF_8)
                uploadPayload(nodeId, revision, "reconcilePayload", JSONObject().put("libraryId", task.getJSONObject("target").getString("libraryId"))
                    .put("taskId", taskId).put("fencingToken", token).put("entityType", "operations").put("ordinal", opIndex), encoded)
                opIndex++
            }
        }
        uploadAttachments(repo, task, snapshot, "reconcile")
        val remote = rpc(nodeId, revision, "reconcileStatus", remoteTaskRequest(repo, task))
        check(remote.optString("state") == "ready" && remote.optBoolean("digestMatches")) { "RECOVERY_SOURCE_INCOMPLETE" }
        task.put("state", "awaiting-decisions").put("phase", "review").put("remote", remote).put("completed", 1)
            .put("total", 1).put("updatedAt", Instant.now().toString())
        saveTask(repo, task)
    }

    private fun uploadAttachments(repo: LibraryRepository, task: JSONObject, snapshot: JSONObject, kind: String) {
        val descriptors = snapshot.getJSONObject("entities").getJSONArray("attachments")
        for (i in 0 until descriptors.length()) {
            maintainLease(repo, task)
            val item = descriptors.getJSONObject(i); val attachmentId = item.getString("id")
            val bytes = if (item.has("branchId")) repo.branchAttachmentBytes(item.getString("branchId"), attachmentId)
                else repo.attachmentBytes(attachmentId)
            check(bytes.size.toLong() == item.getLong("byteLength") && sha256(bytes) == item.getString("hash")) { "RECOVERY_ATTACHMENT_HASH_MISMATCH" }
            val fields = JSONObject().put("libraryId", task.getJSONObject("target").getString("libraryId"))
                .put("taskId", task.optString("serverTaskId")).put("setupId", task.optString("serverTaskId"))
                .put("fencingToken", task.optLong("fencingToken")).put("recordId", item.getString("recordId"))
                .put("attachmentId", attachmentId).put("name", item.getString("name")).put("digest", item.getString("hash"))
                .put("byteLength", item.getLong("byteLength"))
            if (kind == "setup") fields.put("targetLibraryId", task.getJSONObject("target").getString("libraryId"))
            if (item.has("branchId")) fields.put("branchId", item.getString("branchId"))
            uploadBlob(task.getString("nodeId"), task.getString("configRevision"), kind, fields, bytes)
            updateProgress(repo, task, "attachments", i + 1, descriptors.length())
        }
    }

    /** Recover the outcome of a write whose HTTP response was lost or rejected opaquely. */
    private fun commitSetupWithStatus(repo: LibraryRepository, task: JSONObject, token: Long): JSONObject {
        val nodeId = task.getString("nodeId"); val revision = task.getString("configRevision")
        val request = JSONObject().put("setupId", task.getString("serverTaskId")).put("fencingToken", token)
        try {
            return rpc(nodeId, revision, "setupCommit", request)
        } catch (error: Exception) {
            if (error.message != "RECOVERY_SETUPCOMMIT_MOBILE_SYNC_WRITE_UNKNOWN") throw error
        }

        fun readStatus(): JSONObject = rpc(nodeId, revision, "setupStatus", remoteTaskRequest(repo, task))
        var status = readStatus()
        when (setupCommitStatusAction(status.optString("state"), status.optJSONObject("result") != null)) {
            "use-result" -> return status.getJSONObject("result")
            "missing-result" -> throw IllegalStateException("RECOVERY_SETUPCOMMIT_RESULT_MISSING")
            "not-ready" -> {
                saveCommitStatus(repo, task, status)
                throw IllegalStateException("RECOVERY_SETUPCOMMIT_NOT_READY")
            }
            "retry" -> Unit
            else -> {
                saveCommitStatus(repo, task, status)
                throw IllegalStateException("RECOVERY_SETUPCOMMIT_UNCONFIRMED")
            }
        }

        // setupCommit is idempotent: if the first response was lost while the
        // server remained ready, one retry safely resolves the outcome.
        try {
            return rpc(nodeId, revision, "setupCommit", request)
        } catch (error: Exception) {
            if (error.message != "RECOVERY_SETUPCOMMIT_MOBILE_SYNC_WRITE_UNKNOWN") throw error
        }
        status = readStatus()
        when (setupCommitStatusAction(status.optString("state"), status.optJSONObject("result") != null)) {
            "use-result" -> return status.getJSONObject("result")
            "missing-result" -> throw IllegalStateException("RECOVERY_SETUPCOMMIT_RESULT_MISSING")
            else -> {
                saveCommitStatus(repo, task, status)
                throw IllegalStateException("RECOVERY_SETUPCOMMIT_UNCONFIRMED")
            }
        }
    }

    private fun saveCommitStatus(repo: LibraryRepository, task: JSONObject, status: JSONObject) {
        val safe = JSONObject().put("state", status.optString("state"))
        for (field in listOf("receivedCounts", "expectedCounts")) status.optJSONObject(field)?.let { counts ->
            val safeCounts = JSONObject()
            for (type in ENTITY_ORDER) if (counts.opt(type) is Number) safeCounts.put(type, counts.getInt(type))
            safe.put(field, safeCounts)
        }
        status.optJSONArray("missingEntities")?.let { values ->
            safe.put("missingEntityTypes", JSONArray().also { target ->
                for (index in 0 until values.length()) {
                    val type = values.optJSONObject(index)?.optString("entityType")?.takeIf { it in ENTITY_ORDER }
                    if (type != null && (0 until target.length()).none { target.optString(it) == type }) target.put(type)
                }
            })
        }
        status.optJSONArray("missingAttachmentIds")?.let { safe.put("missingAttachmentCount", it.length()) }
        task.put("remoteCommitStatus", safe)
        saveTask(repo, task)
    }

    private fun uploadPayload(nodeId: String, revision: String, prefix: String, metadata: JSONObject, bytes: ByteArray) {
        val digest = sha256(bytes)
        val entityType = metadata.optString("entityType").takeIf { it.isNotBlank() }
        val scope = metadata.optString("setupId", metadata.optString("taskId"))
        val id = stableTransferId("payload\u0000$prefix\u0000$scope\u0000${metadata.optLong("fencingToken")}\u0000${metadata.optString("entityType")}\u0000${metadata.optInt("ordinal")}\u0000$digest")
        val beginAction = "${prefix}Begin"; val partAction = "${prefix}Part"; val commitAction = "${prefix}Commit"
        val base = JSONObject(metadata.toString()).put("uploadId", id).put("byteLength", bytes.size).put("digest", digest)
        val begin = rpc(nodeId, revision, beginAction, base, entityType)
        val partBytes = begin.optInt("partBytes", PART_BYTES); require(partBytes in 1..PART_BYTES) { "RECOVERY_PART_SIZE_INVALID" }
        val missing = begin.optJSONArray("missingParts")
        val partCount = (bytes.size + partBytes - 1) / partBytes
        val indices = if (missing == null) (0 until partCount).toList() else (0 until missing.length()).map { missing.optInt(it, -1) }
        for (part in indices) {
            require(part in 0 until partCount) { "RECOVERY_PART_INDEX_INVALID" }
            val start = part * partBytes; val end = minOf(bytes.size, start + partBytes); val chunk = bytes.copyOfRange(start, end)
            rpc(nodeId, revision, partAction, JSONObject(metadata.toString()).put("uploadId", id).put("part", part)
                .put("partDigest", sha256(chunk)).put("dataBase64", Base64.encodeToString(chunk, Base64.NO_WRAP)), entityType)
        }
        rpc(nodeId, revision, commitAction, JSONObject(metadata.toString()).put("uploadId", id), entityType)
    }

    private fun uploadBlob(nodeId: String, revision: String, kind: String, metadata: JSONObject, bytes: ByteArray) {
        val digest = sha256(bytes)
        val prefix = if (kind == "setup") "setupBlob" else "reconcileBlob"
        val scope = metadata.optString("setupId", metadata.optString("taskId"))
        val id = stableTransferId("blob\u0000$prefix\u0000$scope\u0000${metadata.optLong("fencingToken")}\u0000${metadata.optString("attachmentId")}\u0000${metadata.optString("branchId")}\u0000$digest")
        val base = JSONObject(metadata.toString()).put("uploadId", id).put("byteLength", bytes.size).put("digest", digest)
        val begin = rpc(nodeId, revision, "${prefix}Begin", base)
        val partBytes = begin.optInt("partBytes", PART_BYTES); require(partBytes in 1..PART_BYTES) { "RECOVERY_PART_SIZE_INVALID" }
        val partCount = (bytes.size + partBytes - 1) / partBytes
        val missing = begin.optJSONArray("missingParts")
        val indices = if (missing == null) (0 until partCount).toList() else (0 until missing.length()).map { missing.optInt(it, -1) }
        for (part in indices) {
            require(part in 0 until partCount) { "RECOVERY_PART_INDEX_INVALID" }
            val start = part * partBytes; val end = minOf(bytes.size, start + partBytes); val chunk = bytes.copyOfRange(start, end)
            rpc(nodeId, revision, "${prefix}Part", JSONObject(metadata.toString()).put("uploadId", id).put("part", part)
                .put("partDigest", sha256(chunk)).put("dataBase64", Base64.encodeToString(chunk, Base64.NO_WRAP)))
        }
        rpc(nodeId, revision, "${prefix}Commit", JSONObject(metadata.toString()).put("uploadId", id).put("digest", digest))
    }

    private fun stableTransferId(value: String): String = UUID.nameUUIDFromBytes(value.toByteArray(Charsets.UTF_8)).toString()

    private fun renewLease(repo: LibraryRepository, task: JSONObject) {
        val action = if (task.optString("remoteKind") == "setup") "setupLease" else "reconcileLease"
        val result = rpc(task.getString("nodeId"), task.getString("configRevision"), action, remoteTaskRequest(repo, task))
        val fencingToken = result.optLong("fencingToken", task.optLong("fencingToken"))
        require(fencingToken > 0) { "RECOVERY_FENCE_MISSING" }
        task.put("fencingToken", fencingToken).put("leaseRenewedAt", System.currentTimeMillis())
            .put("updatedAt", Instant.now().toString())
        saveTask(repo, task)
    }
    private fun maintainLease(repo: LibraryRepository, task: JSONObject): Long {
        val renewedAt = task.optLong("leaseRenewedAt")
        if (renewedAt == 0L || System.currentTimeMillis() - renewedAt >= LEASE_RENEWAL_MS) renewLease(repo, task)
        return task.getLong("fencingToken")
    }

    private fun freeze(repo: LibraryRepository, task: JSONObject): JSONObject {
        val raw = repo.archiveSnapshot(); val records = arr(raw, "records").map(::recordDto).sortedBy { it.getString("id") }
        val recordIds = records.map { it.getString("id") }.toSet()
        val heads = arr(raw, "heads").map { item ->
            val id = item.getString("recordId"); val versionId = nullable(item, "versionId") ?: error("RECOVERY_HEAD_VERSION_MISSING")
            JSONObject().put("recordId", id).put("revision", item.getLong("revision")).put("versionId", versionId)
                .put("changeId", nullable(item, "changeId") ?: JSONObject.NULL).put("deleted", item.optBoolean("deleted"))
        }.sortedBy { it.getString("recordId") }
        check(heads.map { it.getString("recordId") }.toSet() == recordIds) { "RECOVERY_HEAD_SET_MISMATCH" }
        val versions = arr(raw, "versions").map { item ->
            val markdown = item.getString("markdown")
            val sources = item.optJSONArray("sources") ?: JSONArray()
            JSONObject().put("id", item.getString("id")).put("recordId", item.getString("recordId"))
                .put("revision", item.getLong("revision")).put("markdown", markdown)
                .put("doc", versionDocument(markdown, sources, item.optJSONObject("doc")))
                .put("sources", sources).put("parentVersionIds", item.optJSONArray("parentVersionIds") ?: JSONArray())
                .put("title", item.optString("title")).put("createdAt", item.getString("createdAt")).put("reason", item.optString("reason", "保存"))
                .apply {
                    item.optJSONObject("journalInput")?.let { put("journalInput", it) }
                    records.firstOrNull { it.getString("id") == item.getString("recordId") }?.optJSONObject("annotationOf")?.let { put("annotationOf", it) }
                }
        }.sortedWith(compareBy<JSONObject> { it.getString("recordId") }.thenBy { it.getLong("revision") }.thenBy { it.getString("id") })
        val activities = arr(raw, "activities").map { item ->
            val result = JSONObject().put("activityId", item.getString("activityId")).put("recordId", item.getString("recordId"))
                .put("changeId", nullable(item, "changeId") ?: JSONObject.NULL).put("originDeviceId", nullable(item, "originDeviceId") ?: JSONObject.NULL)
                .put("occurredAt", item.getString("occurredAt")).put("timeZone", item.optString("timeZone", "UTC"))
                .put("beforeHash", item.getString("beforeHash")).put("afterHash", item.getString("afterHash"))
                .put("afterSegments", item.optJSONArray("afterSegments") ?: JSONArray()).put("action", item.optString("action"))
                .put("authorship", item.optString("authorship", "unknown"))
            require(result.getString("action") in ACTIVITY_ACTIONS) { "RECOVERY_ACTIVITY_ACTION_INVALID" }
            result
        }.sortedWith(compareBy<JSONObject> { it.getString("recordId") }.thenBy { it.getString("occurredAt") }.thenBy { it.getString("activityId") })
        val links = arr(raw, "links").map { JSONObject().put("articleId", it.getString("articleId")).put("materialId", it.getString("materialId")) }
            .sortedWith(compareBy<JSONObject> { it.getString("articleId") }.thenBy { it.getString("materialId") })
        // Local import provenance can consist only of `recordId` + `import`.
        // The mobile wire contract always requires both source collections, so
        // normalize their absence to empty arrays while preserving every value.
        // Archive JSON historically omitted the provenance table's relational
        // recordId key. Read the rows directly so the wire entity has its owner.
        val recordById = records.associateBy { it.getString("id") }
        val provenance = repo.dao.allProvenance().map { row ->
            provenanceDto(JSONObject(row.json), row.recordId, recordById[row.recordId])
        }.sortedBy { it.getString("recordId") }
        val branchAttachmentRows = arr(raw, "branchAttachments").groupBy { it.getString("branchId") }
        val branches = arr(raw, "branches").map { rawBranch ->
            val branch = JSONObject(rawBranch.toString()); val id = branch.getString("branchId")
            val branchState = branch.optString("state")
            require(branchState in setOf("retained", "discarded", "merged", "open")) { "RECOVERY_BRANCH_STATE_INVALID" }
            if (branchState == "open") branch.put("state", "retained")
            val branchAttachments = branch.optJSONArray("attachments") ?: JSONArray()
            val fixed = JSONArray()
            for (index in 0 until branchAttachments.length()) {
                val value = JSONObject(branchAttachments.getJSONObject(index).toString()).put("branchId", id)
                fixed.put(value)
            }
            for (item in branchAttachmentRows[id].orEmpty()) {
                fixed.put(JSONObject().put("id", item.getString("attachmentId")).put("recordId", branch.getString("recordId"))
                    .put("name", item.getString("name")).put("createdAt", item.getString("createdAt"))
                    .put("hash", item.getString("hash")).put("byteLength", item.getLong("byteLength")).put("branchId", id))
            }
            branch.put("attachments", fixed); branch
        }.sortedWith(compareBy<JSONObject> { it.optString("createdAt") }.thenBy { it.getString("branchId") })
        val attachmentsById = linkedMapOf<String, JSONObject>()
        for (item in arr(raw, "attachments")) {
            val descriptor = JSONObject().put("id", item.getString("id")).put("recordId", item.getString("recordId"))
                .put("name", item.getString("name")).put("createdAt", item.getString("createdAt"))
                .put("hash", item.getString("hash")).put("byteLength", item.getLong("byteLength"))
            attachmentsById[attachmentKey(descriptor)] = descriptor
        }
        for (branch in branches) for (i in 0 until branch.getJSONArray("attachments").length()) {
            val descriptor = JSONObject(branch.getJSONArray("attachments").getJSONObject(i).toString())
            val key = attachmentKey(descriptor); val old = attachmentsById[key]
            check(old == null || Canonical.hash(plain(old)) == Canonical.hash(plain(descriptor))) { "RECOVERY_ATTACHMENT_ID_COLLISION" }
            attachmentsById[key] = descriptor
        }
        val attachments = attachmentsById.values.sortedWith(compareBy<JSONObject> { it.getString("id") }.thenBy { it.optString("branchId") })
        val entities = linkedMapOf<String, List<JSONObject>>(
            "records" to records, "heads" to heads, "versions" to versions, "activities" to activities,
            "links" to links, "attachments" to attachments, "provenance" to provenance, "branches" to branches)
        val entityTypes = JSONArray(ENTITY_ORDER)
        val counts = JSONObject(); val digests = JSONObject(); val entityJson = JSONObject()
        for (type in ENTITY_ORDER) {
            val values = entities.getValue(type); counts.put(type, values.size); digests.put(type, Canonical.hash(values.map(::plain)))
            entityJson.put(type, JSONArray(values))
        }
        val registry = repo.registryItem(); val epoch = registry.epoch ?: repo.dao.meta(SOURCE_EPOCH_META)?.also { UUID.fromString(it) }
            ?: UUID.randomUUID().toString().also { repo.dao.putMeta(LibraryMeta(SOURCE_EPOCH_META, it)) }
        val serverId = registry.serverId ?: repo.libraryId
        val core = JSONObject().put("protocolVersion", PROTOCOL_VERSION).put("libraryId", repo.libraryId).put("epoch", epoch)
            .put("snapshotId", UUID.randomUUID().toString()).put("highWatermark", versions.maxOfOrNull { it.getLong("revision") } ?: 0L)
            .put("counts", counts).put("entityDigests", digests).put("entityTypes", entityTypes)
        val manifest = JSONObject(core.toString()).put("manifestDigest", Canonical.hash(plain(core)))
        val operations = JSONArray(repo.dao.pendingOutbox(100_000).map { row -> JSONObject().put("deviceId", repo.deviceId).put("operation", JSONObject(row.payloadJson)) })
        val operationDigest = Canonical.hash((0 until operations.length()).map { plain(operations.getJSONObject(it)) })
        return JSONObject().put("manifest", manifest).put("entities", entityJson).put("operations", operations)
            .put("operationDigest", operationDigest).put("sourceServerId", serverId).put("sourceDeviceId", repo.deviceId)
            .put("sourceLibraryId", repo.libraryId)
    }

    private fun recordDto(value: JSONObject): JSONObject {
        val result = JSONObject().put("id", value.getString("id")).put("kind", value.getString("kind"))
            .put("title", value.optString("title")).put("markdown", value.optString("markdown"))
            .put("origin", value.optString("origin", "unknown")).put("processing", value.optString("processing", "unknown"))
            .put("contentDay", nullable(value, "contentDay") ?: JSONObject.NULL).put("dateBasis", value.optString("dateBasis", "unknown"))
            .put("url", nullable(value, "url") ?: "").put("annotation", nullable(value, "annotation") ?: "")
            .put("stage", nullable(value, "stage") ?: "draft").put("sourceIds", value.optJSONArray("sourceIds") ?: JSONArray())
            .put("sources", value.optJSONArray("sources") ?: JSONArray()).put("attachmentDescriptors", value.optJSONArray("attachmentDescriptors") ?: JSONArray())
            .put("createdAt", value.getString("createdAt")).put("updatedAt", value.getString("updatedAt"))
            .put("deleted", value.optBoolean("deleted")).put("createdByDevice", nullable(value, "createdByDevice") ?: JSONObject.NULL)
        value.optJSONObject("annotationOf")?.let { result.put("annotationOf", it) }
        return result
    }
    private fun provenanceDto(value: JSONObject, recordId: String, record: JSONObject?): JSONObject =
        normalizeProvenance(value, recordId, nullable(record ?: JSONObject(), "contentDay"), record?.optString("dateBasis"))
    private fun attachmentKey(value: JSONObject) = "${value.getString("id")}\u0000${value.optString("branchId") }"

    private fun snapshotFile(libraryId: String, taskId: String) = File(app.filesDir, "libraries/$libraryId/recovery/$taskId.snapshot.json")
    private fun readSnapshot(task: JSONObject) = JSONObject(File(task.getString("snapshotFile")).readText(Charsets.UTF_8))
    private fun task(repo: LibraryRepository) = repo.dao.meta(TASK_META)?.let { runCatching { JSONObject(it) }.getOrNull() }
    private fun saveTask(repo: LibraryRepository, task: JSONObject) { repo.dao.putMeta(LibraryMeta(TASK_META, task.toString())) }
    private fun requireTask(repo: LibraryRepository, taskId: String, nodeId: String, revision: String): JSONObject {
        val current = checkNotNull(task(repo)) { "RECOVERY_TASK_NOT_FOUND" }
        check(current.optString("taskId") == taskId) { "RECOVERY_TASK_NOT_FOUND" }
        check(current.optString("nodeId") == nodeId && current.optString("configRevision") == revision) { "NODE_CHANGED" }
        return current
    }
    private fun publicTask(task: JSONObject) = JSONObject(task.toString()).apply {
        remove("snapshotFile"); remove("target"); remove("result")
    }
    private fun decorateProgress(task: JSONObject, remote: JSONObject): JSONObject {
        val candidateCount = remote.optInt("candidateCount")
        val resolvedCandidateCount = remote.optInt("resolvedCandidateCount")
        // The local durable task is authoritative for client-side failures. A
        // remote setup can remain `receiving` after one of our page/blob calls
        // was rejected; preferring that remote state used to hide the failure.
        val state = progressState(task.optString("state"), remote.optString("state"),
            task.optString("remoteKind"), candidateCount, resolvedCandidateCount)
        val result = publicTask(task).put("remote", remote).put("state", state)
        if (state == "failed") {
            task.optString("error").takeIf { it.isNotBlank() }?.let { result.put("error", it).put("errorCode", it) }
        }
        for (key in listOf("receivedCounts", "expectedCounts", "missingEntities", "missingAttachmentIds",
                "candidateCount", "resolvedCandidateCount", "resolvedCounts", "leaseExpiresAt", "fencingToken",
                "sourceEpoch", "targetEpoch", "manifestDigest", "digestMatches")) {
            if (remote.has(key)) result.put(key, remote.get(key))
        }
        remote.optJSONArray("missingEntities")?.let { items ->
            val mapped = JSONArray()
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                mapped.put(JSONObject(item.toString()).put("entity", item.optString("entityType")))
            }
            result.put("missingEntities", mapped)
        }
        result.put("resolvedCount", remote.optInt("resolvedOperations"))
        return result
    }
    private fun remoteTaskRequest(repo: LibraryRepository, task: JSONObject): JSONObject {
        val base = JSONObject().put("fencingToken", task.optLong("fencingToken"))
        if (task.optString("remoteKind") == "setup") {
            return base.put("setupId", task.getString("serverTaskId"))
        }
        return base.put("taskId", task.getString("serverTaskId"))
            .put("libraryId", task.getJSONObject("target").getString("libraryId"))
            .put("epoch", task.getJSONObject("target").getString("epoch")).put("deviceId", repo.deviceId)
    }
    private fun launch(repo: LibraryRepository, task: JSONObject) {
        val id = task.optString("taskId"); if (id.isBlank() || !running.add(id)) return
        executor.execute {
            try { runTask(repo, task(repo) ?: task) }
            catch (error: Exception) { val current = task(repo) ?: task; current.put("state", "failed").put("phase", "error").put("error", safeError(error)); saveTask(repo, current) }
            finally { running.remove(id) }
        }
    }
    private fun runTask(repo: LibraryRepository, task: JSONObject) {
        var current = task
        if (current.optString("state") == "aligning") {
            awaitLocalAlignment(repo, current)
            return
        }
        if (current.optString("state") in setOf("awaiting-decisions", "awaiting-recovery", "completed", "needs-review", "cancelled")) return
        val file = File(current.optString("snapshotFile"))
        if (!file.isFile) {
            if (current.optBoolean("remoteTaskCreated")) error("RECOVERY_SNAPSHOT_MISSING")
            current.put("state", "freezing").put("phase", "freeze"); saveTask(repo, current)
            val frozen = freeze(repo, current); atomicWrite(file, frozen.toString())
            current.put("snapshotDigest", frozen.getJSONObject("manifest").getString("manifestDigest"))
                .put("sourceEpoch", frozen.getJSONObject("manifest").getString("epoch"))
                .put("sourceDeviceId", repo.deviceId).put("sourceServerId", frozen.getString("sourceServerId"))
                .put("state", "running").put("phase", "snapshot-frozen")
            saveTask(repo, current)
        }
        current = task(repo) ?: current
        if (current.optString("mode") == "initialize") {
            if (current.optString("remoteKind") == "setup") transferSetup(repo, current, readSnapshot(current)) else runInitialize(repo, current)
        } else {
            if (current.optString("remoteKind") == "reconcile") transferReconcile(repo, current, readSnapshot(current)) else runReconcile(repo, current)
        }
    }

    private fun targetIdentity(nodeId: String, revision: String, deviceId: String): JSONObject =
        rpc(nodeId, revision, "identity", JSONObject().put("protocolVersion", PROTOCOL_VERSION).put("deviceId", deviceId))
    private fun sourceIdentity(repo: LibraryRepository): JSONObject {
        val row = repo.registryItem(); val epoch = row.epoch ?: repo.dao.meta(SOURCE_EPOCH_META)?.also { UUID.fromString(it) }
            ?: UUID.randomUUID().toString().also { repo.dao.putMeta(LibraryMeta(SOURCE_EPOCH_META, it)) }
        return JSONObject().put("serverId", row.serverId ?: repo.libraryId).put("libraryId", repo.libraryId).put("epoch", epoch).put("deviceId", repo.deviceId)
    }
    private fun bindAndBootstrap(repo: LibraryRepository, task: JSONObject, nodeId: String, revision: String,
        expectedEpoch: String?, snapshotCoverage: SnapshotCoverage? = null): JSONObject {
        val identity = targetIdentity(nodeId, revision, repo.deviceId)
        check(identity.getString("libraryId") == repo.libraryId) { "RECOVERY_LIBRARY_MISMATCH" }
        check(expectedEpoch.isNullOrBlank() || identity.getString("epoch") == expectedEpoch) { "RECOVERY_TARGET_CHANGED" }
        val row = manager.row(repo.libraryId)
        manager.update(row.copy(role = "coordinated", integrity = "incomplete", serverId = identity.getString("serverId"),
            epoch = identity.getString("epoch"), protocolVersion = 1, lastSyncedAt = null, appliedCursor = "0",
            completeCursor = null, cursor = "0", manifestDigest = null))
        repo.dao.putMeta(LibraryMeta("nodeBinding", JSONObject().put("nodeId", nodeId).put("configRevision", revision).toString()))
        task.put("targetIdentity", JSONObject().put("serverId", identity.getString("serverId"))
            .put("libraryId", identity.getString("libraryId")).put("epoch", identity.getString("epoch"))
            .put("revision", identity.optLong("revision")).put("targetGeneration", identity.optLong("targetGeneration")))
        return syncCoordinator.syncNow(repo.libraryId, "manual", snapshotCoverage)
    }

    private fun snapshotCoverage(snapshot: JSONObject): SnapshotCoverage {
        val entities = snapshot.getJSONObject("entities")
        val versions = entities.getJSONArray("versions")
        val versionIds = (0 until versions.length()).map { index ->
            val item = versions.getJSONObject(index)
            item.getString("recordId") to item.getString("id")
        }.toSet()
        val operations = snapshot.getJSONArray("operations")
        val captured = (0 until operations.length()).map { index ->
            val operation = operations.getJSONObject(index).getJSONObject("operation")
            SnapshotCoveredOperation(operation.getString("operationId"), operation.getString("recordId"),
                operation.getString("versionId"))
        }
        return SnapshotCoverage(captured, versionIds)
    }

    private fun launchLocalAlignment(repo: LibraryRepository, task: JSONObject) {
        val id = task.optString("taskId")
        if (id.isBlank() || !running.add(id)) return
        executor.execute {
            try { awaitLocalAlignment(repo, task(repo) ?: task) }
            catch (error: Exception) {
                val current = task(repo) ?: task
                current.put("state", "failed").put("phase", "local-alignment")
                    .put("localAlignment", "failed").put("localAlignmentError", safeError(error))
                saveTask(repo, current)
            } finally { running.remove(id) }
        }
    }

    /** Advance local bootstrap/catch-up from the task worker; progress() only observes it. */
    private fun awaitLocalAlignment(repo: LibraryRepository, initialTask: JSONObject) {
        val current = initialTask
        val operationId = current.optString("localSyncOperationId")
        check(operationId.isNotBlank()) { "RECOVERY_LOCAL_SYNC_MISSING" }
        val deadline = System.nanoTime() + LOCAL_ALIGNMENT_TIMEOUT_MS * 1_000_000L
        var local: JSONObject
        while (true) {
            if (System.nanoTime() >= deadline) {
                current.put("state", "needs-review").put("phase", "local-alignment")
                    .put("localAlignment", "needs-review").put("localAlignmentError", "RECOVERY_LOCAL_SYNC_TIMEOUT")
                saveTask(repo, current)
                return
            }
            local = syncCoordinator.progress(repo.libraryId, operationId)
            when (local.optString("state")) {
                "failed" -> error(local.optString("error").takeIf { it.isNotBlank() } ?: "RECOVERY_LOCAL_SYNC_FAILED")
                "completed" -> break
                "queued", "running" -> Thread.sleep(200)
                else -> {
                    current.put("state", "needs-review").put("phase", "local-alignment")
                        .put("localAlignment", "needs-review").put("localAlignmentError", "RECOVERY_LOCAL_SYNC_UNKNOWN")
                    saveTask(repo, current)
                    return
                }
            }
        }
        val pending = repo.dao.pendingOutbox(100_000)
        val conflicts = repo.dao.conflicts(100_000, 0)
        if (pending.isEmpty() && conflicts.isEmpty()) {
            current.put("state", "completed").put("phase", "completed").put("completedAt", Instant.now().toString())
                .put("localAlignment", "complete")
        } else {
            current.put("state", "needs-review").put("phase", "local-alignment").put("localAlignment", "needs-review")
            if (pending.isNotEmpty()) current.put("pendingOperationCount", pending.size)
            if (conflicts.isNotEmpty()) current.put("conflictCount", conflicts.size)
        }
        saveTask(repo, current)
    }
    private fun targetMatches(expected: JSONObject, actual: JSONObject, revision: String): Boolean =
        expected.optString("serverId") == actual.optString("serverId") && expected.optString("libraryId") == actual.optString("libraryId") &&
            expected.optString("epoch") == actual.optString("epoch") && expected.optLong("targetGeneration", -1) == actual.optLong("targetGeneration", -2) &&
            expected.optLong("revision", -1) == actual.optLong("revision", -2) && expected.optString("configRevision") == revision
    private fun rpc(nodeId: String, revision: String, action: String, args: JSONObject, entityType: String? = null): JSONObject {
        try {
            val response = connection.mobileSync(nodeId, action, args, revision)
            check(!response.optBoolean("nodeChanged")) { "NODE_CHANGED" }
            return response.getJSONObject("data")
        } catch (error: Exception) {
            // Keep only the protocol error code and action. Never persist server
            // response bodies or request data (which may contain user content).
            throw IllegalStateException(failureCode(action, error.message, entityType), error)
        }
    }
    private fun updateProgress(repo: LibraryRepository, task: JSONObject, phase: String, completed: Int, total: Int) {
        task.put("state", "running").put("phase", phase).put("completed", completed).put("total", total)
            .put("updatedAt", Instant.now().toString()); saveTask(repo, task)
    }
    private fun downloadPayload(nodeId: String, revision: String, repo: LibraryRepository, task: JSONObject, ref: JSONObject): JSONObject {
        require(ref.optString("encodingVersion") == "shiwen-json-v1") { "RECOVERY_PAYLOAD_ENCODING_UNSUPPORTED" }
        val length = ref.getLong("byteLength"); require(length in 1..64L * 1024 * 1024) { "RECOVERY_BRANCH_TOO_LARGE" }
        val bytes = java.io.ByteArrayOutputStream(length.toInt()); var offset = 0L
        while (offset < length) {
            val size = minOf(PART_BYTES.toLong(), length - offset)
            val response = rpc(nodeId, revision, "payloadDownload", JSONObject().put("libraryId", task.getJSONObject("target").getString("libraryId"))
                .put("epoch", task.getJSONObject("target").getString("epoch")).put("deviceId", repo.deviceId)
                .put("payloadRef", ref.getString("payloadRef")).put("offset", offset).put("byteLength", size))
            check(response.optLong("offset", -1) == offset && response.optLong("byteLength", -1) == length &&
                response.optString("digest") == ref.getString("digest")) { "RECOVERY_PAYLOAD_RANGE_INVALID" }
            val chunk = Base64.decode(response.getString("dataBase64"), Base64.DEFAULT)
            check(chunk.isNotEmpty() && chunk.size.toLong() <= size) { "RECOVERY_PAYLOAD_EMPTY" }
            val end = offset + chunk.size
            val next = response.opt("nextOffset")
            check(if (end < length) next != null && next != JSONObject.NULL && (next as? Number)?.toLong() == end
                else next == null || next == JSONObject.NULL) { "RECOVERY_PAYLOAD_RANGE_INVALID" }
            check(response.optBoolean("complete") == (end == length)) { "RECOVERY_PAYLOAD_RANGE_INVALID" }
            bytes.write(chunk); offset = end
        }
        val raw = bytes.toByteArray(); check(raw.size.toLong() == length && sha256(raw) == ref.getString("digest")) { "RECOVERY_PAYLOAD_HASH_MISMATCH" }
        return JSONObject(String(raw, Charsets.UTF_8))
    }
    private fun atomicWrite(file: File, content: String) { file.parentFile?.mkdirs(); val temp = File(file.parentFile, ".${file.name}.part"); temp.writeText(content, Charsets.UTF_8); check(temp.renameTo(file)) { "RECOVERY_SNAPSHOT_WRITE_FAILED" } }
    private fun safeError(error: Exception) = error.message.orEmpty().takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{0,63}")) } ?: error.javaClass.simpleName
    private fun arr(obj: JSONObject, key: String) = obj.optJSONArray(key)?.let { value -> (0 until value.length()).map { value.getJSONObject(it) } } ?: emptyList()
    private fun nullable(obj: JSONObject, key: String): String? = obj.opt(key)?.takeUnless { it == JSONObject.NULL }?.toString()
    private fun plain(value: Any?): Any? = when (value) {
        null, JSONObject.NULL -> null
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        is Byte, is Short, is Int, is Long -> (value as Number).toLong()
        is Number -> { val n = value.toDouble(); if (n % 1.0 == 0.0) n.toLong() else error("RECOVERY_NON_INTEGER_JSON") }
        is Boolean, is String -> value
        else -> error("RECOVERY_JSON_TYPE_INVALID")
    }
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

    companion object {
        private const val TASK_META = "mobile-recovery-task-v2"
        private const val SOURCE_EPOCH_META = "mobile-recovery-source-epoch-v1"
        private const val PROTOCOL_VERSION = "1.0.0-draft.3"

        /** Safe, action-scoped failure code suitable for durable task status. */
        internal fun failureCode(action: String, message: String?, entityType: String? = null): String {
            val safeAction = action.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }.take(28)
                .ifBlank { "RPC" }
            val safeEntity = entityType.orEmpty().uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }.take(16)
            val safeCode = message.orEmpty().takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{0,63}")) }
                ?: "REQUEST_FAILED"
            val context = if (safeEntity.isBlank()) "" else "_${safeEntity}"
            return "RECOVERY_${safeAction}${context}_${safeCode}".take(64)
        }

        internal fun progressState(taskState: String, remoteState: String, remoteKind: String,
            candidateCount: Int, resolvedCandidateCount: Int): String = when {
            taskState == "failed" -> "failed"
            remoteState == "completed" -> "completed"
            remoteState == "ready" && resolvedCandidateCount < candidateCount -> "needsReview"
            remoteState == "ready" -> "ready"
            remoteKind == "setup" && remoteState == "committed" -> "aligning"
            else -> remoteState.ifBlank { taskState }
        }

        internal fun recoveryState(localAlignment: String, remoteState: String): String = when {
            remoteState == "failed" || localAlignment == "failed" -> "failed"
            localAlignment == "complete" -> "completed"
            localAlignment == "needs-review" -> "needsReview"
            localAlignment == "syncing" -> "aligning"
            else -> remoteState
        }

        internal fun setupCommitStatusAction(remoteState: String, hasResult: Boolean): String = when {
            remoteState == "committed" && hasResult -> "use-result"
            remoteState == "committed" -> "missing-result"
            remoteState == "ready" -> "retry"
            remoteState in setOf("receiving", "aborted") -> "not-ready"
            else -> "unknown"
        }

        internal fun normalizeProvenance(value: JSONObject, recordId: String, contentDay: String? = null,
            dateBasis: String? = null): JSONObject = JSONObject(value.toString()).apply {
            require(recordId.isNotBlank()) { "RECOVERY_PROVENANCE_RECORD_ID_MISSING" }
            put("recordId", recordId)
            if (optJSONArray("sources") == null) put("sources", JSONArray())
            if (optJSONArray("externalSources") == null) put("externalSources", JSONArray())
            // The server's setupCommit persists import.contentDay as a SQL
            // parameter. An absent JSON property becomes JavaScript undefined,
            // which sqlite rejects; represent absence explicitly as SQL NULL.
            optJSONObject("import")?.let { original ->
                val imported = JSONObject(original.toString())
                if (!imported.has("contentDay")) imported.put("contentDay", contentDay ?: JSONObject.NULL)
                if (!imported.has("dateBasis")) imported.put("dateBasis", dateBasis ?: "")
                put("import", imported)
            }
        }

        /** Project local source segments into the ProseMirror document expected by DSH. */
        internal fun versionDocument(markdown: String, sources: JSONArray, existingDoc: JSONObject? = null): JSONObject {
            // Keep rich server documents byte-for-byte when this local library was
            // previously bootstrapped from a DSH node. Locally authored versions
            // store a wireRecord here instead, so synthesize their portable doc.
            if (existingDoc?.optString("type") == "doc" && existingDoc.optJSONArray("content") != null)
                return JSONObject(existingDoc.toString())
            val paragraphs = mutableListOf<JSONArray>()
            var current = JSONArray()
            val joined = StringBuilder()
            for (index in 0 until sources.length()) {
                val segment = sources.getJSONObject(index)
                val text = segment.optString("text")
                joined.append(text)
                val origin = segment.optString("origin", "unknown").ifBlank { "unknown" }
                val sourceRef = segment.optString("sourceRef").takeIf { it.isNotBlank() && it != "null" }
                var offset = 0
                while (true) {
                    val newline = text.indexOf('\n', offset)
                    val end = if (newline < 0) text.length else newline
                    if (end > offset) {
                        val attrs = JSONObject().put("origin", origin)
                        sourceRef?.let { attrs.put("sourceRef", it) }
                        val marks = JSONArray().put(JSONObject().put("type", "provenance").put("attrs", attrs))
                        current.put(JSONObject().put("type", "text").put("text", text.substring(offset, end)).put("marks", marks))
                    }
                    if (newline < 0) break
                    paragraphs.add(current); current = JSONArray(); offset = newline + 1
                }
            }
            check(joined.toString() == markdown) { "RECOVERY_VERSION_SOURCES_MISMATCH" }
            paragraphs.add(current)
            return JSONObject().put("type", "doc").put("content", JSONArray().also { content ->
                paragraphs.forEach { content.put(JSONObject().put("type", "paragraph").put("content", it)) }
            })
        }
        private const val MAX_INLINE_BYTES = 512 * 1024
        private const val MAX_PAGE_BYTES = 3 * 1024 * 1024
        private const val PART_BYTES = 1024 * 1024
        private const val LEASE_RENEWAL_MS = 45_000L
        private const val LOCAL_ALIGNMENT_TIMEOUT_MS = 120_000L
        private val ENTITY_ORDER = listOf("records", "heads", "versions", "activities", "links", "attachments", "provenance", "branches")
        private val ACTIVITY_ACTIONS = setOf("write", "copy", "import", "restore", "resolve")
        private val MODES = setOf("initialize", "coordinator-recovery", "device-restore")
        private val RESOLUTIONS = setOf("retain-branch", "use-branch", "discard")
        private val ACTIVE_STATES = setOf("queued", "freezing", "running", "aligning", "awaiting-decisions", "awaiting-recovery", "completing")
    }
}
