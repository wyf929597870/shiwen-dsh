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

@RunWith(AndroidJUnit4::class)
class LibraryImageCopyTest {
    @Test fun importedRelativeImageCopiesFromMappedAssetRecord() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "copy-wiki-${UUID.randomUUID()}"
        val manager = LibraryManager(context, "$namespace-registry", "$namespace-legacy")
        val source = manager.create("source"); val target = manager.create("target")
        try {
            val bytes = byteArrayOf(137.toByte(),80,78,71,13,10,26,10,0,1)
            val asset = source.importMarkdown(UUID.randomUUID().toString(), "asset", "asset", originalName = "image.png", originalBytes = bytes)
            val assetId = JSONArray(asset.attachmentDescriptorsJson).getJSONObject(0).getString("id")
            val markdown = "![photo](../images/photo.png)"
            val provenance = JSONObject().put("import", JSONObject().put("sourceName", "notes/note.md")
                .put("links", JSONArray().put(JSONObject().put("relativePath", "images/photo.png").put("targetAttachmentId", assetId))))
            val input = JSONObject().put("kind", "reference").put("title", "note").put("markdown", markdown)
                .put("origin", "external").put("processing", "original").put("provenance", provenance)
            val note = source.create(UUID.randomUUID().toString(), input, 1)
            val copied = LibraryImageCopy.copy(source, target, note.id, UUID.randomUUID().toString())
            val id = JSONArray(copied.attachmentDescriptorsJson).getJSONObject(0).getString("id")
            assertNotEquals(assetId, id)
            assertTrue(copied.markdown.contains("![photo](attachment:$id)"))
            assertEquals(bytes.toList(), target.attachmentBytes(id).toList())
        } finally {
            manager.closeForTest()
            for (repo in listOf(source, target)) {
                File(context.filesDir, "libraries/${repo.libraryId}").deleteRecursively()
                context.deleteDatabase("shiwen-library-${repo.libraryId}.sqlite")
            }
        }
    }
    @Test fun copyingImagesCreatesIndependentIdsAndRetriesWithoutDuplicates() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "copy-image-${UUID.randomUUID()}"
        val manager = LibraryManager(context, "$namespace-registry", "$namespace-legacy")
        val source = manager.create("source"); val target = manager.create("target")
        try {
            val bytes = byteArrayOf(137.toByte(),80,78,71,13,10,26,10,0,1)
            val imported = source.importMarkdown(UUID.randomUUID().toString(), "photo", "text", originalName = "image.png", originalBytes = bytes)
            val sourceId = JSONArray(imported.attachmentDescriptorsJson).getJSONObject(0).getString("id")
            val codeReference = "![example](attachment:00000000-0000-4000-8000-000000000000)"
            val updated = source.update(imported.id, imported.revision, UUID.randomUUID().toString(),
                JSONObject().put("markdown", "text ![photo](attachment:$sourceId)\n```\n$codeReference\n```"))
            val requestId = UUID.randomUUID().toString()
            val copied = LibraryImageCopy.copy(source, target, updated.id, requestId)
            val newId = JSONArray(copied.attachmentDescriptorsJson).getJSONObject(0).getString("id")
            assertNotEquals(sourceId, newId)
            assertTrue(copied.markdown.contains("attachment:$newId"))
            assertTrue(copied.markdown.contains(codeReference))
            assertEquals(bytes.toList(), target.attachmentBytes(newId).toList())
            assertEquals(copied.id, LibraryImageCopy.copy(source, target, updated.id, requestId).id)
            assertEquals(1, target.dao.recordCount())
        } finally {
            manager.closeForTest()
            for (repo in listOf(source, target)) {
                File(context.filesDir, "libraries/${repo.libraryId}").deleteRecursively()
                context.deleteDatabase("shiwen-library-${repo.libraryId}.sqlite")
            }
        }
    }
}
