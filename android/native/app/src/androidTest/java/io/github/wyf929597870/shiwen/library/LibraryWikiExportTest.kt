package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.zip.ZipInputStream

@RunWith(AndroidJUnit4::class)
class LibraryWikiExportTest {
    @Test fun exportedWikiImageUsesPortableRelativePath() {
        val context = ApplicationProvider.getApplicationContext<Context>(); val namespace = "wiki-export-${UUID.randomUUID()}"
        val manager = LibraryManager(context, "$namespace-registry", "$namespace-legacy"); val repo = manager.create("source")
        try {
            val bytes = byteArrayOf(137.toByte(),80,78,71,13,10,26,10,0,1)
            val asset = repo.importMarkdown(UUID.randomUUID().toString(), "asset", "asset", originalName = "photo.png", originalBytes = bytes)
            val id = JSONArray(asset.attachmentDescriptorsJson).getJSONObject(0).getString("id")
            val markdown = "![photo](../images/photo.png)\n\n![[../images/photo.png|same]]"
            val provenance = JSONObject().put("import", JSONObject().put("sourceName", "notes/note.md")
                .put("links", JSONArray().put(JSONObject().put("relativePath", "images/photo.png").put("targetAttachmentId", id))))
            val row = repo.create(UUID.randomUUID().toString(), JSONObject().put("kind", "reference").put("title", "note")
                .put("markdown", markdown).put("origin", "external").put("processing", "original").put("provenance", provenance), 1)
            val document = LibraryImportExport(LibraryFileTransfer(context)).exportRecordWithImages(repo, row.id)
            try {
                val entries = mutableMapOf<String, ByteArray>()
                ZipInputStream(document.file.inputStream()).use { zip -> while (true) { val entry = zip.nextEntry ?: break;entries[entry.name]=zip.readBytes();zip.closeEntry() } }
                assertEquals(bytes.toList(), entries["images/$id.png"]?.toList())
                val text = entries.getValue("note.md").toString(Charsets.UTF_8)
                assertTrue(text.contains("![photo](images/$id.png)"));assertTrue(text.contains("![same](images/$id.png)"))
            } finally { document.file.delete() }
        } finally {
            manager.closeForTest();File(context.filesDir, "libraries/${repo.libraryId}").deleteRecursively()
            context.deleteDatabase("shiwen-library-${repo.libraryId}.sqlite")
        }
    }
}
