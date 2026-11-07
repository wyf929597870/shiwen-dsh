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

    private fun zip(vararg entries: Pair<String, ByteArray>): ByteArray = ByteArrayOutputStream().use { output ->
        ZipOutputStream(output).use { zip -> entries.forEach { (name, bytes) ->
            zip.putNextEntry(ZipEntry(name)); zip.write(bytes); zip.closeEntry()
        } }
        output.toByteArray()
    }
}
