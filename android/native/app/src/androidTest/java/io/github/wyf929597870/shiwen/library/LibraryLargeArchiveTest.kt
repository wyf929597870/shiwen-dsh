package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.zip.ZipFile

/** Every restore uses an isolated registry and a new library; never touches the release app. */
@RunWith(AndroidJUnit4::class)
class LibraryLargeArchiveTest {
    @Test fun streamingJsonPreservesExistingFingerprintEncoding() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val value = JSONObject().put("text", "中文😀\n\t\"\\</script>").put("integer", 9007199254740991L)
            .put("decimal", 1.0).put("boolean", true).put("null", JSONObject.NULL)
            .put("array", org.json.JSONArray().put(JSONObject().put("nested", "a/b")))
        val file = File.createTempFile("archive-json-", ".json", context.cacheDir)
        try {
            file.writer().use { writeArchiveFingerprintJson(it, value) }
            assertEquals(value.toString(), file.readText())
            assertEquals(value.toString(), readArchiveJson(file).toString())
        } finally { file.delete() }
    }
    @Test fun snapshotOver32MiBRoundTripsWithHistoryAndAttachments() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "large-archive-${UUID.randomUUID()}"
        val sourceManager = LibraryManager(context, namespace, "$namespace-legacy")
        val source = sourceManager.active()
        val expected = linkedMapOf<String, String>()
        val codec = LibraryImportExport(LibraryFileTransfer(context))
        var backup: File? = null
        try {
            repeat(5) { index ->
                val text = "资料备份".repeat(75_000) + "-$index"
                val record = source.importMarkdown(UUID.randomUUID().toString(), "Large $index", text,
                    JSONObject().put("kind", "reference").put("origin", "external").put("processing", "original"),
                    "source-$index.md", text.toByteArray(), "import")
                source.update(record.id, record.revision, UUID.randomUUID().toString(), JSONObject().put("markdown", "$text\n后续编辑"))
                expected[record.id] = "$text\n后续编辑"
            }
            backup = codec.createBackup(source, false)
            ZipFile(backup).use { assertTrue(it.getEntry("snapshot.json").size > 32L * 1024 * 1024) }
            roundTrip(context, backup, false) { repo ->
                assertEquals(5, repo.dao.recordCount())
                expected.forEach { (id, text) ->
                    assertEquals(text, repo.read(id).markdown)
                    assertEquals(2, repo.versions(id).size)
                    assertEquals(2, repo.dao.activities(id).size)
                    val attachment = repo.dao.attachments(id).single()
                    assertEquals(text.removeSuffix("\n后续编辑"), repo.attachmentBytes(attachment.id).toString(Charsets.UTF_8))
                }
            }
        } finally {
            backup?.delete()
            sourceManager.closeForTest()
            File(context.filesDir, "libraries/${source.libraryId}").deleteRecursively()
        }
    }

    @Test fun suppliedArchiveRestoresAndReexportsForIndependentComparison() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val fileName = InstrumentationRegistry.getArguments().getString("archiveFixture")
        assumeTrue(fileName == "actual-library.zip")
        val source = File(context.cacheDir, "actual-library.zip")
        check(source.isFile)
        if (InstrumentationRegistry.getArguments().getString("encryptedFixture") == "true") {
            val encrypted = File(context.cacheDir, "actual-library-encrypted.shiwen")
            val password = "isolated-backup-acceptance".toCharArray()
            try {
                LibraryArchiveCrypto.encryptFile(source, encrypted, password.copyOf(), LibraryImportExport.MAX_BACKUP_BYTES)
                roundTrip(context, encrypted, true, password) { }
            } finally { encrypted.delete(); password.fill('\u0000') }
        } else roundTrip(context, source, true) { }
    }

    private fun roundTrip(context: Context, source: File, reexport: Boolean, password: CharArray? = null,
        verify: (LibraryRepository) -> Unit) {
        val namespace = "large-restored-${UUID.randomUUID()}"
        val manager = LibraryManager(context, namespace, "$namespace-legacy")
        val codec = LibraryImportExport(LibraryFileTransfer(context))
        val requestId = UUID.randomUUID().toString()
        var restoredId: String? = null
        try {
            val result = codec.restoreBackup(manager, source, "Backup acceptance", password?.copyOf(), asNewLibrary = true, requestId = requestId)
            restoredId = result.libraryId
            val repo = manager.openLibrary(result.libraryId)
            assertTrue(result.warnings.isEmpty())
            assertEquals(result.libraryId, codec.restoreBackup(manager, source, "Backup acceptance", password?.copyOf(),
                asNewLibrary = true, requestId = requestId).libraryId)
            verify(repo)
            if (reexport) {
                val output = codec.createBackup(repo)
                check(output.renameTo(File(context.cacheDir, "verified-restored.zip")))
            }
        } finally {
            manager.closeForTest()
            restoredId?.let { File(context.filesDir, "libraries/$it").deleteRecursively() }
        }
    }
}
