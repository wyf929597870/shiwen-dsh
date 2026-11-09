package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.room.Room
import io.github.wyf929597870.shiwen.model.Canonical
import io.github.wyf929597870.shiwen.probe.ProbeRepository
import io.github.wyf929597870.shiwen.probe.ProbeDraft
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest

internal data class LibraryArchiveFile(val file: File, val byteLength: Long, val sha256: String)

internal fun archiveFileInfo(file: File, maximum: Long): LibraryArchiveFile {
    check(file.isFile) { "ARCHIVE_FILE_MISSING" }
    val length = file.length()
    require(length in 1..maximum) { "ARCHIVE_ENTRY_TOO_LARGE" }
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            require(total <= maximum) { "ARCHIVE_ENTRY_TOO_LARGE" }
            digest.update(buffer, 0, count)
        }
        check(total == length) { "ARCHIVE_FILE_CHANGED" }
    }
    return LibraryArchiveFile(file, length, digest.digest().joinToString("") { "%02x".format(it) })
}

internal fun copyArchiveFile(source: LibraryArchiveFile, target: File, maximum: Long): LibraryArchiveFile {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var total = 0L
    FileInputStream(source.file).use { input -> FileOutputStream(target).use { output ->
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            require(total <= maximum) { "ARCHIVE_ENTRY_TOO_LARGE" }
            digest.update(buffer, 0, count)
            output.write(buffer, 0, count)
        }
        output.fd.sync()
    } }
    val hash = digest.digest().joinToString("") { "%02x".format(it) }
    check(total == source.byteLength && hash == source.sha256) { "ARCHIVE_FILE_INTEGRITY_FAILED" }
    return LibraryArchiveFile(target, total, hash)
}

data class LibraryContext(val libraryId: String, val pageGeneration: Long, val role: String,
    val integrity: String, val deviceId: String)

/** Durable, independent local copy for one library identity. */
class LibraryRepository internal constructor(
    context: Context,
    override val libraryId: String,
    val deviceId: String,
    private val displayName: String,
    private val registry: LibraryRegistryDatabase,
    private var registryRow: LibraryRegistryRow,
    private val p0Source: ProbeRepository? = null
) : AgentLibraryAccess {
    private val app = context.applicationContext
    val executor: ExecutorService = Executors.newSingleThreadExecutor()
    val db: LibraryDatabase = Room.databaseBuilder(app, LibraryDatabase::class.java,
        registryRow.dbFile).addMigrations(LIBRARY_MIGRATION_1_2, LIBRARY_MIGRATION_2_3, LIBRARY_MIGRATION_3_4,
            LIBRARY_MIGRATION_4_5, LIBRARY_MIGRATION_5_6, LIBRARY_MIGRATION_6_7).openHelperFactory(LargeRowOpenHelperFactory()).build()
    val dao get() = db.dao()
    fun context() = LibraryContext(libraryId, registryRow.pageGeneration, registryRow.role, registryRow.integrity, deviceId)
    fun registryItem(): LibraryRegistryRow = registryRow
    internal fun updateRegistry(row: LibraryRegistryRow) { check(row.libraryId == libraryId); registryRow = row }

    fun list(query: String = "", kind: String? = null, deleted: Boolean = false, limit: Int = 30, offset: Int = 0, excludeKind: String? = null): List<LibraryRecord> {
        require(query.length <= 200 && limit in 1..100 && offset >= 0)
        require(kind == null || kind in KINDS) { "INVALID_RECORD_KIND" }
        require(excludeKind == null || excludeKind in KINDS) { "INVALID_RECORD_KIND" }
        consolidateStandaloneJournals()
        return dao.records(query, kind, deleted, limit, offset, excludeKind)
    }

    private fun consolidateStandaloneJournals() {
        // Coordinated libraries receive the server's merge events. Independently
        // merging those same old entries here would append their text twice.
        if (registryRow.role != "standalone") return
        db.runInTransaction {
            for (day in dao.duplicateJournalDays()) {
                val records = dao.journalsForDay(day)
                val targetId = records.first().id
                for (duplicate in records.drop(1)) {
                    val target = read(targetId)
                    var markdown = duplicate.markdown
                    var sourcesText = duplicate.sourcesJson
                    val descriptors = JSONArray(target.attachmentDescriptorsJson)
                    for (image in dao.attachments(duplicate.id)) {
                        val id = UUID.randomUUID().toString()
                        markdown = markdown.replace("attachment:${image.id}", "attachment:$id")
                        sourcesText = sourcesText.replace("attachment:${image.id}", "attachment:$id")
                        dao.putAttachment(image.copy(id = id, recordId = targetId))
                        descriptors.put(JSONObject().put("id", id).put("name", image.name).put("hash", image.hash).put("byteLength", image.byteLength))
                    }
                    val sources = JSONArray(target.sourcesJson).put(JSONObject().put("text", "\n\n").put("origin", duplicate.origin))
                    val incoming = JSONArray(sourcesText)
                    for (i in 0 until incoming.length()) sources.put(incoming.getJSONObject(i))
                    update(targetId, target.revision, UUID.randomUUID().toString(), JSONObject()
                        .put("markdown", target.markdown + "\n\n" + markdown).put("sources", sources)
                        .put("attachmentDescriptors", descriptors), activityAction = "resolve")
                    update(duplicate.id, duplicate.revision, UUID.randomUUID().toString(), JSONObject().put("deleted", true), activityAction = "resolve")
                    for (link in dao.allLinks().filter { it.materialId == duplicate.id }) {
                        dao.putLink(link.copy(materialId = targetId))
                        db.openHelper.writableDatabase.execSQL("DELETE FROM links WHERE articleId=? AND materialId=?", arrayOf(link.articleId, duplicate.id))
                    }
                }
            }
        }
    }

    fun read(id: String): LibraryRecord = checkNotNull(dao.record(id)) { "RECORD_NOT_FOUND" }

    override fun searchForAgent(query: String, limit: Int): List<AgentLibraryRecord> =
        list(query = query, limit = limit).map { it.agentView() }
    override fun readForAgent(id: String): AgentLibraryRecord? = dao.record(id)?.takeUnless { it.deleted }?.agentView()
    override fun receiptForAgent(requestId: String): AgentLibraryReceipt? = dao.receipt(requestId)?.let { AgentLibraryReceipt(it.requestId, it.recordId) }
    override fun saveApprovedDraft(draft: ProbeDraft): AgentLibraryRecord {
        val input = JSONObject().put("title", draft.title).put("markdown", draft.markdown).put("kind", draft.kind)
            .put("origin", "personal").put("processing", "original")
            .put("sources", JSONArray().put(JSONObject().put("text", draft.markdown).put("origin", "personal")))
        return create(draft.requestId, input, draft.generation, allowLegacyReceipt = true).agentView()
    }

    /** requestId+fingerprint make a lost bridge acknowledgement safely replayable. */
    fun create(requestId: String, input: JSONObject, generation: Long, allowLegacyReceipt: Boolean = false,
        activityAction: String = "write", attachment: LibraryAttachment? = null,
        stagedAttachments: List<StagedLibraryAttachment> = emptyList(), annotationOperation: Boolean = false): LibraryRecord {
        require(annotationOperation == (input.optString("kind") == "ai_annotation")) { "INVALID_ANNOTATION_OPERATION" }
        UUID.fromString(requestId)
        require(generation >= 0)
        require(activityAction in setOf("write", "import", "copy", "restore", "resolve")) { "INVALID_ACTIVITY_ACTION" }
        val normalized = validateRecord(input)
        validateStagedAttachments(normalized, stagedAttachments)
        val fingerprint = Canonical.hash(mapOf("record" to plain(normalized), "generation" to generation))
        publishStagedFiles(stagedAttachments)
        return db.runInTransaction(Callable {
            dao.receipt(requestId)?.let { receipt ->
                val legacyMatch = allowLegacyReceipt && receipt.fingerprint.startsWith("p0-legacy:") &&
                    normalized.optString("origin", "personal") == "personal" &&
                    Canonical.hash(mapOf("title" to input.optString("title"), "markdown" to input.optString("markdown"),
                        "kind" to input.optString("kind", "idea"), "generation" to generation)) == receipt.fingerprint.removePrefix("p0-legacy:")
                check(receipt.fingerprint == fingerprint || legacyMatch) { "REQUEST_REUSED" }
                attachment?.let { dao.putAttachment(it.copy(recordId = receipt.recordId)) }
                dao.clearDraft("composer", requestId, generation)
                return@Callable read(receipt.recordId)
            }
            val now = Instant.now().toString()
            if (normalized.optString("kind") == "journal") {
                val day = nullable(normalized, "contentDay") ?: java.time.LocalDate.now().toString()
                java.time.LocalDate.parse(day)
                normalized.put("contentDay", day).put("dateBasis", "日记内容日期")
                val daily = dao.journalForDay(day)
                if (daily != null) {
                    val addition = normalized.getString("markdown")
                    require(addition.isNotBlank()) { "EMPTY_JOURNAL" }
                    val sources = JSONArray(daily.sourcesJson)
                    sources.put(JSONObject().put("text", "\n\n").put("origin", normalized.optString("origin", "personal")))
                    val incoming = normalized.optJSONArray("sources") ?: JSONArray().put(JSONObject()
                        .put("text", addition).put("origin", normalized.optString("origin", "personal")))
                    for (i in 0 until incoming.length()) sources.put(incoming.getJSONObject(i))
                    val descriptors = JSONArray(daily.attachmentDescriptorsJson)
                    val addedDescriptors = normalized.optJSONArray("attachmentDescriptors") ?: JSONArray()
                    for (i in 0 until addedDescriptors.length()) descriptors.put(addedDescriptors.getJSONObject(i))
                    attachment?.let { dao.putAttachment(it.copy(recordId = daily.id)) }
                    val saved = update(daily.id, daily.revision, requestId, JSONObject()
                        .put("markdown", daily.markdown + "\n\n" + addition).put("sources", sources)
                        .put("attachmentDescriptors", descriptors), activityAction = activityAction, stagedAttachments = stagedAttachments)
                    attachment?.let { dao.putAttachment(it.copy(recordId = daily.id)) }
                    // The create receipt remains bound to the submitted entry, not
                    // the full diary assembled inside this transaction.
                    dao.putReceipt(LibraryReceipt(requestId, fingerprint, daily.id, "applied", now))
                    dao.clearDraft("composer", requestId, generation)
                    return@Callable saved
                }
            }
            val recordId = normalized.optString("id").takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
            val markdown = normalized.optString("markdown")
            val title = normalized.optString("title").ifBlank { markdown.lineSequence().firstOrNull()?.take(120).orEmpty() }
            val versionId = UUID.randomUUID().toString()
            val changeId = UUID.randomUUID().toString()
            val sources = normalized.optJSONArray("sources") ?: JSONArray().put(JSONObject().put("text", markdown)
                .put("origin", normalized.optString("origin", "personal")))
            val record = LibraryRecord(recordId, normalized.optString("kind", "idea"), title, markdown,
                normalized.optString("origin", "personal"), normalized.optString("processing", "unknown"),
                nullable(normalized, "contentDay"), normalized.optString("dateBasis", "unknown"), nullable(normalized, "url"),
                nullable(normalized, "annotation"), nullable(normalized, "stage") ?: "draft",
                (normalized.optJSONArray("sourceIds") ?: JSONArray()).toString(), sources.toString(),
                (normalized.optJSONArray("attachmentDescriptors") ?: JSONArray()).toString(),
                normalized.optString("createdAt", now), normalized.optString("updatedAt", now), normalized.optBoolean("deleted"),
                normalized.optString("createdByDevice").takeIf { it.isNotBlank() } ?: deviceId,
                versionId, changeId, null, null, generation, 1, if (registryRow.role == "coordinated") "pending" else "local-only",
                normalized.optJSONObject("annotationOf")?.toString())
            val afterHash = contentHash(markdown, sources)
            val activity = LibraryActivity(UUID.randomUUID().toString(), recordId, changeId, deviceId, now,
                ZoneId.systemDefault().id, Canonical.hash(mapOf("markdown" to "", "segments" to emptyList<Any>())), afterHash,
                sources.toString(), activityAction, authorship(sources), if (activityAction in setOf("import", "copy")) 0 else WritingDelta.count(markdown), 0, null)
            dao.insertRecord(record); attachment?.let { dao.putAttachment(it.copy(recordId = recordId)) }
            persistStagedRows(recordId, stagedAttachments)
            val versionDocument = wireRecord(record).put("provenance", normalized.optJSONObject("provenance") ?: JSONObject.NULL)
            dao.insertVersion(LibraryVersion(versionId, recordId, 1, markdown, title, now, "create", changeId, null,
                versionDocument.toString(), sources.toString(), "[]"))
            normalized.optJSONObject("provenance")?.let { dao.putProvenance(LibraryProvenance(recordId, it.toString())) }
            dao.insertActivity(activity); dao.putHead(LibraryHead(recordId, 1, versionId, changeId, record.deleted))
            for (i in 0 until (normalized.optJSONArray("sourceIds") ?: JSONArray()).length()) {
                dao.putLink(LibraryLink(recordId, normalized.getJSONArray("sourceIds").getString(i)))
            }
            if (registryRow.role == "coordinated") {
                val payload = wireRecord(record)
                val opId = UUID.randomUUID().toString()
                val op = JSONObject().put("operationId", opId).put("recordId", recordId).put("changeId", changeId)
                    .put("versionId", versionId).put("baseVersionId", JSONObject.NULL).put("parentVersionIds", JSONArray())
                    .put("originDeviceId", deviceId).put("action", "create").put("baseRevision", JSONObject.NULL)
                    .put("localGeneration", generation).put("occurredAt", now).put("timeZone", ZoneId.systemDefault().id)
                    .put("payload", payload).put("activities", JSONArray().put(activityJson(activity)))
                dao.insertOutbox(LibraryOutbox(opId, recordId, changeId, versionId, null, null, generation,
                    "create", op.toString(), Canonical.hash(plain(op)), "pending", 0, now, null))
            }
            dao.putReceipt(LibraryReceipt(requestId, fingerprint, recordId, "applied", now))
            dao.clearDraft("composer", requestId, generation)
            record
        })
    }

    fun originalVersionInfo(id: String): JSONObject {
        val row = read(id)
        check(!row.deleted && row.kind != "ai_annotation") { "INVALID_ANNOTATION_PARENT" }
        val hash = MessageDigest.getInstance("SHA-256").digest(row.markdown.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        return JSONObject().put("recordId", row.id).put("versionId", row.versionId).put("contentHash", hash).put("revision", row.revision)
    }
    fun annotationCreate(originalId: String, originalVersionId: String, contentHash: String?, title: String, body: String, requestId: String,
        descriptors: JSONArray = JSONArray(), staged: List<StagedLibraryAttachment> = emptyList()): LibraryRecord {
        // Reconstruct the original request before checking its receipt, even if the
        // parent was subsequently deleted or its proven journal ID was canonicalized.
        // create() still checks the complete request fingerprint before returning it.
        val prior = dao.receipt(requestId)
        val hash = if (prior != null) {
            val priorRecord = read(prior.recordId)
            check(priorRecord.kind == "ai_annotation") { "REQUEST_REUSED" }
            contentHash ?: checkNotNull(priorRecord.annotationOfJson?.let(::JSONObject)?.optString("contentHash")) { "ANNOTATION_RELATION_MISSING" }
        } else {
            val parentRow = read(originalId)
            check(!parentRow.deleted && parentRow.kind != "ai_annotation") { "INVALID_ANNOTATION_PARENT" }
            val version = checkNotNull(dao.versions(originalId).firstOrNull { it.id == originalVersionId }) { "ORIGINAL_VERSION_MISSING" }
            val actual = MessageDigest.getInstance("SHA-256").digest(version.markdown.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
            check(contentHash == null || actual == contentHash) { "ORIGINAL_VERSION_CHANGED" }
            actual
        }
        val info = JSONObject().put("contentHash", hash)
        val parent = JSONObject().put("recordId", originalId).put("versionId", originalVersionId).put("contentHash", info.getString("contentHash"))
        return create(requestId, JSONObject().put("kind", "ai_annotation").put("origin", "ai").put("processing", "unknown")
            .put("title", title).put("markdown", body).put("annotationOf", parent).put("attachmentDescriptors", descriptors), 0, stagedAttachments = staged, annotationOperation = true)
    }
    fun annotationList(originalId: String, deleted: Boolean = false): List<LibraryRecord> {
        val parent = dao.record(originalId) ?: return emptyList()
        if (parent.deleted || parent.kind == "ai_annotation") return emptyList()
        return dao.allRecords().filter { it.kind == "ai_annotation" && it.deleted == deleted && it.annotationOfJson?.let { json -> JSONObject(json).optString("recordId") == originalId } == true }
            .sortedByDescending { it.updatedAt }
    }
    fun annotationRead(id: String): LibraryRecord = read(id).also {
        val parent = it.annotationOfJson?.let { json -> dao.record(JSONObject(json).optString("recordId")) }
        check(it.kind == "ai_annotation" && parent != null && !parent.deleted && parent.kind != "ai_annotation") { "ANNOTATION_NOT_FOUND" }
    }
    fun annotationSetDeleted(id: String, revision: Long, requestId: String, deleted: Boolean): LibraryRecord {
        if (dao.receipt(requestId) == null) check(annotationRead(id).deleted != deleted) { "ANNOTATION_STATE_CHANGED" }
        return annotationUpdate(id, revision, requestId, JSONObject().put("deleted", deleted))
    }
    fun annotationUpdate(id: String, revision: Long, requestId: String, patch: JSONObject, staged: List<StagedLibraryAttachment> = emptyList()): LibraryRecord {
        if (dao.receipt(requestId) == null) annotationRead(id)
        val keys = patch.keys().asSequence().toList()
        require(keys.all { it in setOf("title", "markdown", "deleted", "attachmentDescriptors") }) { "INVALID_ANNOTATION_FIELD" }
        return update(id, revision, requestId, patch, stagedAttachments = staged, annotationOperation = true)
    }

    fun saveDraft(requestId: String, title: String, markdown: String, kind: String, generation: Long, slot: String = "composer") {
        UUID.fromString(requestId)
        require(title.length <= 200 && markdown.length <= 1_000_000 && kind in KINDS && generation >= 0)
        val old = dao.draft(slot)
        if (old != null && old.requestId == requestId) check(generation >= old.generation) { "DRAFT_STALE" }
        if (old == null || old.requestId != requestId || generation >= old.generation)
            dao.putDraft(LibraryDraft(slot, requestId, title, markdown, kind, generation, Instant.now().toString()))
    }

    fun readDraft(slot: String = "composer"): LibraryDraft? = dao.draft(slot)
    fun receipt(requestId: String): LibraryReceipt? = dao.receipt(requestId)
    fun saveLegacyDraft(draft: ProbeDraft): LibraryRecord = saveApprovedDraft(draft).let { read(it.id) }

    fun update(id: String, expectedRevision: Long, requestId: String, patch: JSONObject,
        rebaseBase: LibraryRemoteHead? = null, activityAction: String = "write", resolveConflictId: String? = null,
        stagedAttachments: List<StagedLibraryAttachment> = emptyList(), annotationOperation: Boolean = false, allowOriginCorrection: Boolean = false): LibraryRecord {
        UUID.fromString(requestId)
        require(activityAction in setOf("write", "import", "copy", "restore", "resolve")) { "INVALID_ACTIVITY_ACTION" }
        val current = read(id)
        require(annotationOperation == (current.kind == "ai_annotation") || resolveConflictId != null) { "INVALID_ANNOTATION_OPERATION" }
        require(!patch.has("annotationOf") && (!patch.has("kind") || (patch.optString("kind") != "ai_annotation" && current.kind != "ai_annotation") || patch.optString("kind") == current.kind)) { "IMMUTABLE_RECORD_KIND" }
        require(allowOriginCorrection || !patch.has("origin") || patch.optString("origin") == current.origin) { "ORIGIN_CORRECTION_REQUIRED" }
        val fingerprint = if (rebaseBase == null && activityAction == "write" && resolveConflictId == null)
            Canonical.hash(mapOf("id" to id, "expectedRevision" to expectedRevision, "patch" to plain(patch)))
        else Canonical.hash(mapOf("id" to id, "expectedRevision" to expectedRevision, "patch" to plain(patch),
            "baseVersionId" to rebaseBase?.versionId, "baseRevision" to rebaseBase?.revision,
            "activityAction" to activityAction, "resolveConflictId" to resolveConflictId))
        dao.receipt(requestId)?.let { prior ->
            check(prior.fingerprint == fingerprint) { "REQUEST_REUSED" }
            return read(prior.recordId)
        }
        check(current.revision == expectedRevision) { "RECORD_REVISION_CONFLICT" }
        rebaseBase?.let { base ->
            check(dao.remoteHead(id)?.let { it.versionId == base.versionId && it.revision == base.revision } == true) { "CONFLICT_HEAD_CHANGED" }
        }
        val fields = localRecordJson(current)
        val keys = patch.keys()
        while (keys.hasNext()) { val key = keys.next(); require(key in EDITABLE_FIELDS || key in READ_ONLY_FIELDS) { "INVALID_RECORD_FIELD" }; if (key in EDITABLE_FIELDS) fields.put(key, patch.get(key)) }
        if (patch.has("markdown") && !patch.has("sources") && fields.optString("markdown") != current.markdown) {
            fields.put("sources", if (current.kind == "ai_annotation") JSONArray().put(JSONObject().put("text", fields.optString("markdown")).put("origin", "ai"))
                else reconcileSources(current.sourcesJson, current.markdown, fields.optString("markdown")))
        }
        val explicitOriginCorrection = patch.has("origin") && !patch.has("sources")
        if (explicitOriginCorrection) {
            val sources = fields.optJSONArray("sources") ?: JSONArray().put(JSONObject().put("text", fields.optString("markdown")))
            val origin = fields.optString("origin", "unknown")
            for (index in 0 until sources.length()) sources.put(index,
                JSONObject(sources.getJSONObject(index).toString()).put("origin", origin))
            fields.put("sources", sources)
        }
        validateRecord(fields)
        if (fields.optString("kind") == "journal" && !fields.optBoolean("deleted")) {
            val day = nullable(fields, "contentDay") ?: current.contentDay ?: java.time.LocalDate.now().toString()
            java.time.LocalDate.parse(day)
            check(dao.journalForDay(day)?.id.let { it == null || it == id }) { "JOURNAL_DAY_EXISTS" }
            fields.put("contentDay", day)
        }
        validateStagedAttachments(fields, stagedAttachments)
        if (patch.has("attachmentDescriptors")) {
            val stagedIds = stagedAttachments.map { it.id }.toSet()
            val available = dao.attachments(id).associateBy { it.id }
            val descriptors = fields.getJSONArray("attachmentDescriptors")
            for (index in 0 until descriptors.length()) {
                val descriptor = descriptors.getJSONObject(index)
                if (descriptor.getString("id") in stagedIds) continue
                val stored = checkNotNull(available[descriptor.getString("id")]) { "ATTACHMENT_NOT_FOUND" }
                check(stored.hash.equals(descriptor.getString("hash"), ignoreCase = true) &&
                    stored.byteLength == descriptor.getLong("byteLength") && stored.name == descriptor.getString("name")) { "ATTACHMENT_DESCRIPTOR_MISMATCH" }
            }
        }
        val now = Instant.now().toString(); val markdown = fields.optString("markdown")
        val revision = current.revision + 1; val change = UUID.randomUUID().toString(); val version = UUID.randomUUID().toString()
        val requestedDeleted = fields.optBoolean("deleted")
        val action = when {
            current.deleted && !requestedDeleted -> if (markdown == current.markdown) "restore" else "restore-and-update"
            requestedDeleted && !current.deleted -> "delete"
            else -> "update"
        }
        val operationBase = if (rebaseBase == null) current else current.copy(versionId = rebaseBase.versionId ?: current.versionId,
            serverRevision = rebaseBase.revision)
        // Only reference the accepted remote head in a rebased merge operation.
        // The preserved local branch remains in local history/conflict snapshots;
        // the remote server must not receive an unregistered parent version id.
        val parents = JSONArray().put(operationBase.versionId)
        val updated = current.copy(title = fields.optString("title"), markdown = markdown,
            kind = fields.optString("kind"), origin = fields.optString("origin"), processing = fields.optString("processing"),
            contentDay = nullable(fields, "contentDay"), dateBasis = fields.optString("dateBasis"), url = nullable(fields, "url"),
            annotation = nullable(fields, "annotation"), stage = nullable(fields, "stage"),
            sourceIdsJson = fields.optJSONArray("sourceIds")?.toString() ?: "[]", sourcesJson = fields.optJSONArray("sources")?.toString() ?: current.sourcesJson,
            attachmentDescriptorsJson = fields.optJSONArray("attachmentDescriptors")?.toString() ?: current.attachmentDescriptorsJson,
            updatedAt = now, deleted = fields.optBoolean("deleted"), versionId = version, changeId = change,
            baseVersionId = operationBase.versionId, serverRevision = operationBase.serverRevision,
            localGeneration = current.localGeneration + 1, revision = revision,
            syncState = if (registryRow.role == "coordinated") "pending" else "local-only")
        val effectiveActivityAction = if ((patch.has("origin") || patch.has("processing")) && markdown == current.markdown)
            "resolve" else activityAction
        val activity = LibraryActivity(UUID.randomUUID().toString(), id, change, deviceId, now,
            ZoneId.systemDefault().id, contentHash(current.markdown, JSONArray(current.sourcesJson)),
            contentHash(updated.markdown, JSONArray(updated.sourcesJson)), updated.sourcesJson, effectiveActivityAction,
            authorship(JSONArray(updated.sourcesJson)), if (effectiveActivityAction == "resolve") 0 else addedChars(current.markdown, updated.markdown),
            if (effectiveActivityAction == "resolve") 0 else removedChars(current.markdown, updated.markdown), null)
        publishStagedFiles(stagedAttachments)
        db.runInTransaction(Callable {
            dao.receipt(requestId)?.let { prior ->
                check(prior.fingerprint == fingerprint) { "REQUEST_REUSED" }
                return@Callable
            }
            check(dao.record(id)?.revision == expectedRevision) { "RECORD_REVISION_CONFLICT" }
            dao.updateRecord(updated)
            persistStagedRows(id, stagedAttachments)
            fields.optJSONObject("provenance")?.let { dao.putProvenance(LibraryProvenance(id, it.toString())) }
            dao.clearLinks(id)
            (fields.optJSONArray("sourceIds") ?: JSONArray()).let { sourceIds ->
                for (i in 0 until sourceIds.length()) dao.putLink(LibraryLink(id, sourceIds.getString(i)))
            }
            val versionDocument = wireRecord(updated).put("provenance", fields.optJSONObject("provenance") ?: JSONObject.NULL)
            dao.insertVersion(LibraryVersion(version, id, revision, markdown, updated.title, now, action, change, null,
                versionDocument.toString(), updated.sourcesJson, parents.toString()))
            dao.putHead(LibraryHead(id, revision, version, change, updated.deleted))
            dao.insertActivity(activity)
            if (registryRow.role == "coordinated") enqueueUpdate(operationBase, updated, change, version, now, action, activity, parents)
            dao.putReceipt(LibraryReceipt(requestId, fingerprint, id, "applied", now))
            resolveConflictId?.let { conflictId ->
                val conflict = checkNotNull(dao.conflict(conflictId)) { "SYNC_CONFLICT_NOT_FOUND" }
                check(conflict.state == "open" && conflict.recordId == id) { "SYNC_CONFLICT_NOT_OPEN" }
                dao.updateConflict(conflict.copy(state = "resolved-local"))
            }
        })
        return updated
    }

    fun remove(id: String, expectedRevision: Long, requestId: String): LibraryRecord = update(id, expectedRevision, requestId,
        JSONObject().put("deleted", true))

    /** Adopt the coordinator's single diary while retaining unsent local work. */
    internal fun acceptJournalAppend(sent: LibraryOutbox, receipt: JSONObject, remote: JSONObject, version: JSONObject) {
        val targetId = receipt.getString("recordId")
        val serverRevision = receipt.getLong("revision")
        check(remote.getString("id") == targetId && remote.getString("kind") == "journal" &&
            version.getString("id") == receipt.getString("versionId") && version.getString("recordId") == targetId &&
            (!receipt.has("inputVersionId") || receipt.getString("inputVersionId") == sent.versionId)) { "JOURNAL_RECEIPT_INVALID" }
        db.runInTransaction {
            val local = dao.record(sent.recordId) ?: dao.record(targetId) ?: error("RECORD_NOT_FOUND")
            val sql = db.openHelper.writableDatabase
            val pending = dao.allOutbox().filter { it.recordId == sent.recordId && it.operationId != sent.operationId &&
                it.state !in setOf("applied", "snapshot-covered") }
            val originalBody = JSONObject(sent.payloadJson).getJSONObject("payload").getString("markdown")
            val mergedChanged = remote.getString("markdown") != originalBody
            for (child in pending) {
                // Never change a request that may already have reached the server.
                if (child.attempts != 0) continue
                val op = JSONObject(child.payloadJson)
                val body = op.getJSONObject("payload")
                val base = child.baseVersionId?.let { id -> dao.versions(sent.recordId).firstOrNull { it.id == id }?.markdown }
                val appendOnly = body.optString("kind") == "journal" && child.action == "update" && base != null &&
                    body.getString("markdown").startsWith(base + "\n\n")
                op.put("recordId", targetId); body.put("id", targetId)
                val activities = op.optJSONArray("activities") ?: JSONArray()
                for (i in 0 until activities.length()) activities.getJSONObject(i).put("recordId", targetId)
                val blockedEdit = mergedChanged && !appendOnly
                dao.updateOutbox(child.copy(recordId = targetId, payloadJson = op.toString(), fingerprint = Canonical.hash(plain(op)),
                    state = if (blockedEdit) "conflict" else child.state, lastError = if (blockedEdit) "JOURNAL_EDIT_CONFLICT" else child.lastError))
                if (blockedEdit) dao.putConflict(LibraryConflict(UUID.randomUUID().toString(), targetId, child.operationId,
                    JSONObject(sent.payloadJson).getJSONObject("payload").toString(), localRecordJson(local).toString(),
                    JSONObject(remote.toString()).put("versionId", receipt.getString("versionId")).put("changeId", receipt.getString("changeId")).toString(),
                    serverRevision, "open", Instant.now().toString()))
            }
            if (sent.recordId != targetId) {
                // A coordinator receipt proves the journal alias. Preserve the exact source
                // version and hash; only its owning record changes. Uncertain operations keep
                // their original bytes until a definitive receipt is obtained.
                for (child in dao.allRecords().filter { it.kind == "ai_annotation" && it.annotationOfJson != null }) {
                    val anchor = JSONObject(child.annotationOfJson!!)
                    if (anchor.optString("recordId") != sent.recordId) continue
                    val source = dao.versions(sent.recordId).firstOrNull { it.id == anchor.optString("versionId") }
                        ?: error("ANNOTATION_SOURCE_VERSION_MISSING")
                    val digest = MessageDigest.getInstance("SHA-256").digest(source.markdown.toByteArray(Charsets.UTF_8))
                        .joinToString("") { "%02x".format(it) }
                    check(digest == anchor.optString("contentHash")) { "ANNOTATION_SOURCE_HASH_MISMATCH" }
                    anchor.put("recordId", targetId)
                    dao.updateRecord(child.copy(annotationOfJson = anchor.toString()))
                    for (childVersion in dao.versions(child.id)) {
                        val doc = childVersion.docJson?.let(::JSONObject) ?: continue
                        val versionAnchor = doc.optJSONObject("annotationOf") ?: continue
                        if (versionAnchor.optString("recordId") == sent.recordId && versionAnchor.optString("versionId") == anchor.getString("versionId") &&
                            versionAnchor.optString("contentHash") == anchor.getString("contentHash")) {
                            versionAnchor.put("recordId", targetId)
                            sql.execSQL("UPDATE versions SET docJson=? WHERE id=?", arrayOf(doc.toString(), childVersion.id))
                        }
                    }
                    for (operation in dao.allOutbox().filter { it.recordId == child.id &&
                        it.attempts == 0 && it.state in setOf("pending", "blocked-dependency") }) {
                        val payload = JSONObject(operation.payloadJson)
                        val operationAnchor = payload.getJSONObject("payload").optJSONObject("annotationOf") ?: continue
                        if (operationAnchor.optString("recordId") != sent.recordId || operationAnchor.optString("versionId") != anchor.getString("versionId") ||
                            operationAnchor.optString("contentHash") != anchor.getString("contentHash")) continue
                        operationAnchor.put("recordId", targetId)
                        dao.updateOutbox(operation.copy(payloadJson = payload.toString(), fingerprint = Canonical.hash(plain(payload)),
                            state = "pending", attempts = 0, lastError = null))
                    }
                }
                // These rows keep their original IDs; only diary ownership changes.
                for (table in listOf("versions", "activities", "attachments", "receipts", "conflicts", "branches", "outbox"))
                    sql.execSQL("UPDATE $table SET recordId=? WHERE recordId=?", arrayOf(targetId, sent.recordId))
                for (stored in dao.versions(targetId)) {
                    val doc = stored.docJson?.let(::JSONObject) ?: continue
                    if (doc.optString("id") == sent.recordId) { doc.put("id", targetId)
                        sql.execSQL("UPDATE versions SET docJson=? WHERE id=?", arrayOf(doc.toString(), stored.id)) }
                }
                sql.execSQL("INSERT OR IGNORE INTO links(articleId,materialId) SELECT articleId,? FROM links WHERE materialId=?", arrayOf(targetId, sent.recordId))
                sql.execSQL("DELETE FROM links WHERE materialId=?", arrayOf(sent.recordId))
                dao.provenance(sent.recordId)?.let { if (dao.provenance(targetId) == null) dao.putProvenance(it.copy(recordId = targetId)) }
                for (table in listOf("heads", "remote_heads", "provenance")) sql.execSQL("DELETE FROM $table WHERE recordId=?", arrayOf(sent.recordId))
                sql.execSQL("DELETE FROM records WHERE id=?", arrayOf(sent.recordId))
            }
            val observed = dao.remoteHead(targetId)
            val effectiveRemote = if (observed != null && observed.revision > serverRevision) JSONObject(observed.recordJson) else remote
            val effectiveRevision = maxOf(serverRevision, observed?.revision ?: 0L)
            val remoteRow = local.copy(id = targetId, title = effectiveRemote.optString("title"), markdown = effectiveRemote.getString("markdown"),
                origin = effectiveRemote.getString("origin"), contentDay = nullable(effectiveRemote, "contentDay"), dateBasis = effectiveRemote.getString("dateBasis"),
                processing = effectiveRemote.getString("processing"), url = nullable(effectiveRemote, "url"), annotation = nullable(effectiveRemote, "annotation"),
                stage = nullable(effectiveRemote, "stage"), sourceIdsJson = effectiveRemote.getJSONArray("sourceIds").toString(),
                createdByDevice = nullable(effectiveRemote, "createdByDevice"), baseVersionId = null,
                sourcesJson = effectiveRemote.getJSONArray("sources").toString(), attachmentDescriptorsJson = effectiveRemote.getJSONArray("attachmentDescriptors").toString(),
                createdAt = effectiveRemote.getString("createdAt"), updatedAt = effectiveRemote.getString("updatedAt"), deleted = false,
                versionId = if (effectiveRevision > serverRevision) observed!!.versionId!! else receipt.getString("versionId"),
                changeId = if (effectiveRevision > serverRevision) observed!!.changeId!! else receipt.getString("changeId"),
                revision = local.revision + 1, serverRevision = effectiveRevision, syncState = "synced")
            val adopted = if (pending.isEmpty()) remoteRow else local.copy(id = targetId, serverRevision = effectiveRevision, syncState = "pending")
            if (dao.record(targetId) == null) dao.insertRecord(adopted) else dao.updateRecord(adopted)
            if (receipt.has("inputVersionId")) {
                val inputVersion = dao.versions(targetId).firstOrNull { it.id == sent.versionId } ?: error("JOURNAL_INPUT_VERSION_MISSING")
                check(inputVersion.markdown == originalBody) { "JOURNAL_INPUT_VERSION_MISMATCH" }
                sql.execSQL("UPDATE versions SET revision=?,serverRevision=?,journalInputJson=? WHERE id=?", arrayOf<Any>(receipt.getLong("inputVersionRevision"), receipt.getLong("inputVersionRevision"), JSONObject(sent.payloadJson).getJSONObject("payload").toString(), sent.versionId))
            }
            val localVersion = dao.versions(targetId).firstOrNull { it.id == version.getString("id") }
            if (localVersion != null && localVersion.markdown != version.getString("markdown")) {
                dao.insertVersion(localVersion.copy(id = UUID.randomUUID().toString(), reason = "同步前本地日记", changeId = null))
                sql.execSQL("DELETE FROM versions WHERE id=?", arrayOf(localVersion.id))
            }
            dao.insertRemoteVersion(LibraryVersion(version.getString("id"), targetId, version.getLong("revision"), version.getString("markdown"),
                version.getString("title"), version.getString("createdAt"), version.getString("reason"), receipt.getString("changeId"), serverRevision,
                remote.toString(), version.getJSONArray("sources").toString(), version.getJSONArray("parentVersionIds").toString(), false, false,
                if (receipt.has("inputVersionId")) JSONObject(sent.payloadJson).getJSONObject("payload").toString() else null))
            dao.putHead(LibraryHead(targetId, adopted.revision, adopted.versionId, adopted.changeId, adopted.deleted))
            if (observed == null || serverRevision >= observed.revision) dao.putRemoteHead(LibraryRemoteHead(targetId, serverRevision,
                receipt.getString("versionId"), receipt.getString("changeId"), false, remote.toString(), Instant.now().toString()))
            val descriptors = remote.getJSONArray("attachmentDescriptors")
            val owned = dao.attachments(targetId).map { it.id }.toSet()
            for (i in 0 until descriptors.length()) { val descriptor = descriptors.getJSONObject(i)
                if (descriptor.getString("id") !in owned) dao.putAttachment(LibraryAttachment(descriptor.getString("id"), targetId,
                    descriptor.getString("name"), remote.getString("updatedAt"), descriptor.getString("hash"), descriptor.getLong("byteLength"), null, false, true))
            }
            dao.updateOutbox(sent.copy(recordId = targetId, state = "applied", lastError = null))
        }
    }

    /** Resolve a conflict by accepting the exact remote head after a revision check. */
    fun resolveConflictRemote(conflictId: String, expectedRevision: Long, requestId: String): LibraryRecord {
        UUID.fromString(requestId)
        val conflict = checkNotNull(dao.conflict(conflictId)) { "SYNC_CONFLICT_NOT_FOUND" }
        val fingerprint = Canonical.hash(mapOf("conflictId" to conflictId, "resolution" to "keep-remote", "expectedRevision" to expectedRevision))
        dao.receipt(requestId)?.let { prior ->
            check(prior.fingerprint == fingerprint) { "REQUEST_REUSED" }
            return read(prior.recordId)
        }
        val current = read(conflict.recordId)
        val knownHead = dao.remoteHead(current.id)
        check(conflict.state == "open" && conflict.remoteRevision == expectedRevision &&
            (knownHead == null || knownHead.revision <= expectedRevision)) { "CONFLICT_HEAD_CHANGED" }
        val conflictValue = JSONObject(conflict.remoteJson)
        val conflictRecord = conflictValue.optJSONObject("record") ?: conflictValue.takeIf { it.has("id") }
        val remote = validateRecord(conflictRecord ?: knownHead?.takeIf { it.revision == expectedRevision }
            ?.let { JSONObject(it.recordJson) } ?: error("SYNC_REMOTE_RECORD_MISSING"))
        check(remote.optString("id") == current.id) { "SYNC_REMOTE_RECORD_INVALID" }
        if (current.kind == "ai_annotation" || remote.optString("kind") == "ai_annotation") {
            val localAnchor = current.annotationOfJson?.let(::JSONObject)
            val remoteAnchor = remote.optJSONObject("annotationOf")
            check(current.kind == "ai_annotation" && remote.optString("kind") == "ai_annotation" &&
                localAnchor != null && remoteAnchor != null && Canonical.hash(plain(localAnchor)) == Canonical.hash(plain(remoteAnchor))) {
                "ANNOTATION_RELATION_CHANGED"
            }
        } else check(!remote.has("annotationOf") || remote.isNull("annotationOf")) { "ANNOTATION_RELATION_CHANGED" }
        val remoteVersionId = remote.optString("versionId").takeIf { it.isNotBlank() }
            ?: knownHead?.takeIf { it.revision == expectedRevision }?.versionId ?: error("SYNC_REMOTE_VERSION_MISSING")
        val remoteChangeId = remote.optString("changeId").takeIf { it.isNotBlank() }
            ?: knownHead?.takeIf { it.revision == expectedRevision }?.changeId ?: current.changeId
        val remoteVersion = remote.optJSONObject("currentVersion")
        val remoteDoc = remoteVersion?.optJSONObject("doc") ?: remoteVersion?.takeIf { it.has("provenance") }
        val remoteProvenance = remote.optJSONObject("provenance") ?: remoteDoc?.optJSONObject("provenance")
        val nextRevision = current.revision + 1
        val now = Instant.now().toString()
        val next = current.copy(kind = remote.optString("kind"), title = remote.optString("title"), markdown = remote.optString("markdown"),
            origin = remote.optString("origin", "unknown"), processing = remote.optString("processing", "unknown"),
            contentDay = nullable(remote, "contentDay"), dateBasis = remote.optString("dateBasis", "unknown"),
            url = nullable(remote, "url"), annotation = nullable(remote, "annotation"), stage = nullable(remote, "stage") ?: "draft",
            sourceIdsJson = remote.optJSONArray("sourceIds")?.toString() ?: "[]", sourcesJson = remote.optJSONArray("sources")?.toString() ?: "[]",
            attachmentDescriptorsJson = remote.optJSONArray("attachmentDescriptors")?.toString() ?: "[]",
            updatedAt = remote.optString("updatedAt", now), deleted = remote.optBoolean("deleted"),
            versionId = remoteVersionId, changeId = remoteChangeId,
            baseVersionId = null, serverRevision = expectedRevision, localGeneration = current.localGeneration + 1,
            revision = nextRevision, syncState = "synced")
        val nowActivity = LibraryActivity(UUID.randomUUID().toString(), current.id, next.changeId, deviceId, now,
            ZoneId.systemDefault().id, contentHash(current.markdown, JSONArray(current.sourcesJson)),
            contentHash(next.markdown, JSONArray(next.sourcesJson)), next.sourcesJson, "resolve", authorship(JSONArray(next.sourcesJson)), 0, 0, null)
        db.runInTransaction {
            dao.receipt(requestId)?.let { prior ->
                check(prior.fingerprint == fingerprint) { "REQUEST_REUSED" }
                return@runInTransaction
            }
            val latest = checkNotNull(dao.conflict(conflictId)) { "SYNC_CONFLICT_NOT_FOUND" }
            val latestHead = dao.remoteHead(current.id)
            check(latest.state == "open" && latest.remoteRevision == expectedRevision &&
                (latestHead == null || latestHead.revision <= expectedRevision)) {
                "CONFLICT_HEAD_CHANGED"
            }
            dao.updateRecord(next)
            dao.clearLinks(current.id)
            for (i in 0 until (remote.optJSONArray("sourceIds") ?: JSONArray()).length())
                dao.putLink(LibraryLink(current.id, remote.getJSONArray("sourceIds").getString(i)))
            remoteProvenance?.let { dao.putProvenance(LibraryProvenance(current.id, it.toString())) }
            val versionId = next.versionId
            if (dao.versions(current.id).none { it.id == versionId }) {
                val parents = remoteVersion?.optJSONArray("parentVersionIds")?.let { JSONArray(it.toString()) } ?: JSONArray()
                dao.insertVersion(LibraryVersion(versionId, current.id, remoteVersion?.optLong("revision") ?: expectedRevision,
                    remoteVersion?.optString("markdown") ?: next.markdown, remoteVersion?.optString("title") ?: next.title,
                    remoteVersion?.optString("createdAt") ?: now, remoteVersion?.optString("reason") ?: "resolve-remote",
                    next.changeId, expectedRevision,
                    remoteDoc?.toString() ?: wireRecord(next).put("provenance", remoteProvenance ?: JSONObject.NULL).toString(),
                    remoteVersion?.optJSONArray("sources")?.toString() ?: next.sourcesJson, parents.toString()))
            }
            dao.putHead(LibraryHead(current.id, remoteVersion?.optLong("revision") ?: expectedRevision,
                versionId, next.changeId, next.deleted))
            dao.putRemoteHead(LibraryRemoteHead(current.id, expectedRevision, remoteVersionId, remoteChangeId,
                next.deleted, wireRecord(next).toString(), now))
            dao.insertActivity(nowActivity)
            dao.putConflict(latest.copy(state = "resolved-remote"))
            // The user explicitly chose the service branch. Retire this record's
            // unconfirmed local chain so blocked successors cannot linger forever
            // or be sent against a branch the user just rejected.
            dao.allOutbox().filter { it.recordId == current.id && it.state in
                setOf("pending", "unknown", "conflict", "blocked-dependency") }.forEach { pending ->
                dao.updateOutbox(pending.copy(state = "rejected", lastError = "CONFLICT_DISCARDED"))
            }
            dao.putReceipt(LibraryReceipt(requestId, fingerprint, current.id, "applied", now))
        }
        return next
    }

    fun versions(id: String): List<LibraryVersion> { check(dao.record(id) != null) { "RECORD_NOT_FOUND" }; return dao.versions(id) }

    fun importMarkdown(requestId: String, title: String, markdown: String, metadata: JSONObject = JSONObject(),
        originalName: String? = null, originalBytes: ByteArray? = null, activityAction: String = "write"): LibraryRecord {
        require(markdown.length <= 1_000_000 && title.length <= 200 && markdown.isNotBlank()) { "INVALID_MARKDOWN_IMPORT" }
        require((originalBytes == null) == (originalName == null)) { "IMPORT_ORIGINAL_INCOMPLETE" }
        require(originalBytes == null || originalBytes.size <= 64 * 1024 * 1024) { "IMPORT_ORIGINAL_TOO_LARGE" }
        // A file picker callback can be delivered again after a process/bridge ACK was
        // lost. Timestamps are generated below, so compare the caller's stable import
        // intent against the applied record before constructing a new fingerprint.
        dao.receipt(requestId)?.let { prior ->
            val old = read(prior.recordId)
            val expectedKind = metadata.optString("kind", "reference")
            val expectedOrigin = metadata.optString("origin", "external")
            val expectedProcessing = metadata.optString("processing", "original")
            val expectedTitle = title.ifBlank { markdown.lineSequence().firstOrNull()?.take(120).orEmpty() }
            check(old.title == expectedTitle && old.markdown == markdown && old.kind == expectedKind &&
                old.origin == expectedOrigin && old.processing == expectedProcessing) { "REQUEST_REUSED" }
            for (field in listOf("contentDay", "dateBasis", "url", "annotation", "stage")) {
                if (!metadata.has(field)) continue
                val expected = nullable(metadata, field)
                val actual = when (field) {
                    "contentDay" -> old.contentDay
                    "dateBasis" -> old.dateBasis
                    "url" -> old.url
                    "annotation" -> old.annotation
                    else -> old.stage
                }
                check(actual == expected) { "REQUEST_REUSED" }
            }
            metadata.optJSONArray("sources")?.let { check(Canonical.hash(plain(it)) == Canonical.hash(plain(JSONArray(old.sourcesJson)))) { "REQUEST_REUSED" } }
            metadata.optJSONArray("sourceIds")?.let { check(Canonical.hash(plain(it)) == Canonical.hash(plain(JSONArray(old.sourceIdsJson)))) { "REQUEST_REUSED" } }
            val existingAction = dao.activities(old.id).firstOrNull { it.changeId == old.changeId }?.action
            check(existingAction == activityAction) { "REQUEST_REUSED" }
            if (originalBytes != null) {
                val digest = sha256(originalBytes)
                val expectedId = UUID.nameUUIDFromBytes("$libraryId\n$requestId\n$digest".toByteArray(Charsets.UTF_8)).toString()
                val descriptor = JSONArray(old.attachmentDescriptorsJson).let { rows ->
                    (0 until rows.length()).map { rows.getJSONObject(it) }.firstOrNull { it.optString("id") == expectedId }
                }
                val expectedName = sanitizeFileName(originalName ?: "")
                check(descriptor != null && descriptor.optString("hash") == digest && descriptor.optLong("byteLength") == originalBytes.size.toLong() &&
                    descriptor.optString("name") == expectedName) { "REQUEST_REUSED" }
                val stored = dao.attachments(old.id).firstOrNull { it.id == expectedId }
                check(stored != null && stored.hash == digest && stored.byteLength == originalBytes.size.toLong() && stored.name == expectedName) { "REQUEST_REUSED" }
            }
            if (originalBytes == null) metadata.optJSONArray("attachmentDescriptors")?.let {
                check(Canonical.hash(plain(it)) == Canonical.hash(plain(JSONArray(old.attachmentDescriptorsJson)))) { "REQUEST_REUSED" }
            }
            return old
        }
        val attachments = metadata.optJSONArray("attachmentDescriptors")?.let { JSONArray(it.toString()) } ?: JSONArray()
        val sourceName = originalName?.let { sanitizeFileName(it) }
        val rawHash = originalBytes?.let(::sha256)
        val attachmentId = if (rawHash != null) UUID.nameUUIDFromBytes("$libraryId\n$requestId\n$rawHash".toByteArray(Charsets.UTF_8)).toString() else null
        val createdAt = Instant.now().toString()
        if (rawHash != null && attachmentId != null && sourceName != null) {
            attachments.put(JSONObject().put("id", attachmentId).put("name", sourceName).put("createdAt", createdAt)
                .put("hash", rawHash).put("byteLength", originalBytes!!.size))
        }
        val provenance = metadata.optJSONObject("provenance")?.let { JSONObject(it.toString()) } ?: JSONObject()
        if (sourceName != null && rawHash != null && attachmentId != null) {
            val import = provenance.optJSONObject("import")?.let { JSONObject(it.toString()) } ?: JSONObject()
            import.put("sourceName", sourceName).put("originalAttachmentId", attachmentId).put("hash", rawHash)
                .put("byteLength", originalBytes!!.size)
            import.put("files", JSONArray().put(JSONObject().put("attachmentId", attachmentId).put("relativePath", sourceName)
                .put("hash", rawHash).put("byteLength", originalBytes.size)))
            provenance.put("import", import)
        }
        val metadataSources = metadata.optJSONArray("sources")?.let { JSONArray(it.toString()) }
        val origin = metadata.optString("origin", "external")
        val record = JSONObject(metadata.toString()).put("title", title).put("markdown", markdown)
            .put("kind", metadata.optString("kind", "reference")).put("origin", origin)
            .put("processing", metadata.optString("processing", "original"))
            .put("sources", metadataSources ?: JSONArray().put(JSONObject().put("text", markdown).put("origin", origin)))
            .put("attachmentDescriptors", attachments).put("provenance", provenance)
        if (originalBytes != null && rawHash != null && attachmentId != null && sourceName != null)
            storeAttachmentFile(attachmentId, sourceName, createdAt, rawHash, originalBytes)
        val attachment = if (originalBytes != null && rawHash != null && attachmentId != null && sourceName != null)
            LibraryAttachment(attachmentId, "", sourceName, createdAt, rawHash, originalBytes.size.toLong(), "attachments/$rawHash", true, false)
        else null
        return create(requestId, record, metadata.optLong("localGeneration", 0), activityAction = activityAction, attachment = attachment)
    }

    fun exportMarkdown(recordId: String): Pair<String, ByteArray> {
        val row = read(recordId)
        val filename = row.title.ifBlank { row.id }.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(120) + ".md"
        return filename to row.markdown.toByteArray(Charsets.UTF_8)
    }

    fun attachmentBytes(attachmentId: String): ByteArray {
        val row = dao.attachmentsNotDownloaded().firstOrNull { it.id == attachmentId }
            ?: dao.allAttachments().firstOrNull { it.id == attachmentId } ?: error("ATTACHMENT_NOT_FOUND")
        val relative = row.localRelativePath ?: error("ATTACHMENT_NOT_AVAILABLE")
        require(relative == "attachments/${row.hash.lowercase()}") { "ATTACHMENT_PATH_INVALID" }
        val file = File(app.filesDir, "libraries/$libraryId/$relative")
        check(file.isFile && file.length() == row.byteLength && sha256(file.readBytes()) == row.hash.lowercase()) { "ATTACHMENT_INTEGRITY_FAILED" }
        return file.readBytes()
    }

    internal fun attachmentArchiveFile(attachmentId: String): LibraryArchiveFile {
        val row = dao.attachmentsNotDownloaded().firstOrNull { it.id == attachmentId }
            ?: dao.allAttachments().firstOrNull { it.id == attachmentId } ?: error("ATTACHMENT_NOT_FOUND")
        val relative = row.localRelativePath ?: error("ATTACHMENT_NOT_AVAILABLE")
        require(relative == "attachments/${row.hash.lowercase()}") { "ATTACHMENT_PATH_INVALID" }
        val file = File(app.filesDir, "libraries/$libraryId/$relative")
        val payload = archiveFileInfo(file, row.byteLength)
        check(payload.byteLength == row.byteLength && payload.sha256 == row.hash.lowercase()) { "ATTACHMENT_INTEGRITY_FAILED" }
        return payload
    }

    fun branchAttachmentBytes(branchId: String, attachmentId: String): ByteArray {
        UUID.fromString(branchId)
        val row = checkNotNull(dao.branchAttachment(branchId, attachmentId)) { "BRANCH_ATTACHMENT_NOT_FOUND" }
        val relative = row.localRelativePath ?: error("BRANCH_ATTACHMENT_NOT_AVAILABLE")
        require(relative == "branches/$branchId/attachments/${row.hash.lowercase()}") { "BRANCH_ATTACHMENT_PATH_INVALID" }
        val file = File(app.filesDir, "libraries/$libraryId/$relative")
        check(file.isFile && file.length() == row.byteLength && sha256(file.readBytes()) == row.hash.lowercase()) { "BRANCH_ATTACHMENT_INTEGRITY_FAILED" }
        return file.readBytes()
    }

    internal fun branchAttachmentArchiveFile(branchId: String, attachmentId: String): LibraryArchiveFile {
        UUID.fromString(branchId)
        val row = checkNotNull(dao.branchAttachment(branchId, attachmentId)) { "BRANCH_ATTACHMENT_NOT_FOUND" }
        val relative = row.localRelativePath ?: error("BRANCH_ATTACHMENT_NOT_AVAILABLE")
        require(relative == "branches/$branchId/attachments/${row.hash.lowercase()}") { "BRANCH_ATTACHMENT_PATH_INVALID" }
        val file = File(app.filesDir, "libraries/$libraryId/$relative")
        val payload = archiveFileInfo(file, row.byteLength)
        check(payload.byteLength == row.byteLength && payload.sha256 == row.hash.lowercase()) { "BRANCH_ATTACHMENT_INTEGRITY_FAILED" }
        return payload
    }

    private fun storeAttachmentFile(id: String, name: String, createdAt: String, hash: String, bytes: ByteArray) {
        require(hash.matches(Regex("[a-f0-9]{64}")) && sha256(bytes) == hash) { "ATTACHMENT_HASH_MISMATCH" }
        val dir = File(app.filesDir, "libraries/$libraryId/attachments").apply { mkdirs() }
        val target = File(dir, hash)
        if (target.exists()) {
            check(target.length() == bytes.size.toLong() && sha256(target.readBytes()) == hash) { "ATTACHMENT_TARGET_MISMATCH" }
            return
        }
        val temp = File(dir, ".$hash.import.part")
        temp.writeBytes(bytes)
        check(temp.renameTo(target)) { "ATTACHMENT_STORE_FAILED" }
    }

    private fun validateStagedAttachments(record: JSONObject, staged: List<StagedLibraryAttachment>) {
        require(staged.size <= 10 && staged.sumOf { it.byteLength } <= 32L * 1024 * 1024) { "TOO_MANY_IMAGES_SELECTED" }
        val unique = staged.associateBy { it.id }
        require(unique.size == staged.size) { "ATTACHMENT_STAGE_DUPLICATE" }
        val descriptors = record.optJSONArray("attachmentDescriptors") ?: JSONArray()
        val described = (0 until descriptors.length()).associate { index ->
            val item = descriptors.getJSONObject(index)
            item.getString("id") to item
        }
        require(described.size == descriptors.length()) { "ATTACHMENT_DESCRIPTOR_DUPLICATE" }
        for (item in staged) {
            val descriptor = checkNotNull(described[item.id]) { "ATTACHMENT_DESCRIPTOR_MISSING" }
            check(descriptor.optString("name") == item.name &&
                descriptor.optString("hash").equals(item.hash, ignoreCase = true) &&
                descriptor.optLong("byteLength", -1) == item.byteLength) { "ATTACHMENT_DESCRIPTOR_MISMATCH" }
            check(item.byteLength == item.bytes.size.toLong() &&
                LibraryAttachmentDraftStore.sha256(item.bytes) == item.hash &&
                LibraryAttachmentDraftStore.imageMime(item.bytes) == item.mimeType) { "ATTACHMENT_STAGE_INTEGRITY_FAILED" }
        }
    }

    /** Publish content-addressed files before the Room transaction; failures can leave only an unreferenced file. */
    private fun publishStagedFiles(staged: List<StagedLibraryAttachment>) {
        for (item in staged) {
            storeAttachmentFile(item.id, item.name, Instant.now().toString(), item.hash, item.bytes)
        }
    }

    private fun persistStagedRows(recordId: String, staged: List<StagedLibraryAttachment>) {
        val now = Instant.now().toString()
        for (item in staged) dao.putAttachment(LibraryAttachment(item.id, recordId, item.name, now, item.hash,
            item.byteLength, "attachments/${item.hash}", true, false))
    }

    private fun sanitizeFileName(value: String): String {
        val safe = value.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().take(180)
        require(safe.isNotBlank() && safe != "." && safe != "..") { "IMPORT_FILENAME_INVALID" }
        return safe
    }

    fun archiveSnapshot(): JSONObject = db.runInTransaction(Callable { archiveSnapshotAtCut() })

    private fun archiveSnapshotAtCut(): JSONObject {
        fun activity(a: LibraryActivity) = JSONObject().put("activityId", a.activityId).put("recordId", a.recordId)
            .put("changeId", a.changeId ?: JSONObject.NULL).put("originDeviceId", a.originDeviceId)
            .put("occurredAt", a.occurredAt).put("timeZone", a.timeZone).put("beforeHash", a.beforeHash)
            .put("afterHash", a.afterHash).put("afterSegments", JSONArray(a.afterSegmentsJson)).put("action", a.action)
            .put("authorship", a.authorship).put("added", a.added).put("removed", a.removed).put("serverSeq", a.serverSeq ?: JSONObject.NULL)
        return JSONObject().put("formatVersion", 2).put("libraryId", libraryId)
            .put("importedFromLibraryId", dao.meta("imported-from-library-id") ?: JSONObject.NULL)
            .put("records", JSONArray(dao.allRecords().map(::archiveRecord)))
            .put("heads", JSONArray(dao.allHeads().map { JSONObject().put("recordId", it.recordId).put("revision", it.revision)
                .put("versionId", it.versionId ?: JSONObject.NULL).put("changeId", it.changeId ?: JSONObject.NULL).put("deleted", it.deleted) }))
            .put("versions", JSONArray(dao.allVersions().map { JSONObject().put("id", it.id).put("recordId", it.recordId)
                .put("revision", it.revision).put("markdown", it.markdown).put("title", it.title).put("createdAt", it.createdAt)
                .put("reason", it.reason).put("changeId", it.changeId ?: JSONObject.NULL).put("serverRevision", it.serverRevision ?: JSONObject.NULL)
                .put("doc", it.docJson?.let(::JSONObject) ?: JSONObject.NULL).put("sources", JSONArray(it.sourcesJson))
                .put("parentVersionIds", JSONArray(it.parentVersionIdsJson)).put("sourcesDerived", it.sourcesDerived)
                .put("parentsDerived", it.parentsDerived).apply { it.journalInputJson?.let { input -> put("journalInput", JSONObject(input)) } } }))
            .put("activities", JSONArray(dao.allActivities().map(::activity)))
            .put("links", JSONArray(dao.allLinks().map { JSONObject().put("articleId", it.articleId).put("materialId", it.materialId) }))
            .put("attachments", JSONArray(dao.allAttachments().map { JSONObject().put("id", it.id).put("recordId", it.recordId)
                .put("name", it.name).put("createdAt", it.createdAt).put("hash", it.hash).put("byteLength", it.byteLength) }))
            // `recordId` is the Room primary key, not part of the stored JSON.
            // Archives need the key in each value so restore can reattach the
            // provenance row to its record instead of losing that relationship.
            .put("provenance", JSONArray(dao.allProvenance().map { JSONObject(it.json).put("recordId", it.recordId) }))
            .put("branches", JSONArray(dao.allBranches().map { JSONObject(it.json) }))
            .put("branchAttachments", JSONArray(dao.allBranchAttachments().map { JSONObject().put("branchId", it.branchId)
                .put("attachmentId", it.attachmentId).put("name", it.name).put("createdAt", it.createdAt).put("hash", it.hash)
                .put("byteLength", it.byteLength) }))
            .put("remoteHeads", JSONArray(dao.allRemoteHeads().map { JSONObject().put("recordId", it.recordId).put("revision", it.revision)
                .put("versionId", it.versionId ?: JSONObject.NULL).put("changeId", it.changeId ?: JSONObject.NULL)
                .put("deleted", it.deleted).put("record", JSONObject(it.recordJson)).put("updatedAt", it.updatedAt) }))
            .put("outbox", JSONArray(dao.allOutbox().map { JSONObject().put("operationId", it.operationId).put("recordId", it.recordId)
                .put("changeId", it.changeId).put("versionId", it.versionId).put("baseVersionId", it.baseVersionId ?: JSONObject.NULL)
                .put("baseRevision", it.baseRevision ?: JSONObject.NULL).put("localGeneration", it.localGeneration).put("action", it.action)
                .put("payload", JSONObject(it.payloadJson)).put("fingerprint", it.fingerprint).put("state", it.state)
                .put("attempts", it.attempts).put("createdAt", it.createdAt).put("lastError", it.lastError ?: JSONObject.NULL) }))
            .put("receipts", JSONArray(dao.allReceipts().map { JSONObject().put("requestId", it.requestId).put("fingerprint", it.fingerprint)
                .put("recordId", it.recordId).put("status", it.status).put("appliedAt", it.appliedAt) }))
            .put("drafts", JSONArray(dao.allDrafts().map { JSONObject().put("slot", it.slot).put("requestId", it.requestId)
                .put("title", it.title).put("markdown", it.markdown).put("kind", it.kind).put("generation", it.generation)
                .put("updatedAt", it.updatedAt) }))
            .put("clientArchive", dao.meta("restored-client-archive-v1")?.let(::JSONObject) ?: JSONObject.NULL)
            .put("recoveryArchive", dao.meta("restored-sync-recovery-v1")?.let(::JSONObject) ?: JSONObject.NULL)
            .put("conflicts", JSONArray(dao.allConflicts().map { JSONObject().put("id", it.id).put("recordId", it.recordId)
                .put("operationId", it.operationId).put("base", JSONObject(it.baseJson)).put("local", JSONObject(it.localJson))
                .put("remote", JSONObject(it.remoteJson)).put("remoteRevision", it.remoteRevision ?: JSONObject.NULL)
                .put("state", it.state).put("createdAt", it.createdAt) }))
            .put("localAgentProfile", dao.meta("local-agent-profile-v1")?.let(::JSONObject) ?: JSONObject.NULL)
    }

    fun restoreArchiveSnapshot(snapshot: JSONObject, attachmentBytes: Map<String, ByteArray>,
        draftAttachmentBytes: Map<String, ByteArray> = emptyMap(),
        restoreRequestId: String? = null, restoreFingerprint: String? = null) {
        val tempRoot = File(app.cacheDir, "archive-bytes-${UUID.randomUUID()}").apply { check(mkdirs()) }
        try {
            fun spill(values: Map<String, ByteArray>, subdir: String): Map<String, LibraryArchiveFile> {
                val dir = File(tempRoot, subdir).apply { mkdirs() }
                return values.mapValues { (id, bytes) ->
                    val file = File(dir, UUID.randomUUID().toString())
                    file.writeBytes(bytes)
                    archiveFileInfo(file, bytes.size.toLong())
                }
            }
            restoreArchiveSnapshotFromFiles(snapshot, spill(attachmentBytes, "record"), spill(draftAttachmentBytes, "draft"),
                restoreRequestId, restoreFingerprint)
        } finally { tempRoot.deleteRecursively() }
    }

    internal fun restoreArchiveSnapshotFromFiles(snapshot: JSONObject, attachmentFiles: Map<String, LibraryArchiveFile>,
        draftAttachmentFiles: Map<String, LibraryArchiveFile>,
        restoreRequestId: String? = null, restoreFingerprint: String? = null) {
        check(snapshot.optInt("formatVersion") in listOf(1, 2)) { "ARCHIVE_VERSION_UNSUPPORTED" }
        check(snapshot.optString("libraryId") == libraryId) { "ARCHIVE_LIBRARY_MISMATCH" }
        if (restoreRequestId != null) {
            UUID.fromString(restoreRequestId)
            require(restoreFingerprint?.matches(Regex("[a-f0-9]{64}")) == true) { "RESTORE_FINGERPRINT_INVALID" }
        }
        snapshot.optString("importedFromLibraryId").takeIf { it.isNotBlank() && it != "null" }?.let {
            UUID.fromString(it)
        }
        val records = snapshot.getJSONArray("records")
        val versions = snapshot.getJSONArray("versions"); val activities = snapshot.getJSONArray("activities")
        val heads = snapshot.getJSONArray("heads"); val links = snapshot.getJSONArray("links")
        val attachments = snapshot.getJSONArray("attachments"); val provenance = snapshot.getJSONArray("provenance")
        val branches = snapshot.optJSONArray("branches") ?: JSONArray()
        val branchAttachments = snapshot.optJSONArray("branchAttachments") ?: JSONArray()
        val conflicts = snapshot.optJSONArray("conflicts") ?: JSONArray()
        val clientArchive = snapshot.optJSONObject("clientArchive")?.let { JSONObject(it.toString()) }
        clientArchive?.let(LibraryClientArchive::validate)
        val draftDescriptors = clientArchive?.optJSONArray("draftAttachments") ?: JSONArray()
        val draftReferences = clientArchive?.optJSONArray("editorDrafts")
            ?.let(LibraryClientArchive::draftAttachmentReferences).orEmpty()
        val draftIds = (0 until draftDescriptors.length()).map { draftDescriptors.getJSONObject(it).getString("id") }.toSet()
        require(draftIds.size == draftDescriptors.length() && draftAttachmentFiles.keys == draftIds &&
            draftReferences.keys == draftIds) { "ARCHIVE_DRAFT_ATTACHMENT_SET_MISMATCH" }
        check(dao.recordCount() == 0 && dao.allVersions().isEmpty() && dao.allActivities().isEmpty() && dao.allHeads().isEmpty() &&
            dao.allAttachments().isEmpty() && dao.allProvenance().isEmpty() && dao.allConflicts().isEmpty() && dao.allBranches().isEmpty() &&
            dao.allBranchAttachments().isEmpty() && dao.allOutbox().isEmpty() && dao.allReceipts().isEmpty() && dao.allDrafts().isEmpty() &&
            dao.allRemoteHeads().isEmpty()) { "RESTORE_TARGET_NOT_EMPTY" }
        val recordIds = (0 until records.length()).map { records.getJSONObject(it).getString("id") }.toSet()
        require(recordIds.size == records.length()) { "ARCHIVE_DUPLICATE_RECORD" }
        val versionIds = (0 until versions.length()).map { versions.getJSONObject(it).getString("id") }.toSet()
        require(versionIds.size == versions.length() && (0 until versions.length()).all { versions.getJSONObject(it).getString("recordId") in recordIds }) { "ARCHIVE_VERSION_INVALID" }
        val headIds = (0 until heads.length()).map { heads.getJSONObject(it).getString("recordId") }.toSet()
        require(headIds.size == heads.length() && headIds == recordIds && (0 until heads.length()).all { i ->
            val head = heads.getJSONObject(i); val versionId = nullable(head, "versionId")
            versionId == null || versionId in versionIds
        }) { "ARCHIVE_HEAD_INVALID" }
        require((0 until activities.length()).all { activities.getJSONObject(it).getString("recordId") in recordIds }) { "ARCHIVE_ACTIVITY_INVALID" }
        require((0 until links.length()).all { links.getJSONObject(it).getString("articleId") in recordIds && links.getJSONObject(it).getString("materialId") in recordIds }) { "ARCHIVE_LINK_INVALID" }
        val attachmentIds = (0 until attachments.length()).map { attachments.getJSONObject(it).getString("id") }.toSet()
        require(attachmentIds.size == attachments.length() && (0 until attachments.length()).all { attachments.getJSONObject(it).getString("recordId") in recordIds }) { "ARCHIVE_ATTACHMENT_INVALID" }
        for (i in 0 until records.length()) {
            val record = records.getJSONObject(i)
            val descriptors = record.optJSONArray("attachmentDescriptors") ?: JSONArray()
            for (j in 0 until descriptors.length()) {
                val descriptor = descriptors.getJSONObject(j)
                val id = descriptor.getString("id")
                val stored = (0 until attachments.length()).map { attachments.getJSONObject(it) }
                    .firstOrNull { it.optString("id") == id }
                require(stored != null && stored.optString("recordId") == record.getString("id") &&
                    stored.optString("hash").equals(descriptor.optString("hash"), ignoreCase = true) &&
                    stored.optLong("byteLength") == descriptor.optLong("byteLength")) { "ARCHIVE_ATTACHMENT_REFERENCE_INVALID" }
            }
        }
        require((0 until provenance.length()).map { provenance.getJSONObject(it).getString("recordId") }.let { it.size == it.toSet().size && it.all(recordIds::contains) }) { "ARCHIVE_PROVENANCE_INVALID" }
        val branchIds = (0 until branches.length()).map { branches.getJSONObject(it).getString("branchId") }.toSet()
        require(branchIds.size == branches.length() && (0 until branches.length()).all { branches.getJSONObject(it).getString("recordId") in recordIds }) { "ARCHIVE_BRANCH_INVALID" }
        val branchAttachmentIds = (0 until branchAttachments.length()).map { i ->
            val item = branchAttachments.getJSONObject(i)
            require(item.getString("branchId") in branchIds) { "ARCHIVE_BRANCH_ATTACHMENT_INVALID" }
            "${item.getString("branchId")}/${item.getString("attachmentId")}"
        }.toSet()
        require(branchAttachmentIds.size == branchAttachments.length()) { "ARCHIVE_BRANCH_ATTACHMENT_INVALID" }
        for (i in 0 until branches.length()) {
            val branch = branches.getJSONObject(i)
            val descriptors = branch.optJSONArray("attachments") ?: JSONArray()
            for (j in 0 until descriptors.length()) {
                val descriptor = descriptors.getJSONObject(j)
                val branchId = descriptor.optString("branchId", branch.getString("branchId"))
                val attachmentId = descriptor.optString("id")
                require("$branchId/$attachmentId" in branchAttachmentIds) { "ARCHIVE_BRANCH_ATTACHMENT_REFERENCE_INVALID" }
            }
        }
        require(attachmentFiles.keys == attachmentIds + branchAttachmentIds) { "ARCHIVE_ATTACHMENT_SET_MISMATCH" }
        val conflictIds = (0 until conflicts.length()).map { conflicts.getJSONObject(it).getString("id") }.toSet()
        require(conflictIds.size == conflicts.length() && (0 until conflicts.length()).all { i ->
            val item = conflicts.getJSONObject(i); item.getString("recordId") in recordIds && item.optString("state").isNotBlank()
        }) { "ARCHIVE_CONFLICT_INVALID" }
        val remoteHeads = snapshot.optJSONArray("remoteHeads") ?: JSONArray()
        require((0 until remoteHeads.length()).map { remoteHeads.getJSONObject(it).getString("recordId") }.let {
            it.size == it.toSet().size && it.all(recordIds::contains)
        }) { "ARCHIVE_REMOTE_HEAD_INVALID" }
        val outbox = snapshot.optJSONArray("outbox") ?: JSONArray()
        require((0 until outbox.length()).map { outbox.getJSONObject(it).getString("operationId") }.let {
            it.size == it.toSet().size && (0 until outbox.length()).all { index -> outbox.getJSONObject(index).getString("recordId") in recordIds }
        }) { "ARCHIVE_OUTBOX_INVALID" }
        val archivedReceipts = snapshot.optJSONArray("receipts") ?: JSONArray()
        require((0 until archivedReceipts.length()).map { archivedReceipts.getJSONObject(it).getString("requestId") }.let {
            it.size == it.toSet().size && (0 until archivedReceipts.length()).all { index -> archivedReceipts.getJSONObject(index).getString("recordId") in recordIds }
        }) { "ARCHIVE_RECEIPT_INVALID" }
        val staged = mutableListOf<Triple<File, File, Boolean>>()
        val createdTargets = mutableListOf<File>()
        val createdDraftTokens = mutableListOf<Pair<String, String>>()
        val stagedTargets = mutableSetOf<File>()
        val stagedBranch = mutableListOf<Triple<File, File, Boolean>>()
        try {
        for (i in 0 until attachments.length()) {
            val descriptor = attachments.getJSONObject(i); val id = descriptor.getString("id")
            val payload = checkNotNull(attachmentFiles[id]) { "ARCHIVE_ATTACHMENT_MISSING" }
            val hash = descriptor.getString("hash").lowercase(); require(hash.matches(Regex("[a-f0-9]{64}")))
            check(payload.byteLength == descriptor.getLong("byteLength") && payload.sha256 == hash &&
                archiveFileInfo(payload.file, LibraryImportExport.MAX_BACKUP_BYTES) == payload) { "ARCHIVE_ATTACHMENT_HASH_MISMATCH" }
            val dir = File(app.filesDir, "libraries/$libraryId/attachments").apply { mkdirs() }
            val tmp = File(dir, ".$hash.restore-${UUID.randomUUID()}.part"); val dest = File(dir, hash)
            if (!stagedTargets.add(dest)) continue
            staged.add(Triple(tmp, dest, !dest.exists()))
            copyArchiveFile(payload, tmp, LibraryImportExport.MAX_BACKUP_BYTES)
            if (dest.exists()) {
                val existing = archiveFileInfo(dest, LibraryImportExport.MAX_BACKUP_BYTES)
                check(existing.byteLength == payload.byteLength && existing.sha256 == hash) { "ARCHIVE_ATTACHMENT_TARGET_MISMATCH" }
            }
        }
        for (i in 0 until branchAttachments.length()) {
            val descriptor = branchAttachments.getJSONObject(i)
            val branchId = descriptor.getString("branchId")
            UUID.fromString(branchId)
            val id = descriptor.getString("attachmentId")
            val key = "$branchId/$id"
            val payload = checkNotNull(attachmentFiles[key]) { "ARCHIVE_ATTACHMENT_MISSING" }
            val hash = descriptor.getString("hash").lowercase(); require(hash.matches(Regex("[a-f0-9]{64}")))
            check(payload.byteLength == descriptor.getLong("byteLength") && payload.sha256 == hash &&
                archiveFileInfo(payload.file, LibraryImportExport.MAX_BACKUP_BYTES) == payload) { "ARCHIVE_ATTACHMENT_HASH_MISMATCH" }
            val dir = File(app.filesDir, "libraries/$libraryId/branches/$branchId/attachments").apply { mkdirs() }
            val tmp = File(dir, ".$hash.restore-${UUID.randomUUID()}.part"); val dest = File(dir, hash)
            if (!stagedTargets.add(dest)) continue
            stagedBranch.add(Triple(tmp, dest, !dest.exists()))
            copyArchiveFile(payload, tmp, LibraryImportExport.MAX_BACKUP_BYTES)
            if (dest.exists()) {
                val existing = archiveFileInfo(dest, LibraryImportExport.MAX_BACKUP_BYTES)
                check(existing.byteLength == payload.byteLength && existing.sha256 == hash) { "ARCHIVE_ATTACHMENT_TARGET_MISMATCH" }
            }
        }
            val draftStore = LibraryAttachmentDraftStore(app, libraryId)
            for (i in 0 until draftDescriptors.length()) {
                val descriptor = draftDescriptors.getJSONObject(i)
                val token = descriptor.getString("id")
                val payload = checkNotNull(draftAttachmentFiles[token]) { "ARCHIVE_DRAFT_ATTACHMENT_MISSING" }
                if (draftStore.restoreFromFile(token, descriptor.getString("name"), descriptor.getString("hash"),
                        descriptor.getLong("byteLength"), descriptor.getString("mimeType"), payload)) {
                    createdDraftTokens += token to descriptor.getString("hash")
                }
            }
            staged.forEach { (tmp, target, shouldCreate) ->
                if (shouldCreate) { check(tmp.renameTo(target)) { "ARCHIVE_ATTACHMENT_STORE_FAILED" }; createdTargets.add(target) }
                else tmp.delete()
            }
            stagedBranch.forEach { (tmp, target, shouldCreate) ->
                if (shouldCreate) { check(tmp.renameTo(target)) { "ARCHIVE_ATTACHMENT_STORE_FAILED" }; createdTargets.add(target) }
                else tmp.delete()
            }
            db.runInTransaction {
                for (i in 0 until records.length()) dao.insertRecord(recordFromArchive(records.getJSONObject(i)))
                for (i in 0 until heads.length()) { val x = heads.getJSONObject(i); dao.putHead(LibraryHead(x.getString("recordId"), x.optLong("revision"), nullable(x, "versionId"), nullable(x, "changeId"), x.optBoolean("deleted"))) }
                for (i in 0 until versions.length()) { val x = versions.getJSONObject(i); dao.insertVersion(LibraryVersion(x.getString("id"), x.getString("recordId"), x.optLong("revision"), x.optString("markdown"), x.optString("title"), x.optString("createdAt"), x.optString("reason"), nullable(x, "changeId"), null, x.optJSONObject("doc")?.toString(), x.optJSONArray("sources")?.toString() ?: "[]", x.optJSONArray("parentVersionIds")?.toString() ?: "[]", x.optBoolean("sourcesDerived"), x.optBoolean("parentsDerived"), x.optJSONObject("journalInput")?.toString())) }
                for (i in 0 until activities.length()) { val x = activities.getJSONObject(i); dao.insertActivity(LibraryActivity(x.getString("activityId"), x.getString("recordId"), nullable(x, "changeId"), nullable(x, "originDeviceId"), x.getString("occurredAt"), x.optString("timeZone", "UTC"), x.optString("beforeHash"), x.optString("afterHash"), x.optJSONArray("afterSegments")?.toString() ?: "[]", x.optString("action"), x.optString("authorship"), x.optInt("added"), x.optInt("removed"), null)) }
                for (i in 0 until links.length()) { val x = links.getJSONObject(i); dao.putLink(LibraryLink(x.getString("articleId"), x.getString("materialId"))) }
                for (i in 0 until attachments.length()) { val x = attachments.getJSONObject(i); val hash = x.getString("hash").lowercase(); dao.putAttachment(LibraryAttachment(x.getString("id"), x.getString("recordId"), x.getString("name"), x.getString("createdAt"), hash, x.getLong("byteLength"), "attachments/$hash", true, false)) }
                for (i in 0 until provenance.length()) { val x = provenance.getJSONObject(i); dao.putProvenance(LibraryProvenance(x.getString("recordId"), x.toString())) }
                for (i in 0 until branches.length()) { val x = branches.getJSONObject(i); dao.putBranch(LibraryBranch(x.getString("branchId"), x.getString("recordId"), x.optString("state", "open"), x.toString())) }
                for (i in 0 until branchAttachments.length()) { val x = branchAttachments.getJSONObject(i); val branchId = x.getString("branchId"); val hash = x.getString("hash").lowercase();
                    dao.putBranchAttachment(LibraryBranchAttachment(branchId, x.getString("attachmentId"), x.getString("name"), x.getString("createdAt"), hash,
                        x.getLong("byteLength"), "branches/$branchId/attachments/$hash", true, false)) }
                for (i in 0 until conflicts.length()) { val x = conflicts.getJSONObject(i); dao.putConflict(LibraryConflict(x.getString("id"), x.getString("recordId"), x.getString("operationId"), x.optJSONObject("base")?.toString() ?: "{}", x.optJSONObject("local")?.toString() ?: "{}", x.optJSONObject("remote")?.toString() ?: "{}", nullable(x, "remoteRevision")?.toLongOrNull(), x.getString("state"), x.getString("createdAt"))) }
                snapshot.optJSONObject("localAgentProfile")?.let { dao.putMeta(LibraryMeta("local-agent-profile-v1", it.toString())) }
                clientArchive?.let { dao.putMeta(LibraryMeta("restored-client-archive-v1", it.toString())) }
                snapshot.optString("importedFromLibraryId").takeIf { it.isNotBlank() && it != "null" }
                    ?.let { dao.putMeta(LibraryMeta("imported-from-library-id", it)) }
                // Preserve pending transport state for explicit recovery only; never enqueue old operations for automatic replay.
                val recovery = JSONObject().put("state", "reconciliation-required")
                    .put("sourceLibraryId", snapshot.optString("importedFromLibraryId").takeIf { it.isNotBlank() && it != "null" } ?: libraryId)
                    .put("outbox", snapshot.optJSONArray("outbox") ?: JSONArray())
                    .put("remoteHeads", snapshot.optJSONArray("remoteHeads") ?: JSONArray())
                if (recovery.getJSONArray("outbox").length() > 0 || recovery.getJSONArray("remoteHeads").length() > 0)
                    dao.putMeta(LibraryMeta("restored-sync-recovery-v1", recovery.toString()))
                snapshot.optJSONObject("recoveryArchive")?.let { prior ->
                    dao.putMeta(LibraryMeta("restored-sync-recovery-v1", JSONObject(prior.toString())
                        .put("state", "reconciliation-required").toString()))
                }
                for (i in 0 until (snapshot.optJSONArray("drafts")?.length() ?: 0)) {
                    val x = snapshot.getJSONArray("drafts").getJSONObject(i)
                    dao.putDraft(LibraryDraft(x.getString("slot"), x.getString("requestId"), x.optString("title"), x.optString("markdown"),
                        x.optString("kind"), x.optLong("generation"), x.optString("updatedAt")))
                }
                for (i in 0 until (snapshot.optJSONArray("receipts")?.length() ?: 0)) {
                    val x = snapshot.getJSONArray("receipts").getJSONObject(i)
                    dao.putReceipt(LibraryReceipt(x.getString("requestId"), x.getString("fingerprint"), x.getString("recordId"), x.getString("status"), x.getString("appliedAt")))
                }
                if (restoreRequestId != null && restoreFingerprint != null) {
                    dao.putMeta(LibraryMeta("restore-complete-v1", JSONObject().put("requestId", restoreRequestId)
                        .put("fingerprint", restoreFingerprint).put("libraryId", libraryId).toString()))
                }
            }
        } catch (e: Exception) {
            staged.forEach { it.first.delete() }; stagedBranch.forEach { it.first.delete() }; createdTargets.forEach { it.delete() }
            val draftStore = LibraryAttachmentDraftStore(app, libraryId)
            createdDraftTokens.forEach { (id, hash) -> runCatching { draftStore.deleteRestored(id, hash) } }
            throw e
        }
    }

    private fun archiveRecord(r: LibraryRecord) = wireRecord(r).put("versionId", r.versionId).put("changeId", r.changeId)
        .put("baseVersionId", r.baseVersionId ?: JSONObject.NULL).put("serverRevision", r.serverRevision ?: JSONObject.NULL)
        .put("localGeneration", r.localGeneration).put("revision", r.revision).put("syncState", "local-only")
    private fun recordFromArchive(x: JSONObject) = LibraryRecord(x.getString("id"), x.getString("kind"), x.optString("title"),
        x.optString("markdown"), x.optString("origin", "unknown"), x.optString("processing", "unknown"), nullable(x, "contentDay"),
        x.optString("dateBasis", "unknown"), nullable(x, "url"), nullable(x, "annotation"), nullable(x, "stage"),
        x.optJSONArray("sourceIds")?.toString() ?: "[]", x.optJSONArray("sources")?.toString() ?: "[]",
        x.optJSONArray("attachmentDescriptors")?.toString() ?: "[]", x.getString("createdAt"), x.optString("updatedAt"),
        x.optBoolean("deleted"), nullable(x, "createdByDevice"), x.optString("versionId"), x.optString("changeId"),
        nullable(x, "baseVersionId"), null, x.optLong("localGeneration", 1), x.optLong("revision", 1), "local-only", x.optJSONObject("annotationOf")?.toString())
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun enqueueUpdate(old: LibraryRecord, next: LibraryRecord, changeId: String, versionId: String, now: String,
        action: String, activity: LibraryActivity, parentVersionIds: JSONArray = JSONArray().put(old.versionId)) {
        val opId = UUID.randomUUID().toString()
        val op = JSONObject().put("operationId", opId).put("recordId", next.id).put("changeId", changeId).put("versionId", versionId)
            .put("baseVersionId", old.versionId).put("parentVersionIds", JSONArray(parentVersionIds.toString())).put("originDeviceId", deviceId)
            .put("action", action).put("baseRevision", old.serverRevision ?: JSONObject.NULL)
            .put("localGeneration", next.localGeneration).put("occurredAt", now).put("timeZone", ZoneId.systemDefault().id)
            .put("payload", wireRecord(next)).put("activities", JSONArray().put(activityJson(activity)))
        dao.insertOutbox(LibraryOutbox(opId, next.id, changeId, versionId, old.versionId, old.serverRevision,
            next.localGeneration, action, op.toString(), Canonical.hash(plain(op)), "pending", 0, now, null))
    }

    private fun validateRecord(value: JSONObject): JSONObject {
        val out = JSONObject(value.toString())
        require(out.optString("kind", "idea") in KINDS) { "INVALID_RECORD_KIND" }
        require(out.optString("markdown").length <= 1_000_000 && out.optString("title").length <= 200) { "RECORD_TOO_LARGE" }
        val sourceIds = out.optJSONArray("sourceIds") ?: JSONArray()
        require(sourceIds.length() <= 500 && (0 until sourceIds.length()).map { sourceIds.getString(it) }.distinct().size == sourceIds.length()) { "TOO_MANY_SOURCES" }
        require((0 until sourceIds.length()).none { sourceIds.getString(it) == out.optString("id") }) { "RECORD_SELF_LINK" }
        val segments = out.optJSONArray("sources")
        if (segments != null) {
            val joined = buildString { for (i in 0 until segments.length()) append(segments.getJSONObject(i).optString("text")) }
            check(joined == out.optString("markdown")) { "SOURCE_SEGMENTS_MISMATCH" }
        }
        return out
    }

    internal fun validateDraft(input: JSONObject): JSONObject = validateRecord(input)

    private fun wireRecord(r: LibraryRecord) = JSONObject().put("id", r.id).put("kind", r.kind).put("title", r.title)
        .put("markdown", r.markdown).put("origin", r.origin).put("processing", r.processing)
        .put("contentDay", r.contentDay ?: JSONObject.NULL).put("dateBasis", r.dateBasis)
        .put("url", r.url ?: "").put("annotation", r.annotation ?: "")
        .put("stage", r.stage ?: "draft").put("sourceIds", JSONArray(r.sourceIdsJson)).put("sources", JSONArray(r.sourcesJson))
        // Local attachment rows retain createdAt/path/upload state, but the v1
        // wire descriptor is intentionally strict and has only these four fields.
        .put("attachmentDescriptors", JSONArray().also { output ->
            val local = JSONArray(r.attachmentDescriptorsJson)
            for (index in 0 until local.length()) {
                val item = local.getJSONObject(index)
                output.put(JSONObject().put("id", item.getString("id")).put("hash", item.getString("hash"))
                    .put("byteLength", item.getLong("byteLength")).put("name", item.getString("name")))
            }
        }).put("createdAt", r.createdAt).put("updatedAt", r.updatedAt)
        .put("deleted", r.deleted).put("createdByDevice", r.createdByDevice ?: JSONObject.NULL)
        .apply { r.annotationOfJson?.let { put("annotationOf", JSONObject(it)) } }
    private fun localRecordJson(r: LibraryRecord) = wireRecord(r).put("provenance", dao.provenance(r.id)?.let { JSONObject(it.json) } ?: JSONObject.NULL)
        .put("doc", dao.versions(r.id).firstOrNull()?.docJson?.let { JSONObject(it) } ?: JSONObject.NULL)
    private fun activityJson(a: LibraryActivity) = JSONObject().put("activityId", a.activityId)
        .put("originDeviceId", a.originDeviceId).put("occurredAt", a.occurredAt)
        .put("timeZone", a.timeZone).put("beforeHash", a.beforeHash).put("afterHash", a.afterHash)
        .put("afterSegments", JSONArray(a.afterSegmentsJson)).put("action", a.action).put("authorship", a.authorship)
    private fun authorship(segments: JSONArray): String {
        val kinds = (0 until segments.length()).map { segments.getJSONObject(it).optString("origin", "unknown") }.toSet()
        return when {
            kinds.isEmpty() -> "unknown"
            kinds.size != 1 -> "unknown"
            kinds.single() == "personal" -> "personal"
            kinds.single() == "external" -> "external"
            kinds.single() == "ai" -> "ai"
            kinds.single() == "translation" -> "translation"
            else -> "unknown"
        }
    }
    private fun addedChars(old: String, next: String): Int = WritingDelta.between(old, next).added
    private fun removedChars(old: String, next: String): Int = WritingDelta.between(old, next).removed
    private fun LibraryRecord.agentView() = AgentLibraryRecord(id, title, markdown, kind, createdAt, origin, contentDay)
    private fun contentHash(markdown: String, segments: JSONArray) = Canonical.hash(mapOf("markdown" to markdown, "segments" to plain(segments)))
    private fun reconcileSources(oldSegmentsJson: String, oldMarkdown: String, nextMarkdown: String): JSONArray {
        val segments = JSONArray(oldSegmentsJson)
        fun slice(start: Int, end: Int): JSONArray {
            val output = JSONArray(); var position = 0
            for (i in 0 until segments.length()) {
                val segment = segments.getJSONObject(i); val text = segment.optString("text")
                val segmentStart = position; val segmentEnd = position + text.length
                val from = maxOf(start, segmentStart); val to = minOf(end, segmentEnd)
                if (to > from) output.put(JSONObject(segment.toString()).put("text", text.substring(from - segmentStart, to - segmentStart)))
                position = segmentEnd
            }
            return output
        }
        val changes = WritingDelta.changes(oldMarkdown, nextMarkdown)
        val output = JSONArray(); var oldOffset = 0; val result = StringBuilder()
        for (change in changes) when (change.kind) {
            "equal" -> {
                check(oldMarkdown.regionMatches(oldOffset, change.text, 0, change.text.length)) { "SOURCE_RECONCILIATION_FAILED" }
                val kept = slice(oldOffset, oldOffset + change.text.length)
                for (i in 0 until kept.length()) output.put(kept.getJSONObject(i))
                oldOffset += change.text.length; result.append(change.text)
            }
            "remove" -> {
                check(oldMarkdown.regionMatches(oldOffset, change.text, 0, change.text.length)) { "SOURCE_RECONCILIATION_FAILED" }
                oldOffset += change.text.length
            }
            "add" -> {
                if (change.text.isNotEmpty()) output.put(JSONObject().put("text", change.text).put("origin", "personal"))
                result.append(change.text)
            }
            else -> error("SOURCE_RECONCILIATION_FAILED")
        }
        check(oldOffset == oldMarkdown.length && result.toString() == nextMarkdown) { "SOURCE_RECONCILIATION_FAILED" }
        if (output.length() == 0 && nextMarkdown.isNotEmpty()) output.put(JSONObject().put("text", nextMarkdown).put("origin", "personal"))
        return output
    }
    private fun nullable(json: JSONObject, key: String) = json.opt(key)?.takeUnless { it == JSONObject.NULL }?.toString()
    private fun plain(value: Any?): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        else -> value
    }
    private fun plain(json: JSONObject): Map<String, Any?> = json.keys().asSequence().associateWith { plain(json.get(it)) }

    companion object {
        val KINDS = setOf("ai_annotation", "journal", "idea", "freewrite", "web", "ai", "reference", "article")
        private val EDITABLE_FIELDS = setOf("title", "markdown", "kind", "origin", "processing", "contentDay", "dateBasis", "url", "annotation", "stage", "sourceIds", "sources", "attachmentDescriptors", "deleted", "provenance")
        private val READ_ONLY_FIELDS = setOf("id", "createdAt", "updatedAt", "createdByDevice", "revision", "versionId", "changeId", "baseVersionId", "serverRevision", "localGeneration", "syncState", "state")
    }
}

/** Owns the registry, isolated per-library database handles, and idempotent P0 copy migration. */
class LibraryManager(context: Context, private val namespace: String = "shiwen-library-registry",
    private val legacyNamespace: String = "shiwen-p0",
    private val restoreFaultInjector: (String) -> Unit = {}) {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("$namespace-context", Context.MODE_PRIVATE)
    private val registry = Room.databaseBuilder(app, LibraryRegistryDatabase::class.java, "$namespace.sqlite")
        .addMigrations(LIBRARY_REGISTRY_MIGRATION_1_2).build()
    private val cache = mutableMapOf<String, LibraryRepository>()

    @Synchronized fun bootstrap(): LibraryRepository {
        recoverRestoreReservations()
        val active = prefs.getString("activeLibraryId", null)
        if (active != null) registry.dao().get(active)?.let { return open(it) }
        val p0 = ProbeRepository(app, namespace = legacyNamespace)
        val row = registry.dao().get(p0.libraryId) ?: LibraryRegistryRow(p0.libraryId, "我的资料库", p0.deviceId,
            "shiwen-library-${p0.libraryId}.sqlite", "standalone", "complete", null, null, 1, null, null, null,
            null, null, 1, false, false, false, "{}")
        if (registry.dao().get(row.libraryId) == null) registry.dao().insert(row)
        val repo = open(row.copy(pageGeneration = row.pageGeneration + 1))
        if (registry.dao().get(row.libraryId)?.migrationP0Done != true) migrateP0(p0, repo, row)
        val saved = row.copy(pageGeneration = row.pageGeneration + 1, migrationP0Done = true)
        registry.dao().update(saved); prefs.edit().putString("activeLibraryId", row.libraryId).commit()
        p0.executor.shutdownNow(); p0.db.close()
        return cache.getValue(row.libraryId)
    }

    @Synchronized fun active(): LibraryRepository = bootstrap()
    @Synchronized fun all(): List<LibraryRegistryRow> {
        recoverRestoreReservations()
        return registry.dao().all()
    }
    @Synchronized fun select(id: String): LibraryRepository {
        recoverRestoreReservations()
        val row = checkNotNull(registry.dao().get(id)) { "LIBRARY_NOT_FOUND" }
        val updated = row.copy(pageGeneration = row.pageGeneration + 1)
        registry.dao().update(updated); prefs.edit().putString("activeLibraryId", id).commit()
        return open(updated)
    }

    @Synchronized fun create(name: String): LibraryRepository {
        recoverRestoreReservations()
        require(name.isNotBlank() && name.length <= 80) { "INVALID_LIBRARY_NAME" }
        val id = UUID.randomUUID().toString(); val device = UUID.randomUUID().toString()
        val row = LibraryRegistryRow(id, name.trim(), device, "shiwen-library-$id.sqlite", "standalone", "complete",
            null, null, 1, null, null, null, null, null, 1, true, false, false, "{}")
        registry.dao().insert(row); prefs.edit().putString("activeLibraryId", id).commit(); return open(row)
    }

    @Synchronized fun restoreArchive(snapshot: JSONObject, attachmentBytes: Map<String, ByteArray>,
        name: String = "恢复的资料库", requestId: String? = null, fingerprint: String? = null,
        asNewLibrary: Boolean = false, draftAttachmentBytes: Map<String, ByteArray> = emptyMap()): LibraryRepository {
        val tempRoot = File(app.cacheDir, "restore-bytes-${UUID.randomUUID()}").apply { check(mkdirs()) }
        try {
            fun spill(values: Map<String, ByteArray>, dirName: String) = values.mapValues { (_, bytes) ->
                val dir = File(tempRoot, dirName).apply { mkdirs() }
                val file = File(dir, UUID.randomUUID().toString())
                file.writeBytes(bytes)
                archiveFileInfo(file, LibraryImportExport.MAX_BACKUP_BYTES)
            }
            return restoreArchiveFiles(snapshot, spill(attachmentBytes, "attachments"), name, requestId, fingerprint,
                asNewLibrary, spill(draftAttachmentBytes, "draft-attachments"))
        } finally { tempRoot.deleteRecursively() }
    }

    @Synchronized internal fun restoreArchiveFiles(snapshot: JSONObject, attachmentFiles: Map<String, LibraryArchiveFile>,
        name: String = "恢复的资料库", requestId: String? = null, fingerprint: String? = null,
        asNewLibrary: Boolean = false, draftAttachmentFiles: Map<String, LibraryArchiveFile> = emptyMap()): LibraryRepository {
        recoverRestoreReservations()
        require(name.isNotBlank() && name.trim().length <= 80) { "INVALID_LIBRARY_NAME" }
        val sourceLibraryId = snapshot.optString("libraryId")
        UUID.fromString(sourceLibraryId)
        val stableRequestId = requestId ?: UUID.randomUUID().toString()
        UUID.fromString(stableRequestId)
        val stableFingerprint = fingerprint ?: defaultRestoreFingerprint(snapshot, attachmentFiles, draftAttachmentFiles, name.trim(), asNewLibrary)
        require(stableFingerprint.matches(Regex("[a-f0-9]{64}"))) { "RESTORE_FINGERPRINT_INVALID" }
        val lock = restoreLocks.computeIfAbsent("$namespace:$stableRequestId") { java.util.concurrent.locks.ReentrantLock() }
        check(lock.tryLock()) { "RESTORE_ALREADY_RUNNING" }
        try {
            var reservation = registry.dao().restoreReservation(stableRequestId)
            if (reservation != null) {
                check(reservation.fingerprint == stableFingerprint && reservation.asNewLibrary == asNewLibrary &&
                    reservation.sourceLibraryId == sourceLibraryId && reservation.name == name.trim()) { "REQUEST_REUSED" }
                completeReservationIfCommitted(reservation)
                reservation = registry.dao().restoreReservation(stableRequestId) ?: error("RESTORE_RESERVATION_MISSING")
                if (reservation.state == "complete") {
                    val row = checkNotNull(registry.dao().get(reservation.targetLibraryId)) { "RESTORE_COMMIT_RECEIPT_INVALID" }
                    check(markerMatches(row.dbFile, reservation)) { "RESTORE_COMMIT_MARKER_MISSING" }
                    return open(row)
                }
                check(registry.dao().get(reservation.targetLibraryId) == null) { "RESTORE_RESERVATION_COLLISION" }
                // A prior process may have died before the data transaction committed.
                // The unique DB filename belongs to this reservation; only it is removed.
                cleanupUncommittedReservation(reservation)
            } else {
                val targetId = if (asNewLibrary) UUID.randomUUID().toString() else sourceLibraryId
                check(registry.dao().get(targetId) == null) { "RESTORE_LIBRARY_ALREADY_EXISTS" }
                check(registry.dao().reservedRestoreForLibrary(targetId) == null) { "RESTORE_TARGET_RESERVED" }
                val dbFile = restoreDatabaseName(stableRequestId)
                check(!app.getDatabasePath(dbFile).exists()) { "RESTORE_TARGET_PATH_OCCUPIED" }
                // Do not claim an unregistered library directory: it may contain user data
                // left by an older install or a damaged registry.
                val existingDir = File(app.filesDir, "libraries/$targetId")
                check(!existingDir.exists() || existingDir.listFiles().isNullOrEmpty()) { "RESTORE_TARGET_PATH_OCCUPIED" }
                val newReservation = LibraryRestoreReservation(stableRequestId, stableFingerprint, targetId, sourceLibraryId,
                    name.trim(), UUID.randomUUID().toString(), dbFile, asNewLibrary, "reserved", Instant.now().toString(), null)
                registry.runInTransaction {
                    check(registry.dao().get(targetId) == null && registry.dao().reservedRestoreForLibrary(targetId) == null) {
                        "RESTORE_TARGET_RESERVED"
                    }
                    registry.dao().insertRestoreReservation(newReservation)
                }
                reservation = newReservation
            }

            val activeReservation = checkNotNull(reservation) { "RESTORE_RESERVATION_MISSING" }
            val targetSnapshot = if (activeReservation.asNewLibrary) JSONObject(snapshot.toString()).apply {
                put("libraryId", activeReservation.targetLibraryId)
                put("importedFromLibraryId", activeReservation.sourceLibraryId)
            } else snapshot
            val row = restoreRegistryRow(activeReservation)
            val repo = open(row)
            try {
                restoreFaultInjector("after-reservation")
                repo.restoreArchiveSnapshotFromFiles(targetSnapshot, attachmentFiles, draftAttachmentFiles,
                    stableRequestId, stableFingerprint)
                restoreFaultInjector("after-data-commit")
                registry.runInTransaction {
                    val currentReservation = checkNotNull(registry.dao().restoreReservation(stableRequestId)) { "RESTORE_RESERVATION_MISSING" }
                    check(currentReservation.fingerprint == stableFingerprint && currentReservation.targetLibraryId == row.libraryId) { "REQUEST_REUSED" }
                    val existing = registry.dao().get(row.libraryId)
                    if (existing == null) registry.dao().insert(row)
                    else check(existing.dbFile == row.dbFile && existing.deviceId == row.deviceId) { "RESTORE_RESERVATION_COLLISION" }
                    check(registry.dao().updateRestoreReservation(currentReservation.copy(state = "complete",
                        completedAt = Instant.now().toString())) == 1) { "RESTORE_RECEIPT_SAVE_FAILED" }
                }
                restoreFaultInjector("after-registry-commit")
                return open(row)
            } catch (error: Exception) {
                // Close our handle, but delete the reservation-owned DB only when the
                // registry confirms it is not visible and the commit marker is definitely
                // absent. A read/open failure or a committed marker must preserve it.
                val canCleanup = runCatching {
                    registry.dao().get(row.libraryId) == null && !markerMatches(row.dbFile, activeReservation)
                }.getOrDefault(false)
                cache.remove(row.libraryId)
                repo.executor.shutdownNow(); repo.db.close()
                if (canCleanup) cleanupUncommittedReservation(activeReservation)
                throw error
            }
        } finally { lock.unlock() }
    }

    @Synchronized fun attachRemote(libraryId: String, serverId: String, epoch: String, protocolVersion: Int,
        nodeId: String, configRevision: String, name: String): LibraryRepository {
        recoverRestoreReservations()
        UUID.fromString(libraryId)
        require(serverId.isNotBlank() && serverId.length <= 128 && epoch.isNotBlank() && protocolVersion > 0) { "INVALID_REMOTE_IDENTITY" }
        require(nodeId.isNotBlank() && configRevision.isNotBlank()) { "INVALID_NODE_BINDING" }
        check(registry.dao().reservedRestoreForLibrary(libraryId) == null) { "RESTORE_TARGET_RESERVED" }
        val old = registry.dao().get(libraryId)
        if (old != null) check(old.serverId == null || old.serverId == serverId) { "LIBRARY_SERVER_CONFLICT" }
        val device = old?.deviceId ?: bootstrap().deviceId
        val row = if (old == null) LibraryRegistryRow(libraryId, name.take(80).ifBlank { "服务资料库" }, device,
            "shiwen-library-$libraryId.sqlite", "coordinated", "incomplete", serverId, epoch, protocolVersion,
            null, null, null, null, null, 1, true, false, false, "{}")
        else old.copy(name = name.take(80).ifBlank { old.name }, role = "coordinated",
            integrity = if (old.integrity == "complete" && old.serverId == serverId && old.epoch == epoch) "complete" else "incomplete",
            serverId = serverId, epoch = epoch, protocolVersion = protocolVersion, pageGeneration = old.pageGeneration + 1)
        if (old == null) registry.dao().insert(row) else registry.dao().update(row)
        val repo = open(row)
        repo.dao.putMeta(LibraryMeta("nodeBinding", JSONObject().put("nodeId", nodeId)
            .put("configRevision", configRevision).toString()))
        repo.dao.putMeta(LibraryMeta("syncProgress", JSONObject().put("state", "queued").put("phase", "identity").toString()))
        return repo
    }

    @Synchronized fun row(id: String): LibraryRegistryRow {
        recoverRestoreReservations()
        return checkNotNull(registry.dao().get(id)) { "LIBRARY_NOT_FOUND" }
    }
    @Synchronized fun openLibrary(id: String): LibraryRepository = open(row(id))
    @Synchronized fun update(row: LibraryRegistryRow) {
        check(registry.dao().update(row) == 1) { "LIBRARY_NOT_FOUND" }
        cache[row.libraryId]?.updateRegistry(row)
    }
    private fun open(row: LibraryRegistryRow): LibraryRepository = cache[row.libraryId]?.also { it.updateRegistry(row) }
        ?: LibraryRepository(app, row.libraryId, row.deviceId, row.name, registry, row).also { cache[row.libraryId] = it }

    private fun restoreRegistryRow(reservation: LibraryRestoreReservation) = LibraryRegistryRow(
        reservation.targetLibraryId, reservation.name, reservation.deviceId, reservation.dbFile,
        "standalone", "complete", null, null, 1, null, null, null, null, null, 1,
        true, false, false, "{}")

    private fun restoreDatabaseName(requestId: String) = "shiwen-restore-$requestId.sqlite"

    private fun defaultRestoreFingerprint(snapshot: JSONObject, attachmentFiles: Map<String, LibraryArchiveFile>,
        draftAttachmentFiles: Map<String, LibraryArchiveFile>,
        name: String, asNewLibrary: Boolean): String {
        val attachmentDigests = attachmentFiles.toSortedMap().mapValues { (_, file) -> file.sha256 }
        return Canonical.hash(mapOf("snapshot" to snapshot.toString(), "attachmentDigests" to attachmentDigests,
            "draftAttachmentDigests" to draftAttachmentFiles.toSortedMap().mapValues { (_, file) -> file.sha256 },
            "name" to name, "asNewLibrary" to asNewLibrary))
    }

    private fun markerMatches(dbFile: String, reservation: LibraryRestoreReservation): Boolean {
        if (!app.getDatabasePath(dbFile).exists()) return false
        val database = Room.databaseBuilder(app, LibraryDatabase::class.java, dbFile)
            .addMigrations(LIBRARY_MIGRATION_1_2, LIBRARY_MIGRATION_2_3, LIBRARY_MIGRATION_3_4,
                LIBRARY_MIGRATION_4_5, LIBRARY_MIGRATION_5_6, LIBRARY_MIGRATION_6_7).openHelperFactory(LargeRowOpenHelperFactory()).build()
        return try {
            val encoded = database.dao().meta("restore-complete-v1") ?: return false
            val marker = JSONObject(encoded)
            check(marker.optString("requestId") == reservation.requestId &&
                marker.optString("fingerprint") == reservation.fingerprint &&
                marker.optString("libraryId") == reservation.targetLibraryId) { "RESTORE_COMMIT_MARKER_MISMATCH" }
            true
        }
        finally { database.close() }
    }

    private fun completeReservationIfCommitted(reservation: LibraryRestoreReservation): Boolean {
        val registered = registry.dao().get(reservation.targetLibraryId)
        val file = registered?.dbFile ?: reservation.dbFile
        if (!markerMatches(file, reservation)) return false
        val row = registered ?: restoreRegistryRow(reservation)
        registry.runInTransaction {
            val current = registry.dao().get(reservation.targetLibraryId)
            if (current == null) registry.dao().insert(row)
            else check(current.dbFile == reservation.dbFile && current.deviceId == reservation.deviceId) {
                "RESTORE_RESERVATION_COLLISION"
            }
            val latest = checkNotNull(registry.dao().restoreReservation(reservation.requestId)) { "RESTORE_RESERVATION_MISSING" }
            check(latest.fingerprint == reservation.fingerprint && latest.targetLibraryId == reservation.targetLibraryId) { "REQUEST_REUSED" }
            if (latest.state != "complete") check(registry.dao().updateRestoreReservation(latest.copy(state = "complete",
                completedAt = Instant.now().toString())) == 1) { "RESTORE_RECEIPT_SAVE_FAILED" }
        }
        return true
    }

    private fun cleanupUncommittedReservation(reservation: LibraryRestoreReservation) {
        // A restore DB name is request-scoped and never shared with a user library.
        // Do not remove the library attachments directory before verifying which files
        // belong to this reservation; content-addressed files are safe to reuse on retry.
        check(reservation.dbFile == restoreDatabaseName(reservation.requestId)) { "RESTORE_DB_SCOPE_INVALID" }
        check(registry.dao().get(reservation.targetLibraryId) == null) { "RESTORE_RESERVATION_COLLISION" }
        if (app.getDatabasePath(reservation.dbFile).exists()) app.deleteDatabase(reservation.dbFile)
    }

    /** Reconcile cross-database restore commits before exposing libraries to the app. */
    private fun recoverRestoreReservations() {
        for (reservation in registry.dao().allRestoreReservations()) {
            val key = "$namespace:${reservation.requestId}"
            val lock = restoreLocks.computeIfAbsent(key) { java.util.concurrent.locks.ReentrantLock() }
            if (!lock.tryLock()) continue // Another manager in this process is actively restoring it.
            try {
                if (completeReservationIfCommitted(reservation)) continue
                val registered = registry.dao().get(reservation.targetLibraryId)
                if (registered == null && reservation.state == "reserved") cleanupUncommittedReservation(reservation)
                // A registered library without its matching marker is never removed.
            } catch (_: Exception) {
                // Keep unrelated libraries available; an explicit replay reports any
                // reservation or collision error instead of deleting unknown data.
            } finally { lock.unlock() }
        }
    }

    private fun migrateP0(source: ProbeRepository, target: LibraryRepository, row: LibraryRegistryRow) {
        val records = source.db.dao().allRecords()
        val activities = source.db.dao().allActivities()
        val receipts = source.db.dao().allReceipts()
        val draft = source.db.dao().composerDraft()
        target.db.runInTransaction {
            records.forEach { old ->
                if (target.dao.record(old.id) == null) {
                    val sources = JSONArray().put(JSONObject().put("text", old.markdown).put("origin", "personal"))
                    val version = LibraryVersion(old.versionId, old.id, 1, old.markdown, old.title, old.createdAt, "legacy-p0", old.changeId, null, null,
                        JSONArray().put(JSONObject().put("text", old.markdown).put("origin", "personal")).toString(), "[]")
                    val record = LibraryRecord(old.id, old.kind, old.title, old.markdown, "personal", "unknown", null, "unknown",
                        null, null, null, "[]", sources.toString(), "[]", old.createdAt, old.createdAt, false, old.originDeviceId,
                        old.versionId, old.changeId, null, null, 1, 1, "local-only")
                    target.dao.insertRecord(record); target.dao.insertVersion(version)
                    target.dao.putHead(LibraryHead(old.id, 1, old.versionId, old.changeId, false))
                }
            }
            activities.forEach { old ->
                if (target.dao.activities(old.recordId).none { it.activityId == old.activityId }) {
                    val legacyRecord = records.firstOrNull { it.id == old.recordId }
                    val markdown = legacyRecord?.markdown.orEmpty()
                    val segments = JSONArray().put(JSONObject().put("text", markdown).put("origin", "personal"))
                    target.dao.insertActivity(LibraryActivity(old.activityId, old.recordId, legacyRecord?.changeId, old.originDeviceId,
                        old.occurredAt, ZoneId.systemDefault().id, Canonical.hash(mapOf("markdown" to "", "segments" to emptyList<Any>())),
                        old.afterHash, segments.toString(), "write", "personal", markdown.length, 0, null))
                }
            }
            receipts.forEach { old -> target.dao.putReceipt(LibraryReceipt(old.requestId, "p0-legacy:${old.fingerprint}", old.recordId, "applied", Instant.now().toString())) }
            draft?.let { target.dao.putDraft(LibraryDraft("composer", it.requestId, it.title, it.markdown, it.kind, it.generation, Instant.now().toString())) }
            target.dao.putMeta(LibraryMeta("p0_migration", "complete"))
        }
    }

    @Synchronized fun closeForTest() {
        check(namespace != "shiwen-library-registry" && legacyNamespace != "shiwen-p0") { "PRODUCTION_CLEANUP_DENIED" }
        val names = registry.dao().all().map { it.dbFile } + registry.dao().allRestoreReservations().map { it.dbFile }
        val legacyPrefs = app.getSharedPreferences("$legacyNamespace-installation", Context.MODE_PRIVATE)
        val legacyLibraryId = legacyPrefs.getString("libraryId", null)
        cache.values.forEach { it.executor.shutdownNow(); it.db.close() }
        cache.clear(); registry.close()
        names.forEach { app.deleteDatabase(it) }
        legacyLibraryId?.let { app.deleteDatabase("$legacyNamespace-$it.sqlite") }
        app.deleteDatabase("$namespace.sqlite")
        app.getSharedPreferences("$namespace-context", Context.MODE_PRIVATE).edit().clear().commit()
        legacyPrefs.edit().clear().commit()
    }

    /** Close this manager's Room handles without deleting any user data. */
    @Synchronized fun close() {
        cache.values.forEach { it.executor.shutdownNow(); it.db.close() }
        cache.clear()
        registry.close()
    }

    companion object {
        private val restoreLocks = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.locks.ReentrantLock>()
    }
}
