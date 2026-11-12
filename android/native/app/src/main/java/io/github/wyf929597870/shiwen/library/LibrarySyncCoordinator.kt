package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.util.Base64
import io.github.wyf929597870.shiwen.network.NodeConnection
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import io.github.wyf929597870.shiwen.model.Canonical
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors

internal data class SnapshotCoveredOperation(val operationId: String, val recordId: String, val versionId: String)
internal data class SnapshotCoverage(val operations: List<SnapshotCoveredOperation>, val versionIds: Set<Pair<String, String>>)
internal fun coveredOperationIds(coverage: SnapshotCoverage): Set<String> = coverage.operations
    .filter { (it.recordId to it.versionId) in coverage.versionIds }
    .mapTo(linkedSetOf()) { it.operationId }

/** Compare JSON arrays by value: object key order is irrelevant, array order is preserved. */
internal fun canonicalJsonArrayEquals(left: String, right: String): Boolean = runCatching {
    fun plainJson(value: Any?): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> value.keys().asSequence().associateWith { plainJson(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plainJson(value.get(it)) }
        is Number -> value.toLong().takeIf { value.toDouble() == it.toDouble() } ?: error("non-integer JSON number")
        else -> value
    }
    Canonical.encode(plainJson(JSONArray(left))) == Canonical.encode(plainJson(JSONArray(right)))
}.getOrDefault(false)

/** Snapshot/incremental sync runner. One serialized operation per local library. */
internal class LibrarySyncCoordinator(context: Context, private val manager: LibraryManager,
    private val nodes: NodeSettingsStore) {
    private val app = context.applicationContext
    private val executor = Executors.newCachedThreadPool()
    private val running = java.util.concurrent.ConcurrentHashMap<String, CompletableFuture<*>>()

    fun connect(nodeId: String): JSONObject {
        val node = nodes.get(nodeId)
        val revision = node.getString("configRevision")
        val deviceId = manager.active().deviceId
        val identity = rpc(nodeId, revision, "identity", JSONObject().put("protocolVersion", PROTOCOL_VERSION).put("deviceId", deviceId))
        check(identity.optString("protocolVersion") == PROTOCOL_VERSION) { "MOBILE_SYNC_VERSION_UNSUPPORTED" }
        val libraryId = identity.getString("libraryId")
        UUID.fromString(libraryId)
        val repo = manager.attachRemote(libraryId, identity.getString("serverId"), identity.getString("epoch"),
            1, nodeId, revision, node.optString("name", "服务资料库"))
        val operationId = UUID.randomUUID().toString()
        if (repo.registryItem().integrity == "complete") {
            start(repo, operationId, "push") { incremental(repo, operationId, nodeId, revision) }
        } else {
            start(repo, operationId, "bootstrap") { bootstrap(repo, operationId, nodeId, revision, identity) }
        }
        return JSONObject().put("libraryId", libraryId).put("operationId", operationId).put("state", "queued")
            .put("integrity", repo.registryItem().integrity)
    }

    fun syncNow(libraryId: String, mode: String, snapshotCoverage: SnapshotCoverage? = null): JSONObject {
        require(mode in setOf("manual", "auto")) { "INVALID_SYNC_MODE" }
        val repo = manager.openLibrary(libraryId)
        val binding = JSONObject(repo.dao.meta("nodeBinding") ?: error("LIBRARY_NOT_CONNECTED"))
        val nodeId = binding.getString("nodeId")
        val revision = binding.getString("configRevision")
        val operationId = UUID.randomUUID().toString()
        if (repo.registryItem().integrity != "complete") {
            val identity = rpc(nodeId, revision, "identity", JSONObject().put("protocolVersion", PROTOCOL_VERSION).put("deviceId", repo.deviceId))
            start(repo, operationId, "bootstrap") { bootstrap(repo, operationId, nodeId, revision, identity, snapshotCoverage) }
        } else {
            start(repo, operationId, "push") { incremental(repo, operationId, nodeId, revision) }
        }
        return JSONObject().put("operationId", operationId).put("state", "queued")
    }

    fun progress(libraryId: String, operationId: String): JSONObject {
        val repo = manager.openLibrary(libraryId)
        val row = repo.dao.meta("syncProgress")?.let(::JSONObject)
        if (row == null || row.optString("operationId") != operationId) return JSONObject().put("state", "unknown")
        return row
    }

    fun status(libraryId: String): JSONObject {
        val repo = manager.openLibrary(libraryId)
        val row = repo.registryItem()
        val pendingOperations = repo.dao.pendingOutbox(100_000)
        val pending = pendingOperations.size
        val rejectedOperations = repo.dao.allOutbox().filter { isActionableRejection(it.state, it.lastError) }
        val conflicts = repo.dao.conflicts(100_000, 0).size
        val progress = repo.dao.meta("syncProgress")?.let(::JSONObject)
        return JSONObject().put("state", when {
            row.role == "standalone" -> "standalone"
            row.integrity != "complete" -> "incomplete"
            conflicts > 0 -> "conflicted"
            rejectedOperations.isNotEmpty() -> "attention"
            pending > 0 -> "idle"
            else -> "idle"
        }).put("role", row.role).put("integrity", row.integrity).put("pendingCount", pending)
            .put("rejectedCount", rejectedOperations.size)
            .put("rejectedOperations", JSONArray(rejectedOperations.map { item ->
                JSONObject().put("operationId", item.operationId).put("recordId", item.recordId)
                    .put("title", repo.dao.record(item.recordId)?.title ?: JSONObject.NULL)
                    .put("code", item.lastError ?: "UNKNOWN")
            })).put("conflictCount", conflicts).put("appliedCursor", row.appliedCursor ?: JSONObject.NULL)
            .put("completeCursor", row.completeCursor ?: JSONObject.NULL).put("lastSyncedAt", row.lastSyncedAt ?: JSONObject.NULL)
            .put("lastError", progress?.optString("error")?.takeIf { it.isNotBlank() && it != "null" } ?: pendingOperations
                .firstOrNull { it.state == "blocked-dependency" }?.let {
                    if (it.baseVersionId.isNullOrBlank()) "SYNC_PARENT_VERSION_MISSING" else "SYNC_PARENT_NOT_CONFIRMED"
                } ?: JSONObject.NULL)
    }

    fun shutdown() {
        // Do not cancel CompletableFuture directly: cancellation completes the
        // future before its runnable's finally block, which owns the per-library
        // semaphore release. Interrupt the workers instead so their finally blocks
        // release the gates after the in-flight action exits.
        executor.shutdownNow()
    }

    fun closeForTest() = shutdown()

    fun close() { executor.shutdown() }

    private fun start(repo: LibraryRepository, operationId: String, phase: String, action: () -> Unit) {
        val key = repo.libraryId
        check(LibrarySyncGates.tryAcquire(key)) { "SYNC_ALREADY_RUNNING" }
        try {
            synchronized(running) {
                check(running[key]?.isDone != false) { "SYNC_ALREADY_RUNNING" }
                putProgress(repo, operationId, "queued", phase, 0, null, null)
                running[key] = CompletableFuture.runAsync({
                    try { action() }
                    catch (e: Exception) { fail(repo, operationId, e) }
                    finally {
                        running.remove(key)
                        LibrarySyncGates.release(key)
                    }
                }, executor)
            }
        } catch (error: Exception) {
            LibrarySyncGates.release(key)
            throw error
        }
    }

    private fun bootstrap(repo: LibraryRepository, operationId: String, nodeId: String, configRevision: String,
        identity: JSONObject, snapshotCoverage: SnapshotCoverage? = null) {
        val libraryId = repo.libraryId; val epoch = identity.getString("epoch")
        setIntegrity(repo, "incomplete")
        val begin = rpc(nodeId, configRevision, "bootstrapBegin", JSONObject().put("libraryId", libraryId)
            .put("epoch", epoch).put("deviceId", repo.deviceId))
        val snapshotId = begin.getString("snapshotId")
        val highWatermarkValue = begin.opt("highWatermark") ?: error("SNAPSHOT_WATERMARK_MISSING")
        val highWatermark = cursorNumber(highWatermarkValue).toString()
        val manifest = begin.getJSONObject("manifest")
        check(manifest.optString("protocolVersion") == PROTOCOL_VERSION) { "MOBILE_SYNC_VERSION_UNSUPPORTED" }
        val expectedDigest = manifest.getString("manifestDigest")
        val types = manifest.getJSONArray("entityTypes")
        check((0 until types.length()).map { types.getString(it) } == ENTITY_ORDER) { "SNAPSHOT_ENTITY_SET_UNSUPPORTED" }
        val expectedCounts = manifest.getJSONObject("counts")
        val expectedEntityDigests = manifest.getJSONObject("entityDigests")
        val actualCounts = JSONObject()
        val actualEntityDigests = JSONObject()
        var completed = 0
        val totalLong = (0 until types.length()).sumOf { index ->
            expectedCounts.optLong(types.getString(index), -1L).also { check(it >= 0) { "SNAPSHOT_COUNT_MISSING" } }
        }
        check(totalLong <= Int.MAX_VALUE) { "SNAPSHOT_COUNT_TOO_LARGE" }
        val total = totalLong.toInt()
        for (i in 0 until types.length()) {
            val type = types.getString(i)
            check(type in ENTITY_TYPES) { "MOBILE_SYNC_ENTITY_DENIED" }
            var token: String? = null
            var itemCount = 0
            val entityHash = MessageDigest.getInstance("SHA-256")
            entityHash.update('['.code.toByte())
            do {
                val request = JSONObject().put("libraryId", libraryId).put("epoch", epoch).put("deviceId", repo.deviceId)
                    .put("snapshotId", snapshotId).put("entityType", type).put("limit", 100)
                token?.let { request.put("pageToken", it) }
                val page = rpc(nodeId, configRevision, "bootstrapPage", request)
                check(page.optString("manifestDigest") == expectedDigest && page.optString("snapshotId") == snapshotId) { "SNAPSHOT_CHANGED" }
                val items = page.getJSONArray("items")
                for (j in 0 until items.length()) {
                    var item = items.getJSONObject(j)
                    if (item.has("payloadRef")) item = downloadPayloadObject(repo, nodeId, configRevision, epoch, item)
                    if (itemCount > 0) entityHash.update(','.code.toByte())
                    entityHash.update(Canonical.encode(plain(item)).toByteArray(Charsets.UTF_8))
                    itemCount++
                    applySnapshotItem(repo, type, item)
                    completed++
                    putProgress(repo, operationId, "running", "bootstrap", completed, null, null)
                }
                token = page.optString("nextPageToken").takeIf { it.isNotBlank() && it != "null" }
            } while (token != null)
            entityHash.update(']'.code.toByte())
            actualCounts.put(type, itemCount)
            actualEntityDigests.put(type, entityHash.digest().joinToString("") { "%02x".format(it) })
            check(itemCount == expectedCounts.optInt(type, -1)) { "SNAPSHOT_COUNT_MISMATCH" }
            check(actualEntityDigests.getString(type) == expectedEntityDigests.optString(type)) { "SNAPSHOT_ENTITY_HASH_MISMATCH" }
        }
        val computedManifest = Canonical.hash(mapOf("libraryId" to libraryId, "epoch" to epoch,
            "snapshotId" to snapshotId, "highWatermark" to plain(begin.get("highWatermark")),
            "counts" to plain(expectedCounts), "entityDigests" to plain(expectedEntityDigests),
            "entityTypes" to (0 until types.length()).map { types.getString(it) },
            "protocolVersion" to manifest.getString("protocolVersion")))
        check(computedManifest == expectedDigest) { "SNAPSHOT_MANIFEST_HASH_MISMATCH" }
        downloadAttachments(repo, nodeId, configRevision, epoch, operationId)
        downloadBranchAttachments(repo, nodeId, configRevision, epoch, operationId)
        val cursor = highWatermark
        val ack = rpc(nodeId, configRevision, "ack", JSONObject().put("libraryId", libraryId).put("epoch", epoch)
            .put("deviceId", repo.deviceId).put("appliedCursor", cursorNumber(cursor)).put("completeCursor", cursorNumber(cursor))
            .put("manifestDigest", expectedDigest))
        check(cursorNumber(ack.get("completeCursor")) == cursorNumber(cursor)) { "SYNC_ACK_MISMATCH" }
        val old = manager.row(libraryId)
        manager.update(old.copy(integrity = "complete", appliedCursor = cursor, completeCursor = cursor,
            cursor = cursor, manifestDigest = expectedDigest, lastSyncedAt = Instant.now().toString()))
        snapshotCoverage?.let { markSnapshotCoveredOutbox(repo, it) }
        putProgress(repo, operationId, "completed", "finalize", completed, total, null)
    }

    /**
     * A full initialize snapshot already contains these operations' resulting versions.
     * Keep the outbox rows for audit/backup, but do not replay them against the newly
     * initialized coordinator. Only rows explicitly captured by the frozen snapshot
     * and whose exact record/version pair is in that snapshot qualify.
     */
    private fun markSnapshotCoveredOutbox(repo: LibraryRepository, coverage: SnapshotCoverage) {
        val covered = coveredOperationIds(coverage)
        repo.db.runInTransaction {
            for (captured in coverage.operations) {
                if (captured.operationId !in covered) continue
                val row = repo.dao.outbox(captured.operationId) ?: continue
                if (row.recordId != captured.recordId || row.versionId != captured.versionId) continue
                if (row.state in setOf("pending", "unknown", "blocked-dependency")) {
                    repo.dao.updateOutbox(row.copy(state = "snapshot-covered", lastError = null))
                }
            }
        }
    }

    private fun incremental(repo: LibraryRepository, operationId: String, nodeId: String, configRevision: String) {
        var row = manager.row(repo.libraryId); val epoch = row.epoch ?: error("SYNC_EPOCH_REQUIRED")
        val persistedCursor = repo.dao.meta("appliedCursor")
        if (persistedCursor != null && cursorNumber(persistedCursor) > cursorNumber(row.appliedCursor ?: "0")) {
            row = row.copy(appliedCursor = persistedCursor, cursor = persistedCursor)
            manager.update(row)
        }
        val identity = rpc(nodeId, configRevision, "identity", JSONObject().put("protocolVersion", PROTOCOL_VERSION).put("deviceId", repo.deviceId))
        check(identity.optString("libraryId") == repo.libraryId && identity.optString("epoch") == epoch) { "SYNC_IDENTITY_CHANGED" }
        val stagedAttachments = identity.optJSONObject("capabilities")?.optBoolean("stagedRecordAttachments") == true
        if (identity.optJSONObject("capabilities")?.optBoolean("dailyJournal") != true &&
            repo.dao.pendingOutbox(100_000).any { JSONObject(it.payloadJson).getJSONObject("payload").optString("kind") == "journal" })
            error("请先更新电脑端拾文，以支持同一天日记合并")
        pushOutbox(repo, nodeId, configRevision, epoch, operationId, stagedAttachments)
        var cursor = row.cursor ?: "0"
        var count = 0
        while (true) {
            val page = rpc(nodeId, configRevision, "changes", JSONObject().put("libraryId", repo.libraryId)
                .put("epoch", epoch).put("deviceId", repo.deviceId).put("cursor", cursorNumber(cursor)).put("limit", 100))
            val events = page.getJSONArray("events")
            val resolvedEvents = mutableListOf<JSONObject>()
            for (i in 0 until events.length()) {
                val event = events.getJSONObject(i)
                val ref = event.optJSONObject("recordRef")
                if (ref != null) event.put("record", downloadPayloadObject(repo, nodeId, configRevision, epoch, ref))
                val versionRef = event.optJSONObject("versionRef")
                if (versionRef != null) event.put("version", downloadPayloadObject(repo, nodeId, configRevision, epoch, versionRef))
                val activityRef = event.optJSONObject("activitiesRef")
                if (activityRef != null) event.put("activities", downloadPayloadArray(repo, nodeId, configRevision, epoch, activityRef))
                val provenanceRef = event.optJSONObject("provenanceRef")
                if (provenanceRef != null) event.put("provenance", downloadPayloadObject(repo, nodeId, configRevision, epoch, provenanceRef))
                resolvedEvents.add(event)
            }
            cursor = page.get("nextCursor").toString()
            repo.db.runInTransaction {
                resolvedEvents.forEach { applyChange(repo, it) }
                repo.dao.putMeta(LibraryMeta("appliedCursor", cursor))
            }
            count += resolvedEvents.size
            val old = manager.row(repo.libraryId)
            manager.update(old.copy(appliedCursor = cursor, cursor = cursor))
            putProgress(repo, operationId, "running", "pull", count, null, null)
            if (!page.optBoolean("hasMore")) break
        }
        downloadAttachments(repo, nodeId, configRevision, epoch, operationId)
        downloadBranchAttachments(repo, nodeId, configRevision, epoch, operationId)
        val current = manager.row(repo.libraryId)
        val appliedCursor = current.appliedCursor ?: "0"
        val ack = rpc(nodeId, configRevision, "ack", JSONObject().put("libraryId", repo.libraryId).put("epoch", epoch)
            .put("deviceId", repo.deviceId).put("appliedCursor", cursorNumber(appliedCursor))
            .put("completeCursor", cursorNumber(appliedCursor)).put("manifestDigest", current.manifestDigest ?: ""))
        check(cursorNumber(ack.get("appliedCursor")) == cursorNumber(appliedCursor) &&
            cursorNumber(ack.get("completeCursor")) == cursorNumber(appliedCursor)) { "SYNC_ACK_MISMATCH" }
        manager.update(current.copy(completeCursor = appliedCursor, lastSyncedAt = Instant.now().toString()))
        repo.dao.pendingOutbox(100_000).firstOrNull { it.state == "blocked-dependency" }?.let {
            error(if (it.baseVersionId.isNullOrBlank()) "SYNC_PARENT_VERSION_MISSING" else "SYNC_PARENT_NOT_CONFIRMED")
        }
        putProgress(repo, operationId, "completed", "finalize", count, null, null)
    }

    private fun pushOutbox(repo: LibraryRepository, nodeId: String, revision: String, epoch: String, operationId: String, stagedAttachments: Boolean) {
        repairKnownRejectedAttachmentDescriptors(repo)
        // Send a record's offline edits in dependency order. Before each POST, persist
        // the exact immutable body and mark it unknown so a lost ACK is resolved via
        // receipts before any retry. A never-sent child may be rebased only after its
        // exact parent version has been confirmed by the server.
        var completed = 0
        val pending = repo.dao.pendingOutbox(100_000)
        val byVersion = pending.associateBy { it.versionId }
        fun dependencyDepth(row: LibraryOutbox, seen: Set<String> = emptySet()): Int {
            val parentId = row.baseVersionId ?: runCatching {
                JSONObject(row.payloadJson).optJSONObject("payload")?.optJSONObject("annotationOf")?.optString("versionId")
            }.getOrNull()?.takeIf { it.isNotBlank() } ?: return 0
            val parent = byVersion[parentId] ?: return 0
            check(parent.operationId !in seen && parent.operationId != row.operationId) { "SYNC_OUTBOX_DEPENDENCY_CYCLE" }
            return 1 + dependencyDepth(parent, seen + row.operationId)
        }
        val candidates = pending.sortedWith(compareBy<LibraryOutbox>({ dependencyDepth(it) }, { it.createdAt }, { it.operationId }))
        for (candidate in candidates) {
            val id = candidate.operationId
            var row = repo.dao.outbox(id) ?: continue
            if (row.state in setOf("conflict", "rejected")) continue

            if (row.attempts > 0 || row.state == "unknown") {
                val checked = rpc(nodeId, revision, "receipts", JSONObject().put("libraryId", repo.libraryId)
                    .put("epoch", epoch).put("deviceId", repo.deviceId).put("operationIds", JSONArray().put(id)))
                    .getJSONArray("receipts")
                val saved = (0 until checked.length()).map { checked.getJSONObject(it) }
                    .firstOrNull { it.optString("operationId") == id && it.optString("status") != "unknown" }
                if (saved != null) {
                    applyPushReceipt(repo, row, saved, nodeId, revision, epoch)
                    completed++
                    continue
                }
            }

            row = rebaseUnsentChild(repo, row)
            if (row.state == "blocked-dependency") continue
            uploadAttachmentsForRecord(repo, nodeId, revision, epoch, row.recordId, JSONObject(row.payloadJson), stagedAttachments)
            row = row.copy(state = "unknown", attempts = row.attempts + 1, lastError = null)
            repo.dao.updateOutbox(row)
            val operation = JSONObject(row.payloadJson)
            val operationBytes = Canonical.encode(plain(operation)).toByteArray(Charsets.UTF_8)
            check(Canonical.hash(plain(operation)) == row.fingerprint) { "SYNC_OPERATION_FINGERPRINT_MISMATCH" }
            val pushItem = if (operationBytes.size <= MAX_INLINE_OPERATION_BYTES) {
                JSONObject().put("inlineBody", operation)
            } else {
                JSONObject().put("operationId", row.operationId).put("requestFingerprint", row.fingerprint)
                    .put("payloadReference", uploadOperationPayload(repo, nodeId, revision, epoch, row, operationBytes))
            }
            val result = rpc(nodeId, revision, "push", JSONObject().put("libraryId", repo.libraryId).put("epoch", epoch)
                .put("deviceId", repo.deviceId).put("operations", JSONArray().put(pushItem)))
            val receipts = result.getJSONArray("receipts")
            val receipt = (0 until receipts.length()).map { receipts.getJSONObject(it) }
                .firstOrNull { it.optString("operationId") == id } ?: error("SYNC_RECEIPT_MISSING")
            applyPushReceipt(repo, row, receipt, nodeId, revision, epoch)
            if (receipt.optString("status") == "rejected") {
                val code = receipt.optString("code").takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{0,63}")) } ?: "UNKNOWN"
                error("SYNC_OPERATION_REJECTED_$code")
            }
            completed++
            putProgress(repo, operationId, "running", "push", completed, candidates.size, null)
        }
    }

    /**
     * One-time compatibility repair for the old wire bug that included local-only
     * `createdAt` in strict attachment DTOs. Only a definitive server VALIDATION_ERROR
     * plus an otherwise exact descriptor matching an already-uploaded local attachment
     * qualifies. All other rejected operations remain rejected for explicit diagnosis.
     */
    internal fun repairKnownRejectedAttachmentDescriptors(repo: LibraryRepository): Int {
        val wireKeys = setOf("id", "hash", "byteLength", "name")
        val legacyKeys = wireKeys + "createdAt"
        var repaired = 0
        for (stored in repo.dao.allOutbox().filter { it.state == "rejected" && it.lastError == "VALIDATION_ERROR" }) {
            val operation = runCatching { JSONObject(stored.payloadJson) }.getOrNull() ?: continue
            if (operation.optString("operationId") != stored.operationId || operation.optString("recordId") != stored.recordId ||
                operation.optString("versionId") != stored.versionId || Canonical.hash(plain(operation)) != stored.fingerprint) continue
            val payload = operation.optJSONObject("payload") ?: continue
            if (payload.optString("id") != stored.recordId) continue
            val descriptors = payload.optJSONArray("attachmentDescriptors") ?: continue
            if (descriptors.length() == 0) continue
            var sawLegacyField = false
            var safe = true
            for (index in 0 until descriptors.length()) {
                val descriptor = descriptors.optJSONObject(index)
                if (descriptor == null) { safe = false; break }
                val keys = descriptor.keys().asSequence().toSet()
                if (keys.any { it !in legacyKeys } || !keys.containsAll(wireKeys)) { safe = false; break }
                if (keys.size > wireKeys.size) {
                    if (keys != legacyKeys) { safe = false; break }
                    sawLegacyField = true
                }
                val attachmentId = descriptor.optString("id")
                val attachment = repo.dao.attachments(stored.recordId).firstOrNull { it.id == attachmentId }
                if (attachment == null || !attachment.uploaded || !attachment.downloaded ||
                    descriptor.optString("hash") != attachment.hash || descriptor.optLong("byteLength", -1L) != attachment.byteLength ||
                    descriptor.optString("name") != attachment.name) { safe = false; break }
            }
            if (!safe || !sawLegacyField) continue
            val normalized = JSONObject(operation.toString())
            val normalizedPayload = normalized.getJSONObject("payload")
            val normalizedDescriptors = JSONArray()
            for (index in 0 until descriptors.length()) {
                val descriptor = descriptors.getJSONObject(index)
                normalizedDescriptors.put(JSONObject().put("id", descriptor.getString("id"))
                    .put("hash", descriptor.getString("hash")).put("byteLength", descriptor.getLong("byteLength"))
                    .put("name", descriptor.getString("name")))
            }
            normalizedPayload.put("attachmentDescriptors", normalizedDescriptors)
            val fingerprint = Canonical.hash(plain(normalized))
            repo.db.runInTransaction {
                val current = repo.dao.outbox(stored.operationId) ?: return@runInTransaction
                if (current.state == "rejected" && current.lastError == "VALIDATION_ERROR" &&
                    current.fingerprint == stored.fingerprint && current.payloadJson == stored.payloadJson) {
                    repo.dao.updateOutbox(current.copy(payloadJson = normalized.toString(), fingerprint = fingerprint,
                        state = "pending", lastError = null))
                    repaired++
                }
            }
        }
        return repaired
    }

    private fun uploadOperationPayload(repo: LibraryRepository, nodeId: String, revision: String, epoch: String,
        row: LibraryOutbox, bytes: ByteArray): JSONObject {
        check(bytes.size.toLong() <= MAX_CANONICAL_OPERATION_BYTES) { "SYNC_OPERATION_TOO_LARGE" }
        val digest = sha256(bytes)
        val uploadId = UUID.nameUUIDFromBytes("${repo.libraryId}\n$epoch\n${row.operationId}\n${row.fingerprint}\n$digest"
            .toByteArray(Charsets.UTF_8)).toString()
        fun context() = JSONObject().put("libraryId", repo.libraryId).put("epoch", epoch).put("deviceId", repo.deviceId)
        val begin = rpc(nodeId, revision, "operationPayloadBegin", context().put("uploadId", uploadId)
            .put("byteLength", bytes.size).put("digest", digest))
        check(begin.optString("uploadId") == uploadId && begin.optLong("byteLength") == bytes.size.toLong() &&
            begin.optString("digest") == digest) { "SYNC_OPERATION_PAYLOAD_BEGIN_MISMATCH" }
        val status = rpc(nodeId, revision, "operationPayloadStatus", context().put("uploadId", uploadId))
        check(status.optString("uploadId") == uploadId && status.optString("kind") == "operation" &&
            status.optLong("byteLength") == bytes.size.toLong() && status.optString("digest") == digest) {
            "SYNC_OPERATION_PAYLOAD_STATUS_MISMATCH"
        }
        val partBytes = status.optInt("partBytes", begin.optInt("partBytes", 0))
        check(partBytes in 1..(1024 * 1024)) { "SYNC_OPERATION_PART_SIZE_INVALID" }
        val missing = status.optJSONArray("missingParts") ?: begin.optJSONArray("missingParts") ?: JSONArray()
        val partCount = if (bytes.isEmpty()) 0 else (bytes.size + partBytes - 1) / partBytes
        for (i in 0 until missing.length()) {
            val part = missing.getInt(i)
            check(part in 0 until partCount) { "SYNC_OPERATION_PART_INDEX_INVALID" }
            val start = part * partBytes; val end = minOf(bytes.size, start + partBytes)
            val chunk = bytes.copyOfRange(start, end)
            rpc(nodeId, revision, "operationPayloadPart", context().put("uploadId", uploadId).put("part", part)
                .put("partDigest", sha256(chunk)).put("dataBase64", Base64.encodeToString(chunk, Base64.NO_WRAP)))
        }
        val committed = rpc(nodeId, revision, "operationPayloadCommit", context().put("uploadId", uploadId)
            .put("operationId", row.operationId).put("requestFingerprint", row.fingerprint))
        check(committed.optString("payloadRef") == uploadId && committed.optString("digest") == digest &&
            committed.optLong("byteLength") == bytes.size.toLong() && committed.optString("operationId") == row.operationId &&
            committed.optString("requestFingerprint") == row.fingerprint) { "SYNC_OPERATION_PAYLOAD_COMMIT_UNKNOWN" }
        return JSONObject().put("payloadRef", uploadId).put("digest", digest).put("byteLength", bytes.size)
            .put("encodingVersion", "shiwen-json-v1")
    }

    /** Repair only the never-sent empty parent produced by the old incremental reader.
     * The acknowledged revision and activity's before-content hash must both match.
     * Sent requests, genuine divergence and nonempty parent identities stay untouched.
     */
    internal fun repairMissingBaseVersion(repo: LibraryRepository, original: LibraryOutbox): LibraryOutbox {
        if (original.baseVersionId != "" || original.attempts != 0 ||
            original.state !in setOf("pending", "blocked-dependency")) return original
        val head = repo.dao.remoteHead(original.recordId) ?: return original
        if (head.versionId.isNullOrBlank() || head.revision != original.baseRevision) return original
        val operation = JSONObject(original.payloadJson)
        if (Canonical.hash(plain(operation)) != original.fingerprint ||
            operation.optString("operationId") != original.operationId ||
            operation.optString("baseVersionId") != "" || operation.optLong("baseRevision") != head.revision) return original
        val parents = operation.optJSONArray("parentVersionIds") ?: return original
        if (parents.length() != 1 || parents.optString(0) != "") return original
        val remote = JSONObject(head.recordJson)
        val beforeHash = operation.optJSONArray("activities")?.optJSONObject(0)?.optString("beforeHash")
        if (beforeHash != Canonical.hash(mapOf("markdown" to remote.optString("markdown"),
                "segments" to plain(remote.optJSONArray("sources") ?: JSONArray())))) return original
        val version = repo.dao.versions(original.recordId).firstOrNull { it.id == original.versionId } ?: return original
        if (!canonicalJsonArrayEquals(version.parentVersionIdsJson, parents.toString())) return original
        val fixedParents = JSONArray().put(head.versionId)
        operation.put("baseVersionId", head.versionId).put("parentVersionIds", fixedParents)
        val repaired = original.copy(baseVersionId = head.versionId, payloadJson = operation.toString(),
            fingerprint = Canonical.hash(plain(operation)), state = "pending", lastError = null)
        repo.db.runInTransaction {
            check(repo.dao.outbox(original.operationId) == original) { "SYNC_OUTBOX_CHANGED" }
            repo.dao.updateOutbox(repaired)
            repo.db.openHelper.writableDatabase.execSQL("UPDATE versions SET parentVersionIdsJson=? WHERE id=?",
                arrayOf(fixedParents.toString(), version.id))
            repo.dao.record(original.recordId)?.takeIf { it.versionId == original.versionId && it.baseVersionId == "" }
                ?.let { repo.dao.updateRecord(it.copy(baseVersionId = head.versionId)) }
        }
        return repaired
    }

    private fun rebaseUnsentChild(repo: LibraryRepository, stored: LibraryOutbox): LibraryOutbox {
        val original = repairMissingBaseVersion(repo, stored)
        if (original.baseVersionId == null) {
            if (original.state == "blocked-dependency") {
                val retry = original.copy(state = "pending", lastError = null)
                repo.dao.updateOutbox(retry)
                return retry
            }
            return original
        }
        if (original.attempts != 0) return original
        val head = repo.dao.remoteHead(original.recordId)
        val parent = repo.dao.outboxByVersionId(original.baseVersionId)
        if (head?.versionId != original.baseVersionId || parent != null && parent.state !in setOf("applied", "snapshot-covered")) {
            val blocked = original.copy(state = "blocked-dependency", lastError = "PARENT_NOT_CONFIRMED")
            repo.dao.updateOutbox(blocked)
            return blocked
        }
        val serverRevision = head.revision
        val body = JSONObject(original.payloadJson)
            .put("baseVersionId", head.versionId)
            .put("parentVersionIds", JSONArray().put(head.versionId))
            .put("baseRevision", serverRevision)
        val updated = original.copy(baseVersionId = head.versionId, baseRevision = serverRevision,
            payloadJson = body.toString(), fingerprint = Canonical.hash(plain(body)), state = "pending", lastError = null)
        repo.dao.updateOutbox(updated)
        return updated
    }

    private fun applyPushReceipt(repo: LibraryRepository, row: LibraryOutbox, receipt: JSONObject,
        nodeId: String, revision: String, epoch: String) {
        val status = receipt.optString("status")
        val state = when (status) {
            "applied" -> "applied"
            "conflict" -> "conflict"
            "rejected" -> "rejected"
            "blocked-dependency" -> "blocked-dependency"
            else -> "unknown"
        }
        if (status == "applied") {
            if (receipt.optBoolean("journalMerged")) {
                val record = receipt.optJSONObject("currentRecord")
                    ?: receipt.optJSONObject("currentRecordRef")?.let { downloadPayloadObject(repo, nodeId, revision, epoch, it) }
                    ?: error("JOURNAL_RECEIPT_RECORD_MISSING")
                val version = receipt.optJSONObject("currentVersion")
                    ?: receipt.optJSONObject("currentVersionRef")?.let { downloadPayloadObject(repo, nodeId, revision, epoch, it) }
                    ?: error("JOURNAL_RECEIPT_VERSION_MISSING")
                repo.acceptJournalAppend(row, receipt, record, version)
                return
            }
            val revision = receipt.optLong("revision", -1L)
            check(revision > 0) { "SYNC_RECEIPT_REVISION_MISSING" }
            val sentBody = JSONObject(row.payloadJson).getJSONObject("payload")
            val body = receipt.optJSONObject("currentRecord") ?: sentBody
            if (sentBody.optString("kind") == "ai_annotation" && body !== sentBody) {
                val local = repo.dao.record(row.recordId)
                val canonical = body.optJSONObject("annotationOf") ?: error("ANNOTATION_RELATION_MISSING")
                val existing = local?.annotationOfJson?.let(::JSONObject) ?: error("ANNOTATION_RELATION_MISSING")
                check(canonical.optString("recordId") == existing.optString("recordId") &&
                    canonical.optString("versionId") == existing.optString("versionId") && canonical.optString("contentHash") == existing.optString("contentHash")) {
                    "ANNOTATION_RELATION_CHANGED"
                }
            }
            val versionId = receipt.optString("versionId").takeIf { it.isNotBlank() } ?: row.versionId
            val changeId = receipt.optString("changeId").takeIf { it.isNotBlank() } ?: row.changeId
            repo.db.runInTransaction {
                val local = repo.dao.record(row.recordId)
                val observed = repo.dao.remoteHead(row.recordId)
                if (observed == null || revision > observed.revision || revision == observed.revision && observed.changeId == changeId) {
                    if (local != null) repo.dao.updateRecord(local.copy(serverRevision = maxOf(local.serverRevision ?: 0L, revision),
                        syncState = if (local.versionId == row.versionId && (observed == null || revision > observed.revision || observed.changeId == changeId)) "synced" else "pending"))
                    repo.dao.putRemoteHead(LibraryRemoteHead(row.recordId, revision, versionId, changeId,
                        body.optBoolean("deleted"), body.toString(), Instant.now().toString()))
                } else if (local != null) {
                    // A delayed receipt must not move the observed remote head backwards.
                    repo.dao.updateRecord(local.copy(serverRevision = maxOf(local.serverRevision ?: 0L, observed.revision), syncState = "pending"))
                    if (revision == observed.revision) repo.dao.putConflict(LibraryConflict(
                        stableConflictId(repo.libraryId, row.operationId, observed.revision, observed.changeId), row.recordId,
                        row.operationId, "{}", body.toString(), observed.recordJson, observed.revision, "open", Instant.now().toString()))
                }
                repo.dao.updateOutbox(row.copy(state = state, lastError = null))
            }
        } else if (status == "conflict") {
            val details = receipt.optJSONObject("details") ?: receipt
            val head = details.optJSONObject("currentHead")
            val currentRevision = details.optLong("currentRevision", head?.optLong("revision", -1L) ?: -1L)
            val remoteRaw = details.optJSONObject("currentRecord")
                ?: details.optJSONObject("currentRecordRef")?.let { downloadPayloadObject(repo, nodeId, revision, epoch, it) }
            val remote = remoteRaw?.let { recordJson(fromRecord(it)).put("versionId", head?.optString("versionId") ?: "")
                .put("changeId", head?.optString("changeId") ?: "") }
            val current = repo.dao.record(row.recordId)
            val localSnapshot = JSONObject().put("record", current?.let { recordJson(it) } ?: JSONObject())
                .put("version", current?.let { repo.dao.versions(row.recordId).firstOrNull { v -> v.id == it.versionId }?.docJson }
                    ?.let(::JSONObject) ?: JSONObject.NULL)
                .put("operation", JSONObject(row.payloadJson))
            val baseVersion = JSONObject(row.payloadJson).optString("baseVersionId").takeIf { it.isNotBlank() && it != "null" }
            val baseSnapshot = baseVersion?.let { versionId -> repo.dao.versions(row.recordId).firstOrNull { it.id == versionId }?.docJson }
                ?.let(::JSONObject) ?: JSONObject.NULL
            val remoteVersionRaw = details.optJSONObject("currentVersion")
                ?: details.optJSONObject("currentVersionRef")?.let { downloadPayloadObject(repo, nodeId, revision, epoch, it) }
            val remoteSnapshot = remote?.put("currentVersion", remoteVersionRaw ?: JSONObject.NULL)
                ?: details
            repo.db.runInTransaction {
                repo.dao.putConflict(LibraryConflict(
                    stableConflictId(repo.libraryId, row.operationId, currentRevision, head?.optString("changeId")),
                    row.recordId, row.operationId,
                    if (baseSnapshot == JSONObject.NULL) "{}" else baseSnapshot.toString(), localSnapshot.toString(), remoteSnapshot.toString(),
                    currentRevision.takeIf { it > 0 }, "open", Instant.now().toString()))
                if (remote != null && currentRevision > 0) {
                    val observed = repo.dao.remoteHead(row.recordId)
                    if (observed == null || currentRevision > observed.revision) {
                        repo.dao.putRemoteHead(LibraryRemoteHead(row.recordId, currentRevision,
                            head?.optString("versionId")?.takeIf { it.isNotBlank() }, head?.optString("changeId")?.takeIf { it.isNotBlank() },
                            head?.optBoolean("deleted") ?: remote.optBoolean("deleted"), remote.toString(), Instant.now().toString()))
                    }
                }
                repo.dao.updateOutbox(row.copy(state = state, lastError = receipt.optString("code").takeIf { it.isNotBlank() }))
            }
        } else {
            repo.db.runInTransaction {
                repo.dao.updateOutbox(row.copy(state = state, lastError = receipt.optString("code").takeIf { it.isNotBlank() }))
            }
        }
    }

    private fun stableConflictId(libraryId: String, operationId: String, revision: Long, changeId: String?): String =
        UUID.nameUUIDFromBytes("$libraryId\n$operationId\n$revision\n${changeId.orEmpty()}".toByteArray(Charsets.UTF_8)).toString()

    private fun uploadAttachmentsForRecord(repo: LibraryRepository, nodeId: String, revision: String, epoch: String, recordId: String,
        operation: JSONObject, stagedAttachments: Boolean) {
        val descriptors = operation.getJSONObject("payload").optJSONArray("attachmentDescriptors") ?: JSONArray()
        val required = (0 until descriptors.length()).map { descriptors.getJSONObject(it).getString("id") }.toSet()
        val attachments = repo.dao.attachments(recordId).filter { !it.uploaded && (!stagedAttachments || it.id in required) }
        val markdown = operation.getJSONObject("payload").optString("markdown")
        if (!stagedAttachments && attachments.any { it.id in required && markdown.contains("attachment:${it.id}", ignoreCase = true) })
            error("IMAGE_SYNC_SERVER_UPGRADE_REQUIRED")
        for (item in attachments) {
            check(item.downloaded && item.localRelativePath != null) { "ATTACHMENT_NOT_AVAILABLE" }
            val bytes = repo.attachmentBytes(item.id)
            val digest = sha256(bytes)
            check(bytes.size.toLong() == item.byteLength && digest == item.hash.lowercase()) { "ATTACHMENT_HASH_MISMATCH" }
            val mode = if (stagedAttachments) "\nstaged-v1" else ""
            val uploadId = UUID.nameUUIDFromBytes("${repo.libraryId}\n$nodeId\n${item.id}\n$digest$mode".toByteArray(Charsets.UTF_8)).toString()
            val begin = rpc(nodeId, revision, "blobBegin", JSONObject().put("libraryId", repo.libraryId).put("epoch", epoch)
                .put("deviceId", repo.deviceId).put("recordId", recordId).put("attachmentId", item.id).put("name", item.name)
                .put("byteLength", item.byteLength).put("digest", digest).put("uploadId", uploadId).put("stageOnly", stagedAttachments))
            check(begin.optString("uploadId") == uploadId && begin.optLong("byteLength") == item.byteLength &&
                begin.optString("digest") == digest) { "ATTACHMENT_UPLOAD_MISMATCH" }
            val partBytes = begin.optInt("partBytes", 0)
            check(partBytes in 1..(1024 * 1024)) { "ATTACHMENT_PART_SIZE_INVALID" }
            val partCount = if (bytes.isEmpty()) 0 else (bytes.size + partBytes - 1) / partBytes
            val missing = begin.optJSONArray("missingParts") ?: JSONArray((0 until partCount).toList())
            for (i in 0 until missing.length()) {
                val part = missing.getInt(i)
                check(part in 0 until partCount) { "ATTACHMENT_PART_INDEX_INVALID" }
                val start = part * partBytes; val end = minOf(bytes.size, start + partBytes)
                val chunk = bytes.copyOfRange(start, end)
                rpc(nodeId, revision, "blobPart", JSONObject().put("libraryId", repo.libraryId).put("epoch", epoch)
                    .put("deviceId", repo.deviceId).put("uploadId", uploadId).put("recordId", recordId)
                    .put("attachmentId", item.id).put("part", part).put("dataBase64", Base64.encodeToString(chunk, Base64.NO_WRAP))
                    .put("partDigest", sha256(chunk)))
            }
            val committed = rpc(nodeId, revision, "blobCommit", JSONObject().put("libraryId", repo.libraryId).put("epoch", epoch)
                .put("deviceId", repo.deviceId).put("uploadId", uploadId).put("recordId", recordId)
                .put("attachmentId", item.id).put("name", item.name))
            check(committed.optString("attachmentId") == item.id && committed.optString("recordId") == recordId &&
                committed.optString("digest") == digest && committed.optLong("byteLength") == item.byteLength) { "ATTACHMENT_COMMIT_UNKNOWN" }
            // A staged upload is not durable record state until its operation commits.
            // Keep it retryable if the staged transfer expires before the push succeeds.
            if (!stagedAttachments || !committed.optBoolean("staged")) repo.dao.putAttachment(item.copy(uploaded = true))
        }
    }

    private fun applySnapshotItem(repo: LibraryRepository, type: String, item: JSONObject) {
        val dao = repo.dao
        when (type) {
            "records" -> {
                val row = fromRecord(item)
                val existing = dao.record(row.id)
                if (existing == null) dao.insertRemoteRecord(row)
                dao.putRemoteHead(LibraryRemoteHead(row.id, 0, null, null, row.deleted, recordJson(row).toString(), Instant.now().toString()))
            }
            "heads" -> {
                val id = item.getString("recordId"); val rev = item.optLong("revision")
                dao.putRemoteHead(LibraryRemoteHead(id, rev, item.optString("versionId").takeIf { it.isNotBlank() },
                    item.optString("changeId").takeIf { it.isNotBlank() }, item.optBoolean("deleted"),
                    dao.remoteHead(id)?.recordJson ?: error("SNAPSHOT_RECORD_MISSING"), Instant.now().toString()))
                dao.putHead(LibraryHead(id, rev, item.optString("versionId").takeIf { it.isNotBlank() },
                    item.optString("changeId").takeIf { it.isNotBlank() }, item.optBoolean("deleted")))
                dao.record(id)?.let { local ->
                    val remote = dao.remoteHead(id)?.recordJson?.let(::JSONObject)?.let(::fromRecord)
                    if (remote != null && sameContent(local, remote)) dao.updateRecord(local.copy(
                        versionId = item.optString("versionId"), changeId = item.optString("changeId"),
                        serverRevision = rev, syncState = "synced"))
                    else if (remote != null) {
                        val conflictId = stableConflictId(repo.libraryId, "bootstrap:$id", rev, item.optString("changeId"))
                        if (dao.conflict(conflictId) == null) dao.putConflict(LibraryConflict(conflictId, id, "bootstrap-head",
                            "{}", recordJson(local).toString(), recordJson(remote).toString(), rev, "open", Instant.now().toString()))
                    }
                    dao.putRemoteHead(LibraryRemoteHead(id, rev, item.optString("versionId").takeIf { it.isNotBlank() },
                        item.optString("changeId").takeIf { it.isNotBlank() }, item.optBoolean("deleted"),
                        dao.remoteHead(id)?.recordJson ?: "{}", Instant.now().toString()))
                }
            }
            "versions" -> {
                val incoming = LibraryVersion(item.getString("id"), item.getString("recordId"),
                    item.optLong("revision"), item.optString("markdown"), item.optString("title"), item.optString("createdAt"),
                    item.optString("reason"), item.optString("changeId").takeIf { it.isNotBlank() }, item.optLong("serverRevision").takeIf { item.has("serverRevision") },
                    item.optJSONObject("doc")?.toString(), item.optJSONArray("sources")?.toString() ?: "[]",
                    item.optJSONArray("parentVersionIds")?.toString() ?: "[]", journalInputJson = item.optJSONObject("journalInput")?.toString())
                if (dao.insertRemoteVersion(incoming) == -1L && incoming.journalInputJson != null) {
                    val existing = dao.versions(incoming.recordId).firstOrNull { it.id == incoming.id } ?: error("SYNC_VERSION_ID_COLLISION")
                    check(existing.markdown == incoming.markdown && canonicalJsonArrayEquals(existing.sourcesJson, incoming.sourcesJson)) { "SYNC_VERSION_CONTENT_MISMATCH" }
                    if (existing.journalInputJson == null) repo.db.openHelper.writableDatabase.execSQL(
                        "UPDATE versions SET journalInputJson=? WHERE id=?", arrayOf(incoming.journalInputJson, incoming.id))
                    else check(Canonical.hash(plain(JSONObject(existing.journalInputJson))) == Canonical.hash(plain(JSONObject(incoming.journalInputJson)))) { "SYNC_VERSION_INPUT_MISMATCH" }
                }
            }
            "activities" -> dao.insertRemoteActivity(LibraryActivity(item.getString("activityId"), item.getString("recordId"),
                nullable(item, "changeId"), nullable(item, "originDeviceId"), item.getString("occurredAt"),
                item.optString("timeZone", "UTC"), item.optString("beforeHash"), item.optString("afterHash"),
                item.optJSONArray("afterSegments")?.toString() ?: "[]", item.optString("action"), item.optString("authorship"),
                item.optInt("added"), item.optInt("removed"), item.optLong("seq").takeIf { item.has("seq") }))
            "links" -> dao.putLink(LibraryLink(item.getString("articleId"), item.getString("materialId")))
            "attachments" -> dao.putAttachment(LibraryAttachment(item.getString("id"), item.getString("recordId"), item.getString("name"),
                item.getString("createdAt"), item.getString("hash"), item.optLong("byteLength"), null, false, false))
            "provenance" -> dao.putProvenance(LibraryProvenance(item.getString("recordId"), item.toString()))
            "branches" -> applyBranch(repo, item)
        }
    }

    internal fun applyChange(repo: LibraryRepository, event: JSONObject) {
        val record = event.optJSONObject("record") ?: error("SYNC_EVENT_RECORD_MISSING")
        val revision = event.optLong("revision", -1L)
        check(revision > 0) { "SYNC_EVENT_REVISION_INVALID" }
        val versionId = event.optString("versionId").takeIf { it.isNotBlank() }
        val eventChangeId = event.optString("changeId").takeIf { it.isNotBlank() }
        // Record DTOs contain content only; version identity belongs to the event envelope.
        val row = fromRecord(record).copy(serverRevision = revision, syncState = "synced",
            versionId = versionId.orEmpty(), changeId = eventChangeId.orEmpty())
        val observed = repo.dao.remoteHead(row.id)
        if (versionId != null) {
            val version = event.optJSONObject("version")
            if (version == null) {
                check(repo.dao.versions(row.id).any { it.id == versionId }) { "SYNC_EVENT_VERSION_MISSING" }
            } else {
                check(version.optString("id") == versionId && version.optString("recordId") == record.optString("id") &&
                    version.optLong("revision", -1L) == revision) { "SYNC_EVENT_VERSION_MISMATCH" }
                applySnapshotItem(repo, "versions", version)
            }
        } else {
            error("SYNC_EVENT_VERSION_ID_MISSING")
        }
        event.optJSONArray("activities")?.let { activities -> for (i in 0 until activities.length()) applySnapshotItem(repo, "activities", activities.getJSONObject(i)) }
        if (observed != null && (observed.revision > revision || observed.revision == revision && observed.changeId == eventChangeId)) return
        if (observed != null && observed.revision == revision && observed.changeId != eventChangeId) {
            val conflictId = stableConflictId(repo.libraryId, "event:${eventChangeId ?: versionId}", revision, observed.changeId)
            if (repo.dao.conflict(conflictId) == null) repo.dao.putConflict(LibraryConflict(conflictId, row.id, eventChangeId ?: "branch",
                observed.recordJson, recordJson(repo.dao.record(row.id) ?: row).toString(), recordJson(row).toString(), revision,
                "open", Instant.now().toString()))
            return
        }
        val local = repo.dao.record(row.id)
        if (local == null) repo.dao.insertRemoteRecord(row)
        else if (local.syncState == "synced" || local.syncState == "local-only" && local.localGeneration == 1L) repo.dao.updateRecord(row.copy(revision = local.revision + 1, localGeneration = local.localGeneration))
        else repo.dao.putConflict(LibraryConflict(UUID.randomUUID().toString(), row.id, event.optString("changeId"),
            repo.dao.remoteHead(row.id)?.recordJson ?: "{}", recordJson(local).toString(), recordJson(row).toString(), event.optLong("revision"), "open", Instant.now().toString()))
        val head = LibraryHead(row.id, revision, event.optString("versionId").takeIf { it.isNotBlank() },
            eventChangeId, row.deleted)
        repo.dao.putHead(head)
        repo.dao.putRemoteHead(LibraryRemoteHead(row.id, head.revision, head.versionId, head.changeId, head.deleted, recordJson(row).toString(), Instant.now().toString()))
        val descriptors = JSONArray(row.attachmentDescriptorsJson)
        for (i in 0 until descriptors.length()) {
            val descriptor = descriptors.getJSONObject(i)
            val attachmentId = descriptor.optString("id")
            if (attachmentId.isNotBlank()) repo.dao.putAttachment(LibraryAttachment(attachmentId, row.id,
                descriptor.optString("name", attachmentId), descriptor.optString("createdAt", row.updatedAt),
                descriptor.optString("hash"), descriptor.optLong("byteLength"), null, false, false))
        }
        event.optJSONObject("provenance")?.let { repo.dao.putProvenance(LibraryProvenance(row.id, it.toString())) }
        event.optJSONArray("branches")?.let { branches ->
            for (i in 0 until branches.length()) {
                applyBranch(repo, branches.getJSONObject(i))
            }
        }
        event.optJSONArray("links")?.let { links -> repo.dao.clearLinks(row.id); for (i in 0 until links.length()) applySnapshotItem(repo, "links", links.getJSONObject(i)) }
    }

    private fun applyBranch(repo: LibraryRepository, item: JSONObject) {
        val branchId = item.getString("branchId")
        UUID.fromString(branchId)
        repo.dao.putBranch(LibraryBranch(branchId, item.getString("recordId"), item.optString("state", "open"), item.toString()))
        val descriptors = item.optJSONArray("attachments") ?: JSONArray()
        for (i in 0 until descriptors.length()) {
            val descriptor = descriptors.getJSONObject(i)
            check(descriptor.optString("branchId", branchId) == branchId) { "BRANCH_ATTACHMENT_SCOPE_MISMATCH" }
            val attachmentId = descriptor.getString("id")
            repo.dao.putBranchAttachment(LibraryBranchAttachment(branchId, attachmentId, descriptor.optString("name", attachmentId),
                descriptor.optString("createdAt", item.optString("createdAt")), descriptor.getString("hash"),
                descriptor.getLong("byteLength"), null, false, false))
        }
    }

    private fun fromRecord(item: JSONObject): LibraryRecord {
        val id = item.optString("id").takeIf { it.isNotBlank() }
            ?: error("SYNC_RECORD_ID_MISSING:${item.keys().asSequence().toList().sorted().joinToString("+")}")
        return LibraryRecord(id, item.optString("kind", "idea"),
        item.optString("title"), item.optString("markdown"), item.optString("origin", "unknown"), item.optString("processing", "unknown"),
        nullable(item, "contentDay"), item.optString("dateBasis", "unknown"), nullable(item, "url"), nullable(item, "annotation"),
        nullable(item, "stage") ?: "draft", item.optJSONArray("sourceIds")?.toString() ?: "[]",
        item.optJSONArray("sources")?.toString() ?: "[]", item.optJSONArray("attachmentDescriptors")?.toString() ?: "[]",
        item.optString("createdAt"), item.optString("updatedAt"), item.optBoolean("deleted"), nullable(item, "createdByDevice"),
        item.optString("versionId"), item.optString("changeId"),
        nullable(item, "baseVersionId"), item.optLong("revision").takeIf { item.has("revision") }, 1, 1, "synced", item.optJSONObject("annotationOf")?.toString())
    }

    internal fun downloadPayloadObject(repo: LibraryRepository, nodeId: String, revision: String, epoch: String, ref: JSONObject): JSONObject =
        downloadPayloadValue(repo, nodeId, revision, epoch, ref) as? JSONObject ?: error("SYNC_PAYLOAD_TYPE_INVALID")

    private fun downloadPayloadArray(repo: LibraryRepository, nodeId: String, revision: String, epoch: String, ref: JSONObject): JSONArray =
        downloadPayloadValue(repo, nodeId, revision, epoch, ref) as? JSONArray ?: error("SYNC_PAYLOAD_TYPE_INVALID")

    private fun downloadPayloadValue(repo: LibraryRepository, nodeId: String, revision: String, epoch: String, ref: JSONObject): Any {
        val total = ref.optLong("byteLength"); require(total in 1..64L * 1024 * 1024) { "SYNC_PAYLOAD_TOO_LARGE" }
        val output = ByteArrayOutputStream(total.toInt()); var offset = 0L
        while (offset < total) {
            val length = minOf(1024L * 1024L, total - offset)
            val response = rpc(nodeId, revision, "payloadDownload", JSONObject().put("libraryId", repo.libraryId)
                .put("epoch", epoch).put("deviceId", repo.deviceId).put("payloadRef", ref.getString("payloadRef"))
                .put("offset", offset).put("byteLength", length))
            check(response.optLong("offset") == offset) { "SYNC_PAYLOAD_OFFSET_MISMATCH" }
            val chunk = Base64.decode(response.getString("dataBase64"), Base64.DEFAULT)
            val nextOffset = if (response.isNull("nextOffset")) total else response.optLong("nextOffset", -1)
            check(chunk.isNotEmpty() && chunk.size <= length && chunk.size.toLong() == nextOffset - offset && response.optBoolean("complete") == (nextOffset == total)) { "SYNC_PAYLOAD_CHUNK_INVALID" }
            output.write(chunk); offset += chunk.size
        }
        val bytes = output.toByteArray()
        check(sha256(bytes) == ref.getString("digest")) { "SYNC_PAYLOAD_HASH_MISMATCH" }
        val parsed = org.json.JSONTokener(String(bytes, Charsets.UTF_8)).nextValue()
        check(parsed is JSONObject || parsed is JSONArray) { "SYNC_PAYLOAD_TYPE_INVALID" }
        return parsed
    }

    private fun downloadAttachments(repo: LibraryRepository, nodeId: String, revision: String, epoch: String, operationId: String) {
        val items = repo.dao.attachmentsNotDownloaded()
        var done = 0
        for (attachment in items) {
            require(attachment.hash.matches(Regex("[a-fA-F0-9]{64}")) && attachment.byteLength in 0..64L * 1024 * 1024) { "ATTACHMENT_DESCRIPTOR_INVALID" }
            val dir = File(app.filesDir, "libraries/${repo.libraryId}/attachments").apply { mkdirs() }
            val target = File(dir, attachment.hash.lowercase())
            if (target.exists()) {
                check(target.length() == attachment.byteLength && sha256(target.readBytes()) == attachment.hash.lowercase()) {
                    "ATTACHMENT_TARGET_MISMATCH"
                }
            } else {
                val tempKey = sha256("${attachment.id}:${attachment.hash.lowercase()}".toByteArray(Charsets.UTF_8))
                val temp = File(dir, ".$tempKey.part")
                downloadAttachmentToTemp(repo, nodeId, revision, epoch, attachment.id, attachment.recordId,
                    attachment.name, attachment.hash, attachment.byteLength, null, temp)
                check(temp.renameTo(target)) { "ATTACHMENT_STORE_FAILED" }
            }
            repo.dao.putAttachment(attachment.copy(localRelativePath = "attachments/${target.name}", downloaded = true, uploaded = true))
            done++; putProgress(repo, operationId, "running", "attachments", done, items.size, null)
        }
    }

    private fun downloadBranchAttachments(repo: LibraryRepository, nodeId: String, revision: String, epoch: String, operationId: String) {
        val items = repo.dao.branchAttachmentsNotDownloaded()
        var completed = 0
        for (attachment in items) {
            UUID.fromString(attachment.branchId)
            require(attachment.hash.matches(Regex("[a-fA-F0-9]{64}")) && attachment.byteLength in 0..64L * 1024 * 1024) {
                "BRANCH_ATTACHMENT_DESCRIPTOR_INVALID"
            }
            val recordId = checkNotNull(repo.dao.branch(attachment.branchId)?.recordId) { "BRANCH_ATTACHMENT_RECORD_MISSING" }
            val dir = File(app.filesDir, "libraries/${repo.libraryId}/branches/${attachment.branchId}/attachments").apply { mkdirs() }
            val target = File(dir, attachment.hash.lowercase()); val temp = File(dir, ".${attachment.hash.lowercase()}.part")
            if (target.exists()) {
                check(target.length() == attachment.byteLength && sha256(target.readBytes()) == attachment.hash.lowercase()) {
                    "BRANCH_ATTACHMENT_TARGET_MISMATCH"
                }
                if (temp.exists()) temp.delete()
            } else {
                val tempKey = sha256("${attachment.branchId}:${attachment.attachmentId}:${attachment.hash.lowercase()}".toByteArray(Charsets.UTF_8))
                val resumableTemp = File(dir, ".$tempKey.part")
                if (temp.exists() && temp != resumableTemp) temp.delete()
                downloadAttachmentToTemp(repo, nodeId, revision, epoch, attachment.attachmentId, recordId,
                    attachment.name, attachment.hash, attachment.byteLength, attachment.branchId, resumableTemp)
                check(resumableTemp.renameTo(target)) { "BRANCH_ATTACHMENT_STORE_FAILED" }
            }
            repo.dao.putBranchAttachment(attachment.copy(localRelativePath = "branches/${attachment.branchId}/attachments/${target.name}",
                downloaded = true, uploaded = true))
            completed++; putProgress(repo, operationId, "running", "branch-attachments", completed, items.size, null)
        }
    }

    /** Retain only validated chunks across interruptions; final whole-file hash is authoritative. */
    private fun downloadAttachmentToTemp(repo: LibraryRepository, nodeId: String, revision: String, epoch: String,
        attachmentId: String, recordId: String, name: String, digest: String, totalBytes: Long,
        branchId: String?, temp: File) {
        temp.parentFile?.mkdirs()
        if (temp.exists() && temp.length() > totalBytes) check(temp.delete()) { "ATTACHMENT_TEMP_RESET_FAILED" }
        if (!temp.exists()) check(temp.createNewFile()) { "ATTACHMENT_TEMP_CREATE_FAILED" }
        var offset = temp.length()
        FileOutputStream(temp, true).use { stream ->
            // Empty attachments still have a protocol response to validate.
            var first = true
            while (first || offset < totalBytes) {
                first = false
                val length = minOf(1024L * 1024L, maxOf(1L, totalBytes - offset))
                val request = JSONObject().put("libraryId", repo.libraryId).put("epoch", epoch)
                    .put("deviceId", repo.deviceId).put("attachmentId", attachmentId)
                    .put("offset", offset).put("byteLength", length)
                if (branchId != null) request.put("branchId", branchId)
                val response = rpc(nodeId, revision, "blobDownload", request)
                val chunk = AttachmentChunkProtocol.decode(response, attachmentId, recordId, name, digest,
                    totalBytes, branchId, offset, length)
                stream.write(chunk)
                stream.fd.sync()
                offset += chunk.size
                if (response.optBoolean("complete")) break
            }
        }
        if (temp.length() != totalBytes || sha256(temp.readBytes()) != digest.lowercase()) {
            check(temp.delete()) { "ATTACHMENT_TEMP_CLEANUP_FAILED" }
            error("ATTACHMENT_HASH_MISMATCH")
        }
    }

    private fun rpc(nodeId: String, revision: String, action: String, request: JSONObject): JSONObject {
        return try {
            val result = NodeConnection(nodes).mobileSync(nodeId, action, request, revision)
            result.getJSONObject("data")
        } catch (error: Exception) {
            val code = error.message.orEmpty()
            if (code.matches(Regex("[A-Z][A-Z0-9_]{0,63}"))) error("SYNC_${action.uppercase()}_$code")
            throw error
        }
    }
    private fun setIntegrity(repo: LibraryRepository, integrity: String) = manager.update(manager.row(repo.libraryId).copy(integrity = integrity))
    private fun putProgress(repo: LibraryRepository, id: String, state: String, phase: String, complete: Int, total: Int?, error: String?) {
        repo.dao.putMeta(LibraryMeta("syncProgress", JSONObject().put("operationId", id).put("state", state).put("phase", phase)
            .put("completed", complete).put("total", total ?: JSONObject.NULL).put("error", error ?: JSONObject.NULL).toString()))
    }
    private fun fail(repo: LibraryRepository, id: String, error: Exception) {
        val message = error.message.orEmpty()
        val frames = error.stackTrace.filter { it.className.startsWith("io.github.wyf929597870.shiwen.library") }
            .take(3).ifEmpty { error.stackTrace.take(3) }
        val location = frames.joinToString(",") { "${it.fileName ?: "?"}:${it.lineNumber}" }.let { if (it.isBlank()) "" else "@$it" }
        val safe = message.takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{0,63}")) }
            ?: "${error.javaClass.simpleName.ifBlank { "SYNC_FAILED" }}$location"
        val phase = repo.dao.meta("syncProgress")?.let { runCatching { JSONObject(it).optString("phase") }.getOrNull() }
        putProgress(repo, id, "failed", "error", 0, null, safe)
        if (phase == "bootstrap") setIntegrity(repo, "incomplete")
    }
    private fun nullable(json: JSONObject, key: String) = json.opt(key)?.takeUnless { it == JSONObject.NULL }?.toString()
    private fun cursorNumber(value: Any): Long {
        val number = when (value) {
            is Number -> value.toLong().also { check(value.toDouble() == it.toDouble()) { "SYNC_CURSOR_INVALID" } }
            is String -> value.toLongOrNull() ?: error("SYNC_CURSOR_INVALID")
            else -> error("SYNC_CURSOR_INVALID")
        }
        check(number >= 0 && number <= 9_007_199_254_740_991L) { "SYNC_CURSOR_INVALID" }
        return number
    }
    private fun plain(value: Any?): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        else -> value
    }
    private fun recordJson(r: LibraryRecord) = JSONObject().put("id", r.id).put("title", r.title).put("markdown", r.markdown)
        .put("kind", r.kind).put("origin", r.origin).put("processing", r.processing).put("contentDay", r.contentDay ?: JSONObject.NULL)
        .put("dateBasis", r.dateBasis).put("url", r.url ?: "").put("annotation", r.annotation ?: "").put("stage", r.stage ?: "draft")
        .put("sourceIds", JSONArray(r.sourceIdsJson)).put("sources", JSONArray(r.sourcesJson))
        .put("attachmentDescriptors", JSONArray(r.attachmentDescriptorsJson)).put("createdAt", r.createdAt)
        .put("updatedAt", r.updatedAt).put("createdByDevice", r.createdByDevice ?: JSONObject.NULL).put("deleted", r.deleted)
        .apply { r.annotationOfJson?.let { put("annotationOf", JSONObject(it)) } }
    private fun sameContent(a: LibraryRecord, b: LibraryRecord): Boolean = a.id == b.id && a.title == b.title &&
        a.markdown == b.markdown && a.annotationOfJson == b.annotationOfJson && a.kind == b.kind && a.origin == b.origin && a.processing == b.processing &&
        a.contentDay == b.contentDay && a.dateBasis == b.dateBasis && a.deleted == b.deleted &&
        canonicalJsonArrayEquals(a.sourceIdsJson, b.sourceIdsJson) && canonicalJsonArrayEquals(a.sourcesJson, b.sourcesJson)
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    companion object {
        private const val PROTOCOL_VERSION = "1.0.0-draft.3"
        private const val MAX_INLINE_OPERATION_BYTES = 512 * 1024
        private const val MAX_CANONICAL_OPERATION_BYTES = 64 * 1024 * 1024
        private val ENTITY_ORDER = listOf("records", "heads", "versions", "activities", "links", "attachments", "provenance", "branches")
        private val ENTITY_TYPES = ENTITY_ORDER.toSet()
    }
}
