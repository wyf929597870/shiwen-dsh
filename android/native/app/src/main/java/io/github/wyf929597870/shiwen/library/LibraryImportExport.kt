package io.github.wyf929597870.shiwen.library

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

internal data class LibraryExportDocument(val fileName: String, val mimeType: String, val bytes: ByteArray)
internal data class LibraryRestoreResult(val libraryId: String, val name: String, val restored: Int, val attachments: Int,
    val sourceLibraryId: String?, val role: String, val integrity: String, val requestId: String)

/** Record export/import and complete, integrity-checked local library archive support. */
internal class LibraryImportExport(private val files: LibraryFileTransfer) {
    fun importMarkdown(repo: LibraryRepository, uri: Uri): LibraryRecord {
        val bytes = files.readUri(uri, LibraryFileTransfer.MAX_MARKDOWN_BYTES)
        val name = displayName(uri)
        val raw = try {
            StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString().removePrefix("\uFEFF")
        } catch (_: Exception) { error("MARKDOWN_ENCODING_UNSUPPORTED") }
        require(raw.isNotBlank() && raw.length <= MAX_MARKDOWN_CHARS) { "INVALID_MARKDOWN_IMPORT" }
        val parsed = parseMarkdown(raw, name)
        val digest = sha256(bytes)
        val stableId = UUID.nameUUIDFromBytes("${repo.libraryId}\n$name\n$digest".toByteArray(StandardCharsets.UTF_8)).toString()
        return repo.importMarkdown(stableId, parsed.title, parsed.markdown, parsed.metadata,
            originalName = name, originalBytes = bytes, activityAction = "import")
    }

    fun exportRecord(repo: LibraryRepository, recordId: String): LibraryExportDocument {
        val row = repo.read(recordId)
        val metadata = buildString {
            append("---\n")
            append("title: ").append(yamlString(row.title)).append('\n')
            append("kind: ").append(row.kind).append('\n')
            append("origin: ").append(row.origin).append('\n')
            append("processing: ").append(row.processing).append('\n')
            append("stage: ").append(row.stage ?: "draft").append('\n')
            row.contentDay?.let { append("contentDay: ").append(it).append('\n') }
            append("dateBasis: ").append(yamlString(row.dateBasis)).append('\n')
            row.url?.let { append("url: ").append(yamlString(it)).append('\n') }
            row.annotation?.takeIf { it.isNotBlank() }?.let { append("annotation: ").append(yamlString(it)).append('\n') }
            append("---\n")
        }
        val bytes = (metadata + row.markdown).toByteArray(StandardCharsets.UTF_8)
        require(bytes.size.toLong() <= LibraryFileTransfer.MAX_MARKDOWN_BYTES) { "TRANSFER_TOO_LARGE" }
        val name = row.title.ifBlank { row.id }.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(120) + ".md"
        return LibraryExportDocument(name, "text/markdown", bytes)
    }

    /** Full backup: records, heads, all versions, activity, links, source provenance, and attachment bytes. */
    fun createBackup(repo: LibraryRepository, includeConversations: Boolean = true): ByteArray {
        val snapshot = repo.archiveSnapshot()
        snapshot.put("clientArchive", LibraryClientArchive(files.appContext).capture(repo, includeConversations))
        val descriptors = snapshot.optJSONArray("attachments") ?: JSONArray()
        val branchDescriptors = snapshot.optJSONArray("branchAttachments") ?: JSONArray()
        val blobs = LinkedHashMap<String, ByteArray>()
        val attachmentManifest = JSONArray()
        var blobBytes = 0L
        for (i in 0 until descriptors.length()) {
            val row = descriptors.getJSONObject(i)
            val id = row.getString("id")
            val hash = row.getString("hash").lowercase()
            require(hash.matches(HASH_PATTERN)) { "ARCHIVE_ATTACHMENT_DESCRIPTOR_INVALID" }
            val bytes = try { repo.attachmentBytes(id) } catch (_: Exception) {
                error("ARCHIVE_ATTACHMENT_UNAVAILABLE")
            }
            check(bytes.size.toLong() == row.getLong("byteLength") && sha256(bytes) == hash) { "ARCHIVE_ATTACHMENT_HASH_MISMATCH" }
            blobBytes += bytes.size
            check(blobBytes <= MAX_ARCHIVE_BLOB_BYTES) { "ARCHIVE_TOO_LARGE" }
            check(blobs.put(hash, bytes) == null || blobs[hash]!!.contentEquals(bytes)) { "ARCHIVE_ATTACHMENT_HASH_COLLISION" }
            attachmentManifest.put(JSONObject().put("id", id).put("entry", "attachments/$hash")
                .put("sha256", hash).put("byteLength", bytes.size))
        }
        for (i in 0 until branchDescriptors.length()) {
            val row = branchDescriptors.getJSONObject(i)
            val branchId = row.getString("branchId")
            val id = row.getString("attachmentId")
            val hash = row.getString("hash").lowercase()
            require(hash.matches(HASH_PATTERN)) { "ARCHIVE_ATTACHMENT_DESCRIPTOR_INVALID" }
            val bytes = try { repo.branchAttachmentBytes(branchId, id) } catch (_: Exception) {
                error("ARCHIVE_ATTACHMENT_UNAVAILABLE")
            }
            check(bytes.size.toLong() == row.getLong("byteLength") && sha256(bytes) == hash) { "ARCHIVE_ATTACHMENT_HASH_MISMATCH" }
            blobBytes += bytes.size
            check(blobBytes <= MAX_ARCHIVE_BLOB_BYTES) { "ARCHIVE_TOO_LARGE" }
            check(blobs.put(hash, bytes) == null || blobs[hash]!!.contentEquals(bytes)) { "ARCHIVE_ATTACHMENT_HASH_COLLISION" }
            attachmentManifest.put(JSONObject().put("id", id).put("branchId", branchId).put("entry", "attachments/$hash")
                .put("sha256", hash).put("byteLength", bytes.size))
        }
        val snapshotBytes = snapshot.toString().toByteArray(StandardCharsets.UTF_8)
        check(snapshotBytes.size <= MAX_SNAPSHOT_BYTES) { "ARCHIVE_SNAPSHOT_TOO_LARGE" }
        val manifest = JSONObject().put("format", ARCHIVE_FORMAT).put("formatVersion", ARCHIVE_VERSION)
            .put("createdAt", Instant.now().toString()).put("sourceLibraryId", snapshot.optString("libraryId"))
            .put("snapshotSha256", sha256(snapshotBytes)).put("attachmentCount", attachmentManifest.length())
            .put("attachments", attachmentManifest)
        val output = ByteArrayOutputStream()
        ZipOutputStream(output).use { zip ->
            zip.setLevel(6)
            putEntry(zip, "manifest.json", manifest.toString().toByteArray(StandardCharsets.UTF_8))
            putEntry(zip, "snapshot.json", snapshotBytes)
            for ((hash, bytes) in blobs) putEntry(zip, "attachments/$hash", bytes)
        }
        val result = output.toByteArray()
        check(result.size.toLong() <= LibraryFileTransfer.MAX_BACKUP_BYTES) { "ARCHIVE_TOO_LARGE" }
        return result
    }

    fun createEncryptedBackup(repo: LibraryRepository, password: CharArray, includeConversations: Boolean = true): ByteArray =
        LibraryArchiveCrypto.encrypt(createBackup(repo, includeConversations), password)

    fun decodeBackup(bytes: ByteArray, password: CharArray? = null): ValidatedLibraryArchive {
        require(bytes.size.toLong() in 1..LibraryFileTransfer.MAX_TRANSFER_BYTES) { "ARCHIVE_SIZE_INVALID" }
        val plain = if (LibraryArchiveCrypto.isEncrypted(bytes)) {
            LibraryArchiveCrypto.decrypt(bytes, password ?: error("BACKUP_PASSWORD_REQUIRED"))
        } else bytes
        require(plain.size.toLong() in 1..LibraryFileTransfer.MAX_BACKUP_BYTES) { "ARCHIVE_SIZE_INVALID" }
        val entries = readZip(plain)
        val manifest = JSONObject(entries["manifest.json"]?.toString(StandardCharsets.UTF_8) ?: error("ARCHIVE_MANIFEST_MISSING"))
        check(manifest.optString("format") == ARCHIVE_FORMAT && manifest.optInt("formatVersion") == ARCHIVE_VERSION) {
            "ARCHIVE_VERSION_UNSUPPORTED"
        }
        val snapshotBytes = entries["snapshot.json"] ?: error("ARCHIVE_SNAPSHOT_MISSING")
        check(sha256(snapshotBytes) == manifest.getString("snapshotSha256")) { "ARCHIVE_DIGEST_MISMATCH" }
        val snapshot = JSONObject(snapshotBytes.toString(StandardCharsets.UTF_8))
        check(snapshot.optInt("formatVersion") in SUPPORTED_SNAPSHOT_VERSIONS) { "ARCHIVE_VERSION_UNSUPPORTED" }
        snapshot.optJSONObject("clientArchive")?.let(LibraryClientArchive::validate)
        check(manifest.optString("sourceLibraryId") == snapshot.optString("libraryId")) { "ARCHIVE_LIBRARY_ID_MISMATCH" }
        runCatching { UUID.fromString(snapshot.optString("libraryId")) }.getOrElse { error("ARCHIVE_LIBRARY_ID_INVALID") }
        val descriptors = snapshot.optJSONArray("attachments") ?: JSONArray()
        val manifestAttachments = manifest.optJSONArray("attachments") ?: JSONArray()
        val branchDescriptors = snapshot.optJSONArray("branchAttachments") ?: JSONArray()
        check(descriptors.length() + branchDescriptors.length() == manifestAttachments.length() &&
            manifestAttachments.length() == manifest.optInt("attachmentCount")) {
            "ARCHIVE_ATTACHMENT_MANIFEST_MISMATCH"
        }
        val attachmentBytes = LinkedHashMap<String, ByteArray>()
        val expectedEntries = mutableSetOf("manifest.json", "snapshot.json")
        for (i in 0 until descriptors.length()) {
            val descriptor = descriptors.getJSONObject(i)
            val id = descriptor.getString("id")
            val metadata = (0 until manifestAttachments.length()).map { manifestAttachments.getJSONObject(it) }
                .firstOrNull { it.optString("id") == id && !it.has("branchId") }
                ?: error("ARCHIVE_ATTACHMENT_MANIFEST_MISMATCH")
            val hash = descriptor.getString("hash").lowercase()
            val entry = "attachments/$hash"
            check(metadata.getString("id") == id && metadata.getString("entry") == entry &&
                metadata.getString("sha256").lowercase() == hash && metadata.getLong("byteLength") == descriptor.getLong("byteLength")) {
                "ARCHIVE_ATTACHMENT_MANIFEST_MISMATCH"
            }
            val blob = entries[entry] ?: error("ARCHIVE_ATTACHMENT_MISSING")
            check(blob.size.toLong() == descriptor.getLong("byteLength") && sha256(blob) == hash) { "ARCHIVE_ATTACHMENT_HASH_MISMATCH" }
            expectedEntries += entry
            attachmentBytes[id] = blob
        }
        val branchIds = (0 until (snapshot.optJSONArray("branches")?.length() ?: 0))
            .map { snapshot.getJSONArray("branches").getJSONObject(it).getString("branchId") }.toSet()
        for (i in 0 until branchDescriptors.length()) {
            val descriptor = branchDescriptors.getJSONObject(i)
            val branchId = descriptor.getString("branchId")
            val id = descriptor.getString("attachmentId")
            check(branchId in branchIds) { "ARCHIVE_BRANCH_ATTACHMENT_INVALID" }
            val hash = descriptor.getString("hash").lowercase()
            val entry = "attachments/$hash"
            val metadata = (0 until manifestAttachments.length()).map { manifestAttachments.getJSONObject(it) }
                .firstOrNull { it.optString("id") == id && it.optString("branchId") == branchId }
                ?: error("ARCHIVE_ATTACHMENT_MANIFEST_MISMATCH")
            check(metadata.getString("entry") == entry && metadata.getString("sha256").lowercase() == hash &&
                metadata.getLong("byteLength") == descriptor.getLong("byteLength")) { "ARCHIVE_ATTACHMENT_MANIFEST_MISMATCH" }
            val blob = entries[entry] ?: error("ARCHIVE_ATTACHMENT_MISSING")
            check(blob.size.toLong() == descriptor.getLong("byteLength") && sha256(blob) == hash) { "ARCHIVE_ATTACHMENT_HASH_MISMATCH" }
            expectedEntries += entry
            attachmentBytes["$branchId/$id"] = blob
        }
        check(entries.keys == expectedEntries) { "ARCHIVE_UNEXPECTED_ENTRY" }
        return ValidatedLibraryArchive(snapshot, attachmentBytes)
    }

    fun restoreBackup(manager: LibraryManager, bytes: ByteArray, name: String, password: CharArray? = null,
        asNewLibrary: Boolean = false, requestId: String): LibraryRestoreResult {
        require(runCatching { UUID.fromString(requestId) }.isSuccess) { "INVALID_REQUEST_ID" }
        val archive = decodeBackup(bytes, password)
        val sourceLibraryId = archive.snapshot.optString("libraryId")
        val fingerprint = archiveFingerprint(archive, name.trim(), asNewLibrary)
        val restored = manager.restoreArchive(archive.snapshot, archive.attachmentBytes, name, requestId, fingerprint, asNewLibrary)
        val context = restored.context()
        return LibraryRestoreResult(context.libraryId, restored.registryItem().name,
            archive.snapshot.optJSONArray("records")?.length() ?: 0,
            (archive.snapshot.optJSONArray("attachments")?.length() ?: 0) + (archive.snapshot.optJSONArray("branchAttachments")?.length() ?: 0),
            sourceLibraryId, context.role, context.integrity, requestId)
    }

    private fun archiveFingerprint(archive: ValidatedLibraryArchive, name: String, asNewLibrary: Boolean): String {
        val digest = MessageDigest.getInstance("SHA-256")
        fun add(bytes: ByteArray) {
            digest.update(ByteBuffer.allocate(8).putLong(bytes.size.toLong()).array())
            digest.update(bytes)
        }
        add(name.toByteArray(StandardCharsets.UTF_8))
        add(byteArrayOf(if (asNewLibrary) 1 else 0))
        add(archive.snapshot.toString().toByteArray(StandardCharsets.UTF_8))
        archive.attachmentBytes.toSortedMap().forEach { (key, bytes) ->
            add(key.toByteArray(StandardCharsets.UTF_8)); add(bytes)
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun copyRecordText(source: LibraryRepository, target: LibraryRepository, recordId: String, requestId: String): LibraryRecord {
        check(source.libraryId != target.libraryId) { "COPY_TARGET_MUST_DIFFER" }
        val row = source.read(recordId)
        check(!row.deleted) { "RECORD_NOT_FOUND" }
        val descriptors = JSONArray(row.attachmentDescriptorsJson)
        val namesById = buildMap {
            for (i in 0 until descriptors.length()) {
                val item = descriptors.getJSONObject(i)
                put(item.optString("id"), item.optString("name").ifBlank { "附件" })
                put(item.optString("hash"), item.optString("name").ifBlank { "附件" })
            }
        }
        val notes = linkedSetOf<String>()
        fun attachmentNote(refValue: String): String {
            val ref = refValue.trim().trim('/').substringAfterLast('/')
            val name = namesById[ref]
            notes += if (name != null) "原件附件未复制：$name" else "原件附件未复制（来源记录 ${row.id}）"
            return if (name != null) "附件未复制：$name" else "原件附件未复制"
        }
        fun copyReadableText(value: String): String {
            val markdownLink = Regex("(!?)\\[([^]]*)]\\(attachment:(?:/+)?([^)\\s]+)\\)", RegexOption.IGNORE_CASE)
            val markdownWithLinkNotes = markdownLink.replace(value) { match ->
                val note = attachmentNote(match.groupValues[3])
                if (match.groupValues[1] == "!") "${match.groupValues[2]} [${note}]"
                else "${match.groupValues[2]}（${note}）"
            }
            val attachmentPattern = Regex("attachment:(?:/+)?([^\\s)>]+)", RegexOption.IGNORE_CASE)
            return attachmentPattern.replace(markdownWithLinkNotes) { match -> "[${attachmentNote(match.groupValues[1])}]" }
        }
        val copiedMarkdown = copyReadableText(row.markdown)
        val sourceIds = JSONArray(row.sourceIdsJson)
        if (sourceIds.length() > 0) notes += "原资料库中有 ${sourceIds.length()} 条关联记录，跨库后未保留关联。"
        val originalSources = JSONArray(row.sourcesJson)
        var copiedSources = JSONArray()
        for (i in 0 until originalSources.length()) {
            val segment = originalSources.getJSONObject(i)
            val origin = segment.optString("origin", "unknown").takeIf { it in ORIGINS } ?: "unknown"
            val sourceRef = segment.optString("sourceRef").takeIf { it.isNotBlank() }
            val isAttachment = sourceRef?.startsWith("attachment:", ignoreCase = true) == true
            val text = copyReadableText(segment.optString("text"))
            val mappedOrigin = if (isAttachment) "unknown" else origin
            if (isAttachment) notes += attachmentNote(sourceRef!!.substringAfter(':'))
            val mappedText = text
            val copied = JSONObject().put("text", mappedText).put("origin", mappedOrigin)
            if (sourceRef != null && !isAttachment) {
                val sourceReference = "源资料库 ${source.libraryId} · $sourceRef"
                copied.put("sourceRef", sourceReference)
                notes += "原始来源（资料库 ${source.libraryId}）：$sourceRef"
            }
            copiedSources.put(copied)
        }
        val baseBody = copiedMarkdown
        var fallbackProvenance: JSONObject? = null
        val joinedSources = (0 until copiedSources.length()).joinToString("") { copiedSources.getJSONObject(it).optString("text") }
        if (joinedSources != baseBody) {
            if (baseBody.startsWith(joinedSources)) {
                copiedSources.put(JSONObject().put("text", baseBody.substring(joinedSources.length)).put("origin", "unknown"))
            } else {
                // Older irregular rows can contain source segments that do not align with the body.
                // Keep the original mapping in provenance and expose the copied body as unknown.
                fallbackProvenance = JSONObject().put("originalSources", originalSources).put("sourceLibraryId", source.libraryId)
                copiedSources = JSONArray().put(JSONObject().put("text", baseBody).put("origin", "unknown")
                    .put("sourceRef", "provenance:${source.libraryId}:${row.id}"))
                notes += "原始来源分段与正文不一致，已保留在来源说明中。"
            }
        }
        val noteText = if (notes.isEmpty()) "" else
            "\n\n> 跨资料库复制说明：正文已复制；附件文件与原资料库关联未复制。\n" + notes.joinToString("\n") { "> - $it" }
        val markdown = baseBody + noteText
        if (noteText.isNotEmpty()) copiedSources.put(JSONObject().put("text", noteText).put("origin", "unknown"))
        val origins = (0 until copiedSources.length()).mapNotNull { copiedSources.optJSONObject(it)?.optString("origin") }.toSet()
        val copiedOrigin = origins.singleOrNull() ?: "unknown"
        val metadata = JSONObject().put("kind", row.kind).put("origin", copiedOrigin).put("processing", row.processing)
            .put("contentDay", row.contentDay ?: JSONObject.NULL).put("dateBasis", row.dateBasis)
            .put("url", row.url ?: JSONObject.NULL).put("annotation", row.annotation ?: JSONObject.NULL)
            .put("stage", row.stage ?: "draft").put("sources", copiedSources)
        fallbackProvenance?.let { metadata.put("provenance", it) }
        // Cross-library copy intentionally copies readable text and record metadata only. It does not
        // copy attachment blobs or source links whose IDs belong to the source library.
        return target.importMarkdown(requestId, row.title, markdown, metadata, activityAction = "copy")
    }

    fun shareRecordIntent(repo: LibraryRepository, recordId: String, chooserTitle: String): android.content.Intent {
        val document = exportRecord(repo, recordId)
        return files.shareIntent(document.fileName, document.mimeType, document.bytes, chooserTitle)
    }

    private fun parseMarkdown(input: String, fileName: String): ParsedMarkdown {
        val lines = input.replace("\r\n", "\n").replace('\r', '\n')
        val firstBreak = lines.indexOf('\n')
        if (!lines.startsWith("---\n") || firstBreak < 0) {
            return ParsedMarkdown(titleFrom(lines, fileName), lines, JSONObject().put("kind", "reference")
                .put("origin", "external").put("processing", "original"))
        }
        val close = Regex("(?m)^---\\s*$|^\\.\\.\\.\\s*$").find(lines, 4) ?: return ParsedMarkdown(
            titleFrom(lines, fileName), lines, JSONObject().put("kind", "reference").put("origin", "external").put("processing", "original"))
        val header = lines.substring(4, close.range.first)
        val values = linkedMapOf<String, String>()
        header.lineSequence().forEach { line ->
            val m = FRONTMATTER_LINE.matchEntire(line) ?: return@forEach
            values[m.groupValues[1]] = unquote(m.groupValues[2].trim())
        }
        val supported = setOf("title", "contentDay", "date", "dateBasis", "kind", "origin", "processing", "url", "annotation", "stage")
        val malformed = header.lineSequence().any { it.isNotBlank() && !FRONTMATTER_LINE.matches(it) }
        val invalidKnownValue = values["kind"]?.let { it !in KINDS } == true ||
            values["origin"]?.let { it !in ORIGINS } == true ||
            values["processing"]?.let { it !in PROCESSING } == true ||
            values["stage"]?.let { it !in STAGES } == true ||
            values["annotation"]?.length?.let { it > 10_000 } == true ||
            values["url"]?.let { !it.startsWith("https://") && !it.startsWith("http://") } == true ||
            (values["contentDay"] ?: values["date"])?.let {
                !ISO_DAY.matches(it) || runCatching { LocalDate.parse(it) }.isFailure
            } == true
        val unknown = malformed || invalidKnownValue || values.keys.any { it !in supported }
        val body = if (unknown) lines else lines.substring(close.range.last + 1).trimStart('\n')
        val title = values["title"]?.takeIf { it.isNotBlank() } ?: titleFrom(body, fileName)
        val metadata = JSONObject().put("kind", values["kind"]?.takeIf { it in KINDS } ?: "reference")
            .put("origin", values["origin"]?.takeIf { it in ORIGINS } ?: "external")
            .put("processing", values["processing"]?.takeIf { it in PROCESSING } ?: "original")
        val day = values["contentDay"] ?: values["date"]
        if (day != null && ISO_DAY.matches(day) && runCatching { LocalDate.parse(day) }.isSuccess)
            metadata.put("contentDay", day).put("dateBasis", values["dateBasis"] ?: "markdown-frontmatter")
        if (values["url"]?.startsWith("https://") == true || values["url"]?.startsWith("http://") == true) metadata.put("url", values.getValue("url"))
        if (values["annotation"] != null) metadata.put("annotation", values.getValue("annotation").take(10_000))
        values["stage"]?.takeIf { it in STAGES }?.let { metadata.put("stage", it) }
        return ParsedMarkdown(title.take(200), body, metadata)
    }

    private fun titleFrom(markdown: String, fileName: String): String {
        val heading = markdown.lineSequence().firstOrNull { it.trimStart().startsWith("# ") }
            ?.trim()?.removePrefix("# ")?.trim()?.takeIf { it.isNotBlank() }
        val fallback = fileName.substringAfterLast('/').substringAfterLast('\\').substringBeforeLast('.')
        return (heading ?: fallback.ifBlank { "导入材料" }).take(200)
    }

    private fun displayName(uri: Uri): String {
        val fromPath = uri.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':')?.takeIf { it.isNotBlank() }
        return (fromPath ?: "导入材料.md").take(180)
    }

    private fun readZip(bytes: ByteArray): Map<String, ByteArray> {
        val entries = LinkedHashMap<String, ByteArray>()
        var total = 0L
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                if (entry.isDirectory) { zip.closeEntry(); continue }
                check(entries.size < MAX_ARCHIVE_ENTRIES) { "ARCHIVE_TOO_MANY_ENTRIES" }
                val name = entry.name
                check(name == "manifest.json" || name == "snapshot.json" || name.matches(ARCHIVE_ATTACHMENT_PATH)) {
                    "ARCHIVE_INVALID_ENTRY"
                }
                check(!entries.containsKey(name)) { "ARCHIVE_DUPLICATE_ENTRY" }
                val sink = ByteArrayOutputStream()
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var entryBytes = 0L
                while (true) {
                    val count = zip.read(buffer)
                    if (count < 0) break
                    entryBytes += count; total += count
                    check(entryBytes <= MAX_ARCHIVE_ENTRY_BYTES && total <= LibraryFileTransfer.MAX_BACKUP_BYTES) { "ARCHIVE_TOO_LARGE" }
                    sink.write(buffer, 0, count)
                }
                entries[name] = sink.toByteArray()
                zip.closeEntry()
            }
        }
        return entries
    }

    private fun putEntry(zip: ZipOutputStream, name: String, bytes: ByteArray) {
        zip.putNextEntry(ZipEntry(name))
        zip.write(bytes)
        zip.closeEntry()
    }

    private fun unquote(value: String): String = when {
        value.length >= 2 && ((value.first() == '"' && value.last() == '"') || (value.first() == '\'' && value.last() == '\'')) -> value.substring(1, value.length - 1)
        else -> value.substringBefore(" #").trim()
    }

    private fun yamlString(value: String): String = JSONObject.quote(value)

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }

    private data class ParsedMarkdown(val title: String, val markdown: String, val metadata: JSONObject)
    internal data class ValidatedLibraryArchive(val snapshot: JSONObject, val attachmentBytes: Map<String, ByteArray>)

    companion object {
        private const val ARCHIVE_FORMAT = "shiwen-library-archive"
        private const val ARCHIVE_VERSION = 1
        private val SUPPORTED_SNAPSHOT_VERSIONS = setOf(1, 2)
        private const val MAX_MARKDOWN_CHARS = 1_000_000
        private const val MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
        private const val MAX_ARCHIVE_BLOB_BYTES = 20L * 1024 * 1024
        private const val MAX_ARCHIVE_ENTRIES = 20_000
        private const val MAX_ARCHIVE_ENTRY_BYTES = 32L * 1024 * 1024
        private val HASH_PATTERN = Regex("[a-f0-9]{64}")
        private val ARCHIVE_ATTACHMENT_PATH = Regex("attachments/[a-f0-9]{64}")
        private val FRONTMATTER_LINE = Regex("([A-Za-z][A-Za-z0-9_-]{0,63}):\\s*(.*)")
        private val ISO_DAY = Regex("\\d{4}-\\d{2}-\\d{2}")
        private val KINDS = setOf("journal", "freewrite", "idea", "web", "ai", "reference", "article")
        private val ORIGINS = setOf("personal", "external", "ai", "translation", "unknown")
        private val PROCESSING = setOf("original", "formatting", "ai-organized", "translation", "unknown")
        private val STAGES = setOf("idea", "draft", "revision", "final")
    }
}
