package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import java.util.zip.ZipInputStream
import java.io.ByteArrayInputStream
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
class LibraryImportExportTest {
    private fun withRepositories(block: (LibraryRepository, LibraryRepository) -> Unit) {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = UUID.randomUUID().toString()
        val sourceRegistry = Room.databaseBuilder(context, LibraryRegistryDatabase::class.java, "archive-source-registry-$namespace.sqlite").build()
        val targetRegistry = Room.databaseBuilder(context, LibraryRegistryDatabase::class.java, "archive-target-registry-$namespace.sqlite").build()
        fun make(id: String, registry: LibraryRegistryDatabase, suffix: String): LibraryRepository {
            val row = LibraryRegistryRow(id, "Archive fixture", UUID.randomUUID().toString(), "archive-$namespace-$suffix.sqlite",
                "standalone", "complete", null, null, 1, null, null, null, null, null, 1, true, false, false, "{}")
            registry.dao().insert(row)
            return LibraryRepository(context, id, row.deviceId, row.name, registry, row)
        }
        val sourceId = UUID.randomUUID().toString()
        val source = make(sourceId, sourceRegistry, "source")
        // Restores preserve the archive's library identity while each installation gets a new device ID.
        val target = make(sourceId, targetRegistry, "target")
        try { block(source, target) }
        finally {
            source.executor.shutdownNow(); target.executor.shutdownNow()
            source.db.close(); target.db.close(); sourceRegistry.close(); targetRegistry.close()
            File(context.filesDir, "libraries/$sourceId").deleteRecursively()
            context.deleteDatabase("archive-$namespace-source.sqlite")
            context.deleteDatabase("archive-$namespace-target.sqlite")
            context.deleteDatabase("archive-source-registry-$namespace.sqlite")
            context.deleteDatabase("archive-target-registry-$namespace.sqlite")
        }
    }

    private fun input(markdown: String) = JSONObject().put("kind", "reference").put("title", "Archive record")
        .put("markdown", markdown).put("origin", "external").put("processing", "original")
        .put("sources", JSONArray().put(JSONObject().put("text", markdown).put("origin", "external")))

    @Test fun portableMarkdownExportIncludesReferencedImage() = withRepositories { source, _ ->
        val image = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 0, 1)
        val row = source.importMarkdown(UUID.randomUUID().toString(), "Image", "body", originalName = "image.png", originalBytes = image)
        val id = JSONArray(row.attachmentDescriptorsJson).getJSONObject(0).getString("id")
        source.update(row.id, row.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "![alt](attachment:$id)"))
        val archive = LibraryImportExport(LibraryFileTransfer(ApplicationProvider.getApplicationContext())).exportRecordWithImages(source, row.id)
        val entries = mutableMapOf<String, ByteArray>()
        ZipInputStream(ByteArrayInputStream(archive.file.readBytes())).use { zip ->
            while (true) { val entry = zip.nextEntry ?: break; entries[entry.name] = zip.readBytes(); zip.closeEntry() }
        }
        assertEquals(image.toList(), entries["images/$id.png"]?.toList())
        assertTrue(entries.values.any { it.toString(Charsets.UTF_8).contains("![alt](images/$id.png)") })
    }

    @Test fun restoreDistinctAttachmentsWithIdenticalBytes() = withRepositories { source, target ->
        val data = "same attachment bytes".toByteArray()
        val first = source.importMarkdown(UUID.randomUUID().toString(), "First", "first", originalName = "first.md", originalBytes = data)
        val second = source.importMarkdown(UUID.randomUUID().toString(), "Second", "second", originalName = "second.md", originalBytes = data)
        val firstId = JSONArray(first.attachmentDescriptorsJson).getJSONObject(0).getString("id")
        val secondId = JSONArray(second.attachmentDescriptorsJson).getJSONObject(0).getString("id")
        val snapshot = source.archiveSnapshot()
        val context = ApplicationProvider.getApplicationContext<Context>()
        val sourceFiles = File(context.filesDir, "libraries/${source.libraryId}")
        val heldFiles = File(context.cacheDir, "archive-duplicate-${UUID.randomUUID()}")
        assertTrue(sourceFiles.renameTo(heldFiles))
        try {
            target.restoreArchiveSnapshot(snapshot, mapOf(firstId to data, secondId to data))
            assertEquals(data.toList(), target.attachmentBytes(firstId).toList())
            assertEquals(data.toList(), target.attachmentBytes(secondId).toList())
        } finally {
            sourceFiles.deleteRecursively()
            assertTrue(heldFiles.renameTo(sourceFiles))
        }
    }

    @Test fun encryptedBackupsAuthenticateBeforeRestoreAndRejectIterationDowngrade() {
        val original = "# private archive".toByteArray()
        val encrypted = LibraryArchiveCrypto.encrypt(original, "correct horse battery".toCharArray())
        assertEquals(true, LibraryArchiveCrypto.isEncrypted(encrypted))
        assertEquals("# private archive", LibraryArchiveCrypto.decrypt(encrypted, "correct horse battery".toCharArray()).decodeToString())
        assertEquals("BACKUP_PASSWORD_INVALID", assertThrows(IllegalStateException::class.java) {
            LibraryArchiveCrypto.decrypt(encrypted, "wrong password".toCharArray())
        }.message)
        val tampered = encrypted.clone().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        assertThrows(IllegalStateException::class.java) { LibraryArchiveCrypto.decrypt(tampered, "correct horse battery".toCharArray()) }
        val downgrade = encrypted.clone().also { bytes -> bytes[9] = 0; bytes[10] = 0; bytes[11] = 0; bytes[12] = 1 }
        assertEquals("BACKUP_KDF_PARAMETERS_INVALID", assertThrows(IllegalStateException::class.java) {
            LibraryArchiveCrypto.decrypt(downgrade, "correct horse battery".toCharArray())
        }.message)
    }

    @Test fun corruptAndZipSlipArchivesAreRejectedBeforeRepositoryChanges() = withRepositories { source, _ ->
        val existing = source.create(UUID.randomUUID().toString(), input("kept"), 1)
        val files = LibraryFileTransfer(ApplicationProvider.getApplicationContext())
        val codec = LibraryImportExport(files)
        val unsafe = zip("../outside.txt" to "no".toByteArray())
        val zipSlipError = assertThrows(Exception::class.java) {
            codec.decodeBackup(unsafe)
        }
        assertTrue(zipSlipError is java.util.zip.ZipException || zipSlipError.message == "ARCHIVE_INVALID_ENTRY")
        assertEquals("BACKUP_PASSWORD_INVALID", assertThrows(IllegalStateException::class.java) {
            codec.decodeBackup(LibraryArchiveCrypto.encrypt("not a ZIP".toByteArray(), "valid password".toCharArray()), "wrong password".toCharArray())
        }.message)
        assertEquals(1, source.dao.recordCount())
        assertEquals(existing.markdown, source.read(existing.id).markdown)
    }

    @Test fun fullArchiveRoundTripKeepsLibraryIdentityHistoryAndNewDeviceId() = withRepositories { source, _ ->
        val originalBytes = "# Original file\n原件内容".toByteArray()
        val first = source.importMarkdown(UUID.randomUUID().toString(), "Archive record", "original",
            JSONObject().put("kind", "reference").put("origin", "external").put("processing", "original"),
            "original.md", originalBytes, "import")
        source.update(first.id, first.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "edited"))
        val bytes = LibraryImportExport(LibraryFileTransfer(ApplicationProvider.getApplicationContext())).createBackup(source)
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "archive-restored-${UUID.randomUUID()}"
        val manager = LibraryManager(context, namespace, "$namespace-legacy")
        val sourceFiles = File(context.filesDir, "libraries/${source.libraryId}")
        val heldSourceFiles = File(context.cacheDir, "archive-source-files-${UUID.randomUUID()}")
        val movedSourceFiles = sourceFiles.exists()
        if (movedSourceFiles) assertTrue("Could not isolate source attachment files", sourceFiles.renameTo(heldSourceFiles))
        try {
            val result = LibraryImportExport(LibraryFileTransfer(context)).restoreBackup(manager, bytes, "Restored archive",
                requestId = UUID.randomUUID().toString())
            val target = manager.openLibrary(result.libraryId)
            assertEquals(1, result.restored)
            assertEquals("edited", target.read(first.id).markdown)
            assertEquals(2, target.versions(first.id).size)
            assertEquals(2, target.dao.activities(first.id).size)
            org.junit.Assert.assertNotNull(target.dao.head(first.id))
            val restoredProvenance = target.dao.provenance(first.id)
            org.junit.Assert.assertNotNull(restoredProvenance)
            assertEquals("original.md", JSONObject(restoredProvenance!!.json).getJSONObject("import").getString("sourceName"))
            val attachmentId = JSONArray(first.attachmentDescriptorsJson).getJSONObject(0).getString("id")
            assertEquals(originalBytes.toList(), target.attachmentBytes(attachmentId).toList())
            assertEquals(target.libraryId, target.context().libraryId)
            assertEquals(source.libraryId, target.libraryId)
            assertTrue(source.deviceId != target.deviceId)
            assertEquals(1, manager.all().size)
        } finally {
            manager.closeForTest()
            File(context.filesDir, "libraries/${source.libraryId}").deleteRecursively()
            if (movedSourceFiles) assertTrue("Could not restore isolated source files", heldSourceFiles.renameTo(sourceFiles))
        }
    }

    @Test fun backupRestoresStagedDraftImagesForOriginalAndNewLibraryWithoutChangingToken() = withRepositories { source, _ ->
        val context = ApplicationProvider.getApplicationContext<Context>()
        val token = UUID.randomUUID().toString()
        val bytes = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 1, 2, 3)
        val staged = LibraryAttachmentDraftStore(context, source.libraryId).stage("draft image.png", bytes)
        // Move the staged bytes to the requested token before creating the durable editor draft.
        val generatedId = staged.getString("id")
        val generatedFile = File(context.filesDir, "libraries/${source.libraryId}/attachment-drafts/$generatedId")
        val tokenFile = File(context.filesDir, "libraries/${source.libraryId}/attachment-drafts/$token")
        assertTrue(generatedFile.renameTo(tokenFile))
        val descriptor = JSONObject(staged.toString()).put("id", token)
        val form = JSONObject().put("title", "Draft with image").put("markdown", "![draft](attachment:$token)")
            .put("attachmentDescriptors", JSONArray().put(descriptor)).put("stagedAttachments", JSONArray().put(descriptor))
        val content = JSONObject().put("form", form).put("selectedId", JSONObject.NULL)
            .put("creating", true).put("editing", true)
        val requestId = UUID.randomUUID().toString()
        val drafts = RecordEditorDraftStore(context)
        drafts.save(source.libraryId, "materials", requestId, 1, content)
        try {
            val codec = LibraryImportExport(LibraryFileTransfer(context))
            val backup = codec.createBackup(source, includeConversations = false)
            codec.decodeBackup(backup).use { decoded ->
                assertEquals(bytes.toList(), decoded.draftAttachmentFiles[token]?.file?.readBytes()?.toList())
            }

            // Simulate restore to the original library identity on a clean client draft store.
            drafts.clearLibraryForTest(source.libraryId)
            val sourceDirectory = File(context.filesDir, "libraries/${source.libraryId}")
            val heldDirectory = File(context.cacheDir, "held-draft-stage-${UUID.randomUUID()}")
            assertTrue(sourceDirectory.renameTo(heldDirectory))
            val namespace = "draft-image-restore-${UUID.randomUUID()}"
            val manager = LibraryManager(context, namespace, "$namespace-legacy")
            var newLibraryId: String? = null
            try {
                val original = codec.restoreBackup(manager, backup, "Restored original",
                    requestId = UUID.randomUUID().toString())
                assertEquals(source.libraryId, original.libraryId)
                val originalRepo = manager.openLibrary(original.libraryId)
                LibraryClientArchive(context).restoreDrafts(originalRepo)
                val restored = drafts.read(original.libraryId, "materials").getJSONObject("draft")
                    .getJSONObject("content").getJSONObject("form")
                assertEquals(token, restored.getJSONArray("stagedAttachments").getJSONObject(0).getString("id"))
                assertEquals(bytes.toList(), LibraryAttachmentDraftStore(context, original.libraryId)
                    .read(token, "draft image.png").bytes.toList())

                val imported = codec.restoreBackup(manager, backup, "Imported new library", asNewLibrary = true,
                    requestId = UUID.randomUUID().toString())
                newLibraryId = imported.libraryId
                val importedRepo = manager.openLibrary(imported.libraryId)
                LibraryClientArchive(context).restoreDrafts(importedRepo)
                val importedDraft = drafts.read(imported.libraryId, "materials").getJSONObject("draft")
                    .getJSONObject("content").getJSONObject("form")
                assertEquals(token, importedDraft.getJSONArray("stagedAttachments").getJSONObject(0).getString("id"))
                assertEquals(bytes.toList(), LibraryAttachmentDraftStore(context, imported.libraryId)
                    .read(token, "draft image.png").bytes.toList())
            } finally {
                manager.closeForTest()
                File(context.filesDir, "libraries/${source.libraryId}").deleteRecursively()
                newLibraryId?.let { File(context.filesDir, "libraries/$it").deleteRecursively(); drafts.clearLibraryForTest(it) }
                assertTrue(heldDirectory.renameTo(sourceDirectory))
            }
        } finally {
            drafts.clearLibraryForTest(source.libraryId)
            drafts.close()
            LibraryAttachmentDraftStore(context, source.libraryId).delete(token)
        }
    }

    @Test fun v1BackupWithoutDraftAttachmentManifestRemainsReadable() = withRepositories { source, _ ->
        val codec = LibraryImportExport(LibraryFileTransfer(ApplicationProvider.getApplicationContext()))
        val current = codec.createBackup(source, includeConversations = false)
        val input = linkedMapOf<String, ByteArray>()
        ZipInputStream(ByteArrayInputStream(current.readBytes())).use { zip ->
            while (true) { val entry = zip.nextEntry ?: break; input[entry.name] = zip.readBytes(); zip.closeEntry() }
        }
        val manifest = JSONObject(input.getValue("manifest.json").toString(Charsets.UTF_8))
            .put("formatVersion", 1).also { it.remove("draftAttachments") }
        val snapshot = JSONObject(input.getValue("snapshot.json").toString(Charsets.UTF_8))
        snapshot.optJSONObject("clientArchive")?.remove("draftAttachments")
        val snapshotBytes = snapshot.toString().toByteArray(Charsets.UTF_8)
        manifest.put("snapshotSha256", MessageDigest.getInstance("SHA-256").digest(snapshotBytes)
            .joinToString("") { "%02x".format(it) })
        val legacyEntries = input.filterKeys { it.startsWith("attachments/") }.toMutableMap().apply {
            put("manifest.json", manifest.toString().toByteArray(Charsets.UTF_8))
            put("snapshot.json", snapshotBytes)
        }
        val decoded = codec.decodeBackup(zip(*legacyEntries.map { it.key to it.value }.toTypedArray()))
        decoded.use { assertTrue(it.draftAttachmentFiles.isEmpty()) }
    }

    @Test fun v3RejectsMissingHistoryReferencesWhileLegacyArchiveReturnsWarning() = withRepositories { source, _ ->
        source.create(UUID.randomUUID().toString(), input("clean body"), 1)
        val codec = LibraryImportExport(LibraryFileTransfer(ApplicationProvider.getApplicationContext()))
        val archiveFile = codec.createBackup(source, includeConversations = false)
        val entries = linkedMapOf<String, ByteArray>()
        ZipInputStream(ByteArrayInputStream(archiveFile.readBytes())).use { zip ->
            while (true) { val entry = zip.nextEntry ?: break; entries[entry.name] = zip.readBytes(); zip.closeEntry() }
        }
        archiveFile.delete()
        val snapshot = JSONObject(entries.getValue("snapshot.json").toString(Charsets.UTF_8))
        val missing = UUID.randomUUID().toString()
        val literalAndCode = "attachment:$missing\n\n`![inline](attachment:$missing)`\n\n~~~md\n![fenced](attachment:$missing)\n~~~"
        snapshot.getJSONArray("records").getJSONObject(0).put("markdown", literalAndCode)
        val versions = snapshot.getJSONArray("versions")
        for (i in 0 until versions.length()) versions.getJSONObject(i).put("markdown", literalAndCode)
        var snapshotBytes = snapshot.toString().toByteArray(Charsets.UTF_8)
        val manifest = JSONObject(entries.getValue("manifest.json").toString(Charsets.UTF_8))
            .put("snapshotSha256", MessageDigest.getInstance("SHA-256").digest(snapshotBytes)
                .joinToString("") { "%02x".format(it) })
        entries["snapshot.json"] = snapshotBytes
        entries["manifest.json"] = manifest.toString().toByteArray(Charsets.UTF_8)
        codec.decodeBackup(zip(*entries.map { it.key to it.value }.toTypedArray())).use { assertTrue(it.warnings.isEmpty()) }
        versions.getJSONObject(0).put("markdown", "![missing](attachment:$missing)")
        snapshotBytes = snapshot.toString().toByteArray(Charsets.UTF_8)
        manifest.put("snapshotSha256", MessageDigest.getInstance("SHA-256").digest(snapshotBytes)
            .joinToString("") { "%02x".format(it) })
        entries["snapshot.json"] = snapshotBytes
        entries["manifest.json"] = manifest.toString().toByteArray(Charsets.UTF_8)
        assertEquals("ARCHIVE_ATTACHMENT_REFERENCE_MISSING", assertThrows(IllegalStateException::class.java) {
            codec.decodeBackup(zip(*entries.map { it.key to it.value }.toTypedArray()))
        }.message)
        manifest.put("formatVersion", 2)
        entries["manifest.json"] = manifest.toString().toByteArray(Charsets.UTF_8)
        codec.decodeBackup(zip(*entries.map { it.key to it.value }.toTypedArray())).use { legacy ->
            assertTrue(legacy.warnings.any { it.startsWith("ARCHIVE_LEGACY_MISSING_ATTACHMENT:") && it.contains(missing) })
        }
    }

    @Test fun restoringDraftTokenNeverOverwritesDifferentExistingBytes() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val libraryId = UUID.randomUUID().toString()
        val store = LibraryAttachmentDraftStore(context, libraryId)
        val token = UUID.randomUUID().toString()
        val existing = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 1)
        val incoming = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 2)
        val staged = store.stage("draft.png", existing)
        val generatedId = staged.getString("id")
        val generatedFile = File(context.filesDir, "libraries/$libraryId/attachment-drafts/$generatedId")
        val tokenFile = File(context.filesDir, "libraries/$libraryId/attachment-drafts/$token")
        assertTrue(generatedFile.renameTo(tokenFile))
        try {
            val error = assertThrows(IllegalStateException::class.java) {
                store.restore(token, "draft.png", LibraryAttachmentDraftStore.sha256(incoming), incoming.size.toLong(),
                    "image/png", incoming)
            }
            assertEquals("ATTACHMENT_STAGE_TARGET_MISMATCH", error.message)
            assertEquals(existing.toList(), store.read(token, "draft.png").bytes.toList())
        } finally { store.delete(token); File(context.filesDir, "libraries/$libraryId").deleteRecursively() }
    }

    private fun zip(vararg entries: Pair<String, ByteArray>): ByteArray = ByteArrayOutputStream().use { output ->
        ZipOutputStream(output).use { zip -> entries.forEach { (name, bytes) ->
            zip.putNextEntry(ZipEntry(name)); zip.write(bytes); zip.closeEntry()
        } }
        output.toByteArray()
    }
}
