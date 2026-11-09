package io.github.wyf929597870.shiwen.library

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

internal data class LibraryExportDocument(val fileName: String, val mimeType: String, val file: File)
internal data class LibraryRestoreResult(val libraryId: String, val name: String, val restored: Int, val attachments: Int,
    val sourceLibraryId: String?, val role: String, val integrity: String, val requestId: String, val warnings: List<String> = emptyList())

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
        val name = row.title.ifBlank { row.id }.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(120) + ".md"
        val file = File.createTempFile("shiwen-export-", ".md", files.appContext.cacheDir)
        try {
            FileOutputStream(file).buffered().use { output ->
                output.write(recordMarkdownHeader(row).toByteArray(StandardCharsets.UTF_8))
                output.write(row.markdown.toByteArray(StandardCharsets.UTF_8))
            }
            require(file.length() <= LibraryFileTransfer.MAX_MARKDOWN_BYTES) { "TRANSFER_TOO_LARGE" }
            return LibraryExportDocument(name, "text/markdown", file)
        } catch (error: Exception) { file.delete(); throw error }
    }

    /** Export the current Markdown and its referenced library images as portable relative files. */
    fun exportRecordWithImages(repo: LibraryRepository, recordId: String): LibraryExportDocument {
        val record = repo.read(recordId)
        val descriptors = JSONArray(record.attachmentDescriptorsJson)
        val available = (0 until descriptors.length()).associate { index ->
            val item = descriptors.getJSONObject(index)
            item.getString("id") to item
        }
        val pattern = Regex("!\\[([^\\r\\n]*?)]\\(([^)\\r\\n]+)\\)|!\\[\\[([^\\r\\n]*?)]]", RegexOption.IGNORE_CASE)
        val imported = repo.dao.provenance(recordId)?.json?.let(::JSONObject)?.optJSONObject("import")
        val links = imported?.optJSONArray("links") ?: JSONArray()
        val base = imported?.optString("sourceName", "")?.substringBeforeLast('/', "") ?: ""
        fun resolveLegacy(value: String): String {
            val raw = Uri.decode(value).substringBefore('#').replace('\\', '/')
            require(!raw.startsWith('/') && !Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(raw)) { "EXPORT_IMAGE_MAPPING_INVALID" }
            val normalized = java.nio.file.Paths.get(base, raw).normalize().toString().replace('\\', '/')
            require(!normalized.startsWith("../") && normalized != ".." && !normalized.startsWith('/')) { "EXPORT_IMAGE_MAPPING_INVALID" }
            val matches = (0 until links.length()).map { links.getJSONObject(it) }.filter {
                it.optString("relativePath") == normalized || it.optString("relativePath") == raw
            }.mapNotNull { it.optString("targetAttachmentId").takeIf { id -> id.isNotBlank() && id != "null" } }.distinct()
            return matches.singleOrNull() ?: error("EXPORT_IMAGE_MAPPING_MISSING")
        }
        val images = linkedMapOf<String, Pair<LibraryArchiveFile, String>>()
        val body = StringBuilder(); var cursor = 0
        for (match in pattern.findAll(LibraryImageCopy.maskCode(record.markdown))) {
            body.append(record.markdown, cursor, match.range.first)
            val wiki = match.groupValues[3].isNotEmpty()
            val pieces = if (wiki) match.groupValues[3].split('|', limit = 2) else emptyList()
            val raw = if (wiki) pieces[0] else match.groupValues[2].substringBefore(" \"")
            if (raw.startsWith("http://", true) || raw.startsWith("https://", true)) {
                body.append(record.markdown, match.range.first, match.range.last + 1);cursor = match.range.last + 1;continue
            }
            val direct = raw.startsWith("attachment:", true)
            val id = if (direct) raw.substringAfter(':') else resolveLegacy(raw)
            UUID.fromString(id)
            require(!direct || available.containsKey(id)) { "EXPORT_IMAGE_MISSING" }
            val source = repo.attachmentArchiveFile(id)
            val extension = when (LibraryAttachmentDraftStore.imageMime(source.file)) {
                "image/png" -> "png"
                "image/jpeg" -> "jpg"
                "image/gif" -> "gif"
                "image/webp" -> "webp"
                else -> error("EXPORT_IMAGE_FORMAT_UNSUPPORTED")
            }
            val name = "images/$id.$extension"
            images.putIfAbsent(id, source to name)
            val label = (if (wiki) pieces.getOrElse(1) { pieces[0] } else match.groupValues[1]).replace("]", "_")
            body.append("![$label]($name)");cursor = match.range.last + 1
        }
        body.append(record.markdown, cursor, record.markdown.length)
        val fileName = record.title.ifBlank { record.id }.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(120) + ".md"
        val outputFile = File.createTempFile("shiwen-export-images-", ".zip", files.appContext.cacheDir)
        try {
            ZipOutputStream(BufferedOutputStream(FileOutputStream(outputFile))).use { zip ->
                zip.setLevel(6)
                putEntry(zip, fileName, recordMarkdownHeader(record).plus(body.toString()).toByteArray(StandardCharsets.UTF_8))
                val children = if (record.kind == "ai_annotation") emptyList() else repo.annotationList(record.id)
                val index = JSONArray()
                val exportedVersions = mutableSetOf<String>()
                for (child in children) {
                    val childExport = exportRecordWithImages(repo, child.id)
                    try {
                        val prefix = "annotations/${child.id}/"
                        java.util.zip.ZipFile(childExport.file).use { childZip ->
                            val entries = childZip.entries()
                            while (entries.hasMoreElements()) {
                                val entry = entries.nextElement()
                                require(!entry.isDirectory && !entry.name.contains("..") && !entry.name.startsWith('/')) { "EXPORT_IMAGE_MAPPING_INVALID" }
                                zip.putNextEntry(java.util.zip.ZipEntry(prefix + entry.name))
                                childZip.getInputStream(entry).use { it.copyTo(zip) }
                                zip.closeEntry()
                            }
                        }
                        val anchor = JSONObject(child.annotationOfJson!!)
                        val versionId = anchor.getString("versionId")
                        UUID.fromString(versionId)
                        val originalVersion = repo.dao.versions(record.id).firstOrNull { it.id == versionId } ?: error("ANNOTATION_SOURCE_VERSION_MISSING")
                        val bytes = originalVersion.markdown.toByteArray(StandardCharsets.UTF_8)
                        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                        check(digest == anchor.getString("contentHash")) { "ANNOTATION_SOURCE_HASH_MISMATCH" }
                        val versionPath = "versions/$versionId.md"
                        if (exportedVersions.add(versionId)) putEntry(zip, versionPath, bytes)
                        index.put(JSONObject().put("id", child.id).put("title", child.title)
                            .put("annotationOf", anchor).put("originalVersion", versionPath).put("directory", prefix))
                    } finally { childExport.file.delete() }
                }
                if (children.isNotEmpty()) putEntry(zip, "annotations/index.json", index.toString(2).toByteArray(StandardCharsets.UTF_8))
                var total = 0L
                for ((_, pair) in images) {
                    val (source, path) = pair
                    total += source.byteLength
                    require(total <= MAX_BACKUP_BYTES) { "TRANSFER_TOO_LARGE" }
                    putFileEntry(zip, path, source, MAX_BACKUP_BYTES)
                }
            }
            require(outputFile.length() <= MAX_BACKUP_BYTES) { "TRANSFER_TOO_LARGE" }
            return LibraryExportDocument(fileName.removeSuffix(".md") + ".zip", "application/zip", outputFile)
        } catch (error: Exception) { outputFile.delete(); throw error }
    }

    private fun recordMarkdownHeader(row: LibraryRecord) = buildString {
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

    /** Full backup: records, heads, all versions, activity, links, source provenance, and attachment bytes. */
    fun createBackup(repo: LibraryRepository, includeConversations: Boolean = true): File {
        val snapshot = repo.archiveSnapshot()
        snapshot.put("clientArchive", LibraryClientArchive(files.appContext).capture(repo, includeConversations))
        val descriptors = snapshot.optJSONArray("attachments") ?: JSONArray()
        val branchDescriptors = snapshot.optJSONArray("branchAttachments") ?: JSONArray()
        val clientArchive = snapshot.optJSONObject("clientArchive") ?: error("CLIENT_ARCHIVE_MISSING")
        val draftDescriptors = clientArchive.optJSONArray("draftAttachments") ?: JSONArray()
        val attachmentManifest = JSONArray()
        val draftAttachmentManifest = JSONArray()
        val written = mutableSetOf<String>()
        var blobBytes = 0L
        validateAttachmentReferences(snapshot, strict = true)
        val snapshotBytes = snapshot.toString().toByteArray(StandardCharsets.UTF_8)
        check(snapshotBytes.size <= MAX_SNAPSHOT_BYTES) { "ARCHIVE_SNAPSHOT_TOO_LARGE" }
        val manifest = JSONObject().put("format", ARCHIVE_FORMAT).put("formatVersion", ARCHIVE_VERSION)
            .put("createdAt", Instant.now().toString()).put("sourceLibraryId", snapshot.optString("libraryId"))
            .put("snapshotSha256", sha256(snapshotBytes)).put("attachmentCount", descriptors.length() + (snapshot.optJSONArray("branchAttachments")?.length() ?: 0))
            .put("attachments", attachmentManifest).put("draftAttachments", draftAttachmentManifest)
        val outputFile = File.createTempFile("shiwen-backup-", ".zip", files.appContext.cacheDir)
        try {
            ZipOutputStream(BufferedOutputStream(FileOutputStream(outputFile))).use { zip ->
                zip.setLevel(6)
                putEntry(zip, "snapshot.json", snapshotBytes)
                for (i in 0 until descriptors.length()) {
                    val row = descriptors.getJSONObject(i)
                    val id = row.getString("id")
                    val hash = row.getString("hash").lowercase()
                    require(hash.matches(HASH_PATTERN)) { "ARCHIVE_ATTACHMENT_DESCRIPTOR_INVALID" }
                    val payload = try { repo.attachmentArchiveFile(id) } catch (_: Exception) { error("ARCHIVE_ATTACHMENT_UNAVAILABLE") }
                    check(payload.byteLength == row.getLong("byteLength") && payload.sha256 == hash) { "ARCHIVE_ATTACHMENT_HASH_MISMATCH" }
                    blobBytes += payload.byteLength
                    check(blobBytes <= MAX_ARCHIVE_BLOB_BYTES) { "ARCHIVE_TOO_LARGE" }
                    if (written.add(hash)) putFileEntry(zip, "attachments/$hash", payload, MAX_BACKUP_BYTES)
                    attachmentManifest.put(JSONObject().put("id", id).put("entry", "attachments/$hash")
                        .put("sha256", hash).put("byteLength", payload.byteLength))
                }
                for (i in 0 until branchDescriptors.length()) {
                    val row = branchDescriptors.getJSONObject(i)
                    val branchId = row.getString("branchId")
                    val id = row.getString("attachmentId")
                    val hash = row.getString("hash").lowercase()
                    require(hash.matches(HASH_PATTERN)) { "ARCHIVE_ATTACHMENT_DESCRIPTOR_INVALID" }
                    val payload = try { repo.branchAttachmentArchiveFile(branchId, id) } catch (_: Exception) { error("ARCHIVE_ATTACHMENT_UNAVAILABLE") }
                    check(payload.byteLength == row.getLong("byteLength") && payload.sha256 == hash) { "ARCHIVE_ATTACHMENT_HASH_MISMATCH" }
                    blobBytes += payload.byteLength
                    check(blobBytes <= MAX_ARCHIVE_BLOB_BYTES) { "ARCHIVE_TOO_LARGE" }
                    if (written.add(hash)) putFileEntry(zip, "attachments/$hash", payload, MAX_BACKUP_BYTES)
                    attachmentManifest.put(JSONObject().put("id", id).put("branchId", branchId).put("entry", "attachments/$hash")
                        .put("sha256", hash).put("byteLength", payload.byteLength))
                }
                val draftStore = LibraryAttachmentDraftStore(files.appContext, snapshot.getString("libraryId"))
                for (i in 0 until draftDescriptors.length()) {
                    val descriptor = draftDescriptors.getJSONObject(i)
                    val id = descriptor.getString("id")
                    check(runCatching { UUID.fromString(id) }.isSuccess && UUID.fromString(id).toString() == id) { "ARCHIVE_DRAFT_ATTACHMENT_INVALID" }
                    val payload = try { draftStore.archiveFile(id) } catch (_: Exception) { error("ARCHIVE_DRAFT_ATTACHMENT_UNAVAILABLE") }
                    check(payload.byteLength == descriptor.getLong("byteLength") && payload.sha256 == descriptor.getString("hash") &&
                        LibraryAttachmentDraftStore.imageMime(payload.file) == descriptor.getString("mimeType")) {
                        "ARCHIVE_DRAFT_ATTACHMENT_HASH_MISMATCH"
                    }
                    blobBytes += payload.byteLength
                    check(blobBytes <= MAX_ARCHIVE_BLOB_BYTES) { "ARCHIVE_TOO_LARGE" }
                    putFileEntry(zip, "draft-attachments/$id", payload, LibraryAttachmentDraftStore.MAX_IMAGE_BYTES.toLong())
                    draftAttachmentManifest.put(JSONObject(descriptor.toString()).put("entry", "draft-attachments/$id")
                        .put("sha256", payload.sha256).put("byteLength", payload.byteLength))
                }
                manifest.put("draftAttachments", draftAttachmentManifest)
                putEntry(zip, "manifest.json", manifest.toString().toByteArray(StandardCharsets.UTF_8))
            }
            check(outputFile.length() in 1..MAX_BACKUP_BYTES) { "ARCHIVE_TOO_LARGE" }
            return outputFile
        } catch (error: Exception) { outputFile.delete(); throw error }
    }

    fun createEncryptedBackup(repo: LibraryRepository, password: CharArray, includeConversations: Boolean = true): File {
        val plain = createBackup(repo, includeConversations)
        val encrypted = File.createTempFile("shiwen-backup-encrypted-", ".shiwen", files.appContext.cacheDir)
        try {
            LibraryArchiveCrypto.encryptFile(plain, encrypted, password, MAX_BACKUP_BYTES)
            return encrypted
        } catch (error: Exception) { encrypted.delete(); throw error }
        finally { plain.delete() }
    }

    fun decodeBackup(bytes: ByteArray, password: CharArray? = null): ValidatedLibraryArchive {
        val source = File.createTempFile("shiwen-import-test-", ".backup", files.appContext.cacheDir)
        try { FileOutputStream(source).use { it.write(bytes) }; return decodeBackup(source, password) }
        finally { source.delete() }
    }

    fun decodeBackup(source: File, password: CharArray? = null): ValidatedLibraryArchive {
        require(source.isFile && source.length() in 1..MAX_BACKUP_BYTES + 1024L * 1024) { "ARCHIVE_SIZE_INVALID" }
        val tempRoot = File.createTempFile("shiwen-archive-stage-", "", files.appContext.cacheDir).apply {
            check(delete() && mkdirs()) { "ARCHIVE_TEMP_UNAVAILABLE" }
        }
        try {
            val zipFile = if (LibraryArchiveCrypto.isEncrypted(source)) {
                val decrypted = File(tempRoot, "archive.zip")
                LibraryArchiveCrypto.decryptFile(source, decrypted, password ?: error("BACKUP_PASSWORD_REQUIRED"), MAX_BACKUP_BYTES)
                decrypted
            } else {
                check(source.length() <= MAX_BACKUP_BYTES) { "ARCHIVE_SIZE_INVALID" }
                source
            }
            val entries = extractZip(zipFile, tempRoot)
            val manifest = JSONObject(entries["manifest.json"]?.bytes?.toString(StandardCharsets.UTF_8) ?: error("ARCHIVE_MANIFEST_MISSING"))
        val archiveVersion = manifest.optInt("formatVersion")
        check(manifest.optString("format") == ARCHIVE_FORMAT && archiveVersion in SUPPORTED_ARCHIVE_VERSIONS) {
            "ARCHIVE_VERSION_UNSUPPORTED"
        }
        val snapshotBytes = entries["snapshot.json"]?.bytes ?: error("ARCHIVE_SNAPSHOT_MISSING")
        check(sha256(snapshotBytes) == manifest.getString("snapshotSha256")) { "ARCHIVE_DIGEST_MISMATCH" }
        val snapshot = JSONObject(snapshotBytes.toString(StandardCharsets.UTF_8))
        check(snapshot.optInt("formatVersion") in SUPPORTED_SNAPSHOT_VERSIONS) { "ARCHIVE_VERSION_UNSUPPORTED" }
        val clientArchive = snapshot.optJSONObject("clientArchive")
        clientArchive?.let(LibraryClientArchive::validate)
        val draftDescriptors = clientArchive?.optJSONArray("draftAttachments") ?: JSONArray()
        val manifestDraftAttachments = if (archiveVersion >= 2) manifest.optJSONArray("draftAttachments")
            ?: error("ARCHIVE_DRAFT_ATTACHMENT_MANIFEST_MISSING") else manifest.optJSONArray("draftAttachments") ?: JSONArray()
        check((archiveVersion < 2 && clientArchive?.has("draftAttachments") != true && !manifest.has("draftAttachments") ||
            archiveVersion >= 2 && clientArchive?.has("draftAttachments") == true) &&
            draftDescriptors.length() == manifestDraftAttachments.length()) { "ARCHIVE_DRAFT_ATTACHMENT_MANIFEST_MISMATCH" }
        if (archiveVersion == 1 && clientArchive != null) {
            check(LibraryClientArchive.draftAttachmentReferences(clientArchive.getJSONArray("editorDrafts")).isEmpty()) {
                "ARCHIVE_DRAFT_ATTACHMENT_MISSING"
            }
        }
        check((0 until manifestDraftAttachments.length()).map { manifestDraftAttachments.getJSONObject(it).getString("id") }
            .toSet().size == manifestDraftAttachments.length()) { "ARCHIVE_DRAFT_ATTACHMENT_MANIFEST_MISMATCH" }
        check(manifest.optString("sourceLibraryId") == snapshot.optString("libraryId")) { "ARCHIVE_LIBRARY_ID_MISMATCH" }
        runCatching { UUID.fromString(snapshot.optString("libraryId")) }.getOrElse { error("ARCHIVE_LIBRARY_ID_INVALID") }
        val descriptors = snapshot.optJSONArray("attachments") ?: JSONArray()
        val manifestAttachments = manifest.optJSONArray("attachments") ?: JSONArray()
        val branchDescriptors = snapshot.optJSONArray("branchAttachments") ?: JSONArray()
        check(descriptors.length() + branchDescriptors.length() == manifestAttachments.length() &&
            manifestAttachments.length() == manifest.optInt("attachmentCount")) {
            "ARCHIVE_ATTACHMENT_MANIFEST_MISMATCH"
        }
        val attachmentFiles = LinkedHashMap<String, LibraryArchiveFile>()
        val draftAttachmentFiles = LinkedHashMap<String, LibraryArchiveFile>()
        var validatedBlobBytes = 0L
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
            check(blob.file != null && blob.byteLength == descriptor.getLong("byteLength") && blob.sha256 == hash) { "ARCHIVE_ATTACHMENT_HASH_MISMATCH" }
            validatedBlobBytes += blob.byteLength
            check(validatedBlobBytes <= MAX_ARCHIVE_BLOB_BYTES) { "ARCHIVE_TOO_LARGE" }
            expectedEntries += entry
            attachmentFiles[id] = LibraryArchiveFile(blob.file, blob.byteLength, blob.sha256)
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
            check(blob.file != null && blob.byteLength == descriptor.getLong("byteLength") && blob.sha256 == hash) { "ARCHIVE_ATTACHMENT_HASH_MISMATCH" }
            validatedBlobBytes += blob.byteLength
            check(validatedBlobBytes <= MAX_ARCHIVE_BLOB_BYTES) { "ARCHIVE_TOO_LARGE" }
            expectedEntries += entry
            attachmentFiles["$branchId/$id"] = LibraryArchiveFile(blob.file, blob.byteLength, blob.sha256)
        }
        for (i in 0 until draftDescriptors.length()) {
            val descriptor = draftDescriptors.getJSONObject(i)
            val id = descriptor.getString("id")
            val metadata = (0 until manifestDraftAttachments.length()).map { manifestDraftAttachments.getJSONObject(it) }
                .firstOrNull { it.optString("id") == id } ?: error("ARCHIVE_DRAFT_ATTACHMENT_MANIFEST_MISMATCH")
            val entry = "draft-attachments/$id"
            val hash = descriptor.getString("hash").lowercase()
            check(metadata.getString("entry") == entry && metadata.getString("sha256").lowercase() == hash &&
                metadata.getLong("byteLength") == descriptor.getLong("byteLength") &&
                metadata.getString("name") == descriptor.getString("name") && metadata.getString("mimeType") == descriptor.getString("mimeType")) {
                "ARCHIVE_DRAFT_ATTACHMENT_MANIFEST_MISMATCH"
            }
            val blob = entries[entry] ?: error("ARCHIVE_DRAFT_ATTACHMENT_MISSING")
            check(blob.file != null && blob.byteLength == descriptor.getLong("byteLength") && blob.sha256 == hash &&
                LibraryAttachmentDraftStore.imageMime(blob.file) == descriptor.getString("mimeType")) {
                "ARCHIVE_DRAFT_ATTACHMENT_HASH_MISMATCH"
            }
            validatedBlobBytes += blob.byteLength
            check(validatedBlobBytes <= MAX_ARCHIVE_BLOB_BYTES) { "ARCHIVE_TOO_LARGE" }
            expectedEntries += entry
            draftAttachmentFiles[id] = LibraryArchiveFile(blob.file, blob.byteLength, blob.sha256)
        }
        check((0 until manifestDraftAttachments.length()).map { manifestDraftAttachments.getJSONObject(it).getString("id") }
            .toSet() == draftAttachmentFiles.keys) { "ARCHIVE_DRAFT_ATTACHMENT_MANIFEST_MISMATCH" }
        check(entries.keys == expectedEntries) { "ARCHIVE_UNEXPECTED_ENTRY" }
        val warnings = validateAttachmentReferences(snapshot, strict = archiveVersion >= 3)
        return ValidatedLibraryArchive(snapshot, attachmentFiles, draftAttachmentFiles, warnings, tempRoot)
        } catch (error: Exception) { tempRoot.deleteRecursively(); throw error }
    }

    fun restoreBackup(manager: LibraryManager, source: File, name: String, password: CharArray? = null,
        asNewLibrary: Boolean = false, requestId: String): LibraryRestoreResult {
        require(runCatching { UUID.fromString(requestId) }.isSuccess) { "INVALID_REQUEST_ID" }
        decodeBackup(source, password).use { archive ->
            val sourceLibraryId = archive.snapshot.optString("libraryId")
            val fingerprint = archiveFingerprint(archive, name.trim(), asNewLibrary)
            val restored = manager.restoreArchiveFiles(archive.snapshot, archive.attachmentFiles, name, requestId, fingerprint,
                asNewLibrary, archive.draftAttachmentFiles)
            val context = restored.context()
            return LibraryRestoreResult(context.libraryId, restored.registryItem().name,
                archive.snapshot.optJSONArray("records")?.length() ?: 0,
                (archive.snapshot.optJSONArray("attachments")?.length() ?: 0) + (archive.snapshot.optJSONArray("branchAttachments")?.length() ?: 0),
                sourceLibraryId, context.role, context.integrity, requestId, archive.warnings)
        }
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
        fun addFiles(files: Map<String, LibraryArchiveFile>) = files.toSortedMap().forEach { (key, file) ->
            add(key.toByteArray(StandardCharsets.UTF_8))
            add(ByteBuffer.allocate(8).putLong(file.byteLength).array())
            add(file.sha256.toByteArray(StandardCharsets.US_ASCII))
        }
        addFiles(archive.attachmentFiles)
        addFiles(archive.draftAttachmentFiles)
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** Validate attachment references in current records, history, and branch text before exposing staged files. */
    private fun validateAttachmentReferences(snapshot: JSONObject, strict: Boolean): List<String> {
        val recordFiles = mutableMapOf<String, MutableSet<String>>()
        val attachments = snapshot.optJSONArray("attachments") ?: JSONArray()
        for (i in 0 until attachments.length()) {
            val item = attachments.getJSONObject(i)
            if (!item.has("recordId")) continue
            recordFiles.getOrPut(item.getString("recordId")) { mutableSetOf() }.add(item.getString("id").lowercase())
        }
        val branchFiles = mutableMapOf<String, MutableSet<String>>()
        val branchRecordIds = mutableMapOf<String, String>()
        val branches = snapshot.optJSONArray("branches") ?: JSONArray()
        for (i in 0 until branches.length()) {
            val branch = branches.getJSONObject(i)
            branchRecordIds[branch.getString("branchId")] = branch.getString("recordId")
        }
        val branchAttachments = snapshot.optJSONArray("branchAttachments") ?: JSONArray()
        for (i in 0 until branchAttachments.length()) {
            val item = branchAttachments.getJSONObject(i)
            branchFiles.getOrPut(item.getString("branchId")) { mutableSetOf() }.add(item.getString("attachmentId").lowercase())
        }
        val pattern = Regex("!?\\[[^\\]\\r\\n]*]\\(\\s*<?attachment:([a-f0-9-]{36})>?[^)]*\\)", RegexOption.IGNORE_CASE)
        val missing = linkedSetOf<String>()
        fun withoutCode(markdown: String): String {
            val output = StringBuilder()
            var fenceChar: Char? = null
            var fenceLength = 0
            for (line in markdown.lineSequence()) {
                val trimmed = line.trimStart()
                if (fenceChar == null) {
                    val marker = Regex("^(`{3,}|~{3,})").find(trimmed)?.value
                    if (marker != null) { fenceChar = marker.first(); fenceLength = marker.length; output.append('\n'); continue }
                    output.append(line).append('\n')
                } else {
                    val close = Regex("^${Regex.escape(fenceChar.toString())}{$fenceLength,}\\s*$").containsMatchIn(trimmed)
                    if (close) { fenceChar = null; fenceLength = 0 }
                    output.append('\n')
                }
            }
            return Regex("(`+)[^`\\r\\n]*`+").replace(output.toString(), "")
        }
        fun checkText(text: String, owner: String, available: Set<String>) {
            for (match in pattern.findAll(withoutCode(text))) {
                val id = match.groupValues[1].lowercase()
                if (runCatching { UUID.fromString(id) }.isFailure || id !in available) missing += "$owner:$id"
            }
        }
        val records = snapshot.optJSONArray("records") ?: JSONArray()
        for (i in 0 until records.length()) {
            val record = records.getJSONObject(i); val id = record.getString("id")
            checkText(record.optString("markdown"), id, recordFiles[id].orEmpty())
        }
        val versions = snapshot.optJSONArray("versions") ?: JSONArray()
        for (i in 0 until versions.length()) {
            val version = versions.getJSONObject(i); val id = version.getString("recordId")
            checkText(version.optString("markdown"), id, recordFiles[id].orEmpty())
        }
        fun branchText(value: Any?, output: MutableList<String>) {
            when (value) {
                is JSONObject -> value.keys().forEach { key ->
                    val child = value.opt(key)
                    if (key in setOf("markdown", "body", "content") && child is String) output += child
                    else branchText(child, output)
                }
                is JSONArray -> for (i in 0 until value.length()) branchText(value.opt(i), output)
            }
        }
        for (i in 0 until branches.length()) {
            val branch = branches.getJSONObject(i); val id = branch.getString("branchId")
            val texts = mutableListOf<String>(); branchText(branch, texts)
            val available = branchFiles[id].orEmpty() + recordFiles[branchRecordIds[id]].orEmpty()
            texts.forEach { checkText(it, "branch:$id", available) }
        }
        val allIds = recordFiles.values.flatten().toSet()
        val provenance = snapshot.optJSONArray("provenance") ?: JSONArray()
        for (i in 0 until provenance.length()) {
            val item = provenance.getJSONObject(i); val links = item.optJSONObject("import")?.optJSONArray("links") ?: continue
            for (index in 0 until links.length()) {
                val id = links.getJSONObject(index).optString("targetAttachmentId").takeIf { it.isNotBlank() && it != "null" } ?: continue
                if (id.lowercase() !in allIds) missing += "${item.optString("recordId")}:$id"
            }
        }
        if (strict) check(missing.isEmpty()) { "ARCHIVE_ATTACHMENT_REFERENCE_MISSING" }
        return missing.map { "ARCHIVE_LEGACY_MISSING_ATTACHMENT:$it" }
    }

    fun copyRecordText(source: LibraryRepository, target: LibraryRepository, recordId: String, requestId: String): LibraryRecord {
        check(source.libraryId != target.libraryId) { "COPY_TARGET_MUST_DIFFER" }
        val row = source.read(recordId)
        require(row.kind != "ai_annotation") { "ANNOTATION_COPY_UNSUPPORTED" }
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
        return try { files.shareIntent(document.fileName, document.mimeType, document.file.readBytes(), chooserTitle) }
        finally { document.file.delete() }
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

    private data class ExtractedEntry(val bytes: ByteArray?, val file: File?, val byteLength: Long, val sha256: String)

    private fun extractZip(file: File, tempRoot: File): Map<String, ExtractedEntry> {
        val entries = LinkedHashMap<String, ExtractedEntry>()
        val payloads = File(tempRoot, "payload").apply { check(mkdirs()) }
        var total = 0L
        ZipInputStream(BufferedInputStream(FileInputStream(file))).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                if (entry.isDirectory) { zip.closeEntry(); continue }
                check(entries.size < MAX_ARCHIVE_ENTRIES) { "ARCHIVE_TOO_MANY_ENTRIES" }
                val name = entry.name
                check(name == "manifest.json" || name == "snapshot.json" || name.matches(ARCHIVE_ATTACHMENT_PATH) ||
                    name.matches(ARCHIVE_DRAFT_ATTACHMENT_PATH)) {
                    "ARCHIVE_INVALID_ENTRY"
                }
                check(!entries.containsKey(name)) { "ARCHIVE_DUPLICATE_ENTRY" }
                val metadata = name == "manifest.json" || name == "snapshot.json"
                val metadataSink = if (metadata) ByteArrayOutputStream() else null
                val payloadFile = if (metadata) null else File(payloads, "entry-${entries.size}.payload")
                val output = metadataSink ?: FileOutputStream(payloadFile!!)
                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var entryBytes = 0L
                try {
                    while (true) {
                        val count = zip.read(buffer)
                        if (count < 0) break
                        entryBytes += count; total += count
                        check(entryBytes <= (if (metadata) MAX_SNAPSHOT_BYTES.toLong() else MAX_ARCHIVE_ENTRY_BYTES) && total <= MAX_BACKUP_BYTES) {
                            "ARCHIVE_TOO_LARGE"
                        }
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                    }
                } finally {
                    if (metadata) output.close() else (output as FileOutputStream).apply { fd.sync(); close() }
                }
                entries[name] = ExtractedEntry(metadataSink?.toByteArray(), payloadFile, entryBytes,
                    digest.digest().joinToString("") { "%02x".format(it) })
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

    private fun putFileEntry(zip: ZipOutputStream, name: String, payload: LibraryArchiveFile, maximum: Long) {
        check(payload.file.isFile && payload.file.length() == payload.byteLength) { "ARCHIVE_FILE_CHANGED" }
        zip.putNextEntry(ZipEntry(name))
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        try {
            FileInputStream(payload.file).buffered().use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= maximum) { "ARCHIVE_TOO_LARGE" }
                    digest.update(buffer, 0, count)
                    zip.write(buffer, 0, count)
                }
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it) }
            check(total == payload.byteLength && hash == payload.sha256) { "ARCHIVE_FILE_INTEGRITY_FAILED" }
        } finally { zip.closeEntry() }
    }

    private fun unquote(value: String): String = when {
        value.length >= 2 && ((value.first() == '"' && value.last() == '"') || (value.first() == '\'' && value.last() == '\'')) -> value.substring(1, value.length - 1)
        else -> value.substringBefore(" #").trim()
    }

    private fun yamlString(value: String): String = JSONObject.quote(value)

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }

    private data class ParsedMarkdown(val title: String, val markdown: String, val metadata: JSONObject)
    internal data class ValidatedLibraryArchive(val snapshot: JSONObject,
        val attachmentFiles: Map<String, LibraryArchiveFile>, val draftAttachmentFiles: Map<String, LibraryArchiveFile>,
        val warnings: List<String>, private val tempRoot: File) : AutoCloseable {
        override fun close() { tempRoot.deleteRecursively() }
    }

    companion object {
        private const val ARCHIVE_FORMAT = "shiwen-library-archive"
        private const val ARCHIVE_VERSION = 3
        private val SUPPORTED_ARCHIVE_VERSIONS = setOf(1, 2, 3)
        private val SUPPORTED_SNAPSHOT_VERSIONS = setOf(1, 2)
        private const val MAX_MARKDOWN_CHARS = 1_000_000
        private const val MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
        private const val MAX_ARCHIVE_BLOB_BYTES = 1024L * 1024 * 1024
        internal const val MAX_BACKUP_BYTES = 1024L * 1024 * 1024
        private const val MAX_ARCHIVE_ENTRIES = 20_000
        private const val MAX_ARCHIVE_ENTRY_BYTES = MAX_BACKUP_BYTES
        private val HASH_PATTERN = Regex("[a-f0-9]{64}")
        private val ARCHIVE_ATTACHMENT_PATH = Regex("attachments/[a-f0-9]{64}")
        private val ARCHIVE_DRAFT_ATTACHMENT_PATH = Regex("draft-attachments/[0-9a-f-]{36}")
        private val FRONTMATTER_LINE = Regex("([A-Za-z][A-Za-z0-9_-]{0,63}):\\s*(.*)")
        private val ISO_DAY = Regex("\\d{4}-\\d{2}-\\d{2}")
        private val KINDS = setOf("journal", "freewrite", "idea", "web", "ai", "reference", "article")
        private val ORIGINS = setOf("personal", "external", "ai", "translation", "unknown")
        private val PROCESSING = setOf("original", "formatting", "ai-organized", "translation", "unknown")
        private val STAGES = setOf("idea", "draft", "revision", "final")
    }
}
