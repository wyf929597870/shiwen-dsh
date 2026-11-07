package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LibraryTransferIntegrationTest {
    @Test fun historicalPersonalMarkdownKeepsOriginalFileAndNeverCountsAsNewWriting() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "transfer-fixture-${UUID.randomUUID()}"
        val manager = LibraryManager(context, namespace, "$namespace-legacy")
        val repo = manager.create("Import fixture")
        val dir = File(context.cacheDir, "shiwen-transfers").apply { mkdirs() }
        val file = File(dir, "personal-${UUID.randomUUID()}.md")
        val raw = "---\ntitle: 我的旧日记\nkind: journal\norigin: personal\nprocessing: original\ncontentDay: 2024-03-01\n---\n# 春天\n\n那天走了很长的路。\n"
        file.writeText(raw)
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            val codec = LibraryImportExport(LibraryFileTransfer(context))
            val imported = codec.importMarkdown(repo, uri)
            val repeated = codec.importMarkdown(repo, uri)
            assertEquals(imported.id, repeated.id)
            assertEquals(1, repo.dao.recordCount())
            assertEquals("2024-03-01", imported.contentDay)
            assertEquals("personal", imported.origin)
            assertEquals("# 春天\n\n那天走了很长的路。\n", imported.markdown)
            val descriptor = JSONArray(imported.attachmentDescriptorsJson).getJSONObject(0)
            assertArrayEquals(raw.toByteArray(), repo.attachmentBytes(descriptor.getString("id")))
            val activities = repo.dao.activities(imported.id)
            assertEquals(1, activities.size)
            assertEquals("import", activities.single().action)
            assertEquals(0L, LibraryReview(repo).read("1").getJSONObject("totals").getLong("added"))
            val historical = LibraryReview(repo).read("month", "2024-03").getJSONObject("totals")
            assertEquals(1, historical.getInt("historicalRecords"))
            val backup = codec.decodeBackup(codec.createBackup(repo))
            assertEquals(1, backup.snapshot.getJSONArray("records").length())
            assertEquals(1, backup.attachmentBytes.size)
            assertArrayEquals(raw.toByteArray(), backup.attachmentBytes.values.single())
        } finally {
            manager.closeForTest()
            file.delete()
            File(context.filesDir, "libraries/${repo.libraryId}").deleteRecursively()
            context.deleteDatabase("shiwen-library-${repo.libraryId}.sqlite")
        }
    }
}
