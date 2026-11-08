package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.io.File
import androidx.core.content.FileProvider
import org.json.JSONArray

@RunWith(AndroidJUnit4::class)
class ShareInboxStoreTest {
    @Test fun sharedImageIsCopiedBeforeSourceDisappearsAndSavedOnce() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "shared-image-${UUID.randomUUID()}"
        val manager = LibraryManager(context, "$namespace-registry", "$namespace-legacy")
        val target = manager.create("Image target")
        val inbox = ShareInboxStore(context, namespace)
        val source = File(context.cacheDir, "shiwen-transfers/${UUID.randomUUID()}.png")
        source.parentFile!!.mkdirs()
        val bytes = byteArrayOf(137.toByte(),80,78,71,13,10,26,10,0,1)
        source.writeBytes(bytes)
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", source)
            assertTrue(inbox.receive(Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri)))
            assertTrue(source.delete())
            val pending = inbox.list().getJSONArray("items").getJSONObject(0)
            val input = JSONObject().put("kind", "reference").put("title", "Image").put("markdown", "")
                .put("origin", "external").put("processing", "original")
            val saved = inbox.save(pending.getString("id"), target, input)
            val id = JSONArray(saved.attachmentDescriptorsJson).getJSONObject(0).getString("id")
            assertTrue(saved.markdown.contains("attachment:$id"))
            assertEquals(bytes.toList(), target.attachmentBytes(id).toList())
            assertEquals(saved.id, inbox.save(pending.getString("id"), target, input).id)
            assertEquals(1, target.dao.recordCount())
        } finally {
            source.delete(); manager.closeForTest()
            context.getSharedPreferences(namespace, Context.MODE_PRIVATE).edit().clear().commit()
            File(context.filesDir, "libraries/${target.libraryId}").deleteRecursively()
            context.deleteDatabase("shiwen-library-${target.libraryId}.sqlite")
        }
    }
    @Test fun sharedTextWaitsForExplicitLibraryChoiceAndRetriesNeverDuplicate() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "shared-fixture-${UUID.randomUUID()}"
        val manager = LibraryManager(context, "$namespace-registry", "$namespace-legacy")
        val source = manager.create("A"); val target = manager.create("B")
        val inbox = ShareInboxStore(context, namespace)
        try {
            assertFalse(inbox.receive(Intent(Intent.ACTION_VIEW).setData(android.net.Uri.parse("https://example.com"))))
            assertTrue(inbox.receive(Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, "https://example.com/article")))
            assertEquals(0, source.dao.recordCount()); assertEquals(0, target.dao.recordCount())
            val pending = ShareInboxStore(context, namespace).list().getJSONArray("items").getJSONObject(0)
            assertEquals("https://example.com/article", pending.getString("text"))
            assertEquals(pending.getString("text"), pending.getString("url"))
            val input = JSONObject().put("kind", "web").put("title", "Shared link")
                .put("markdown", pending.getString("text")).put("url", pending.getString("url"))
                .put("origin", "external").put("processing", "original")
            val saved = inbox.save(pending.getString("id"), target, input)
            val repeated = ShareInboxStore(context, namespace).save(pending.getString("id"), target, input)
            assertEquals(saved.id, repeated.id)
            assertEquals(0, source.dao.recordCount()); assertEquals(1, target.dao.recordCount())
            assertEquals(1, target.versions(saved.id).size)
            assertEquals("import", target.dao.activities(saved.id).single().action)
            assertEquals(0, inbox.list().getJSONArray("items").length())
            assertEquals("SHARE_TARGET_FROZEN", assertThrows(IllegalStateException::class.java) {
                inbox.save(pending.getString("id"), source, input)
            }.message)
            // The original is only a link; no web fetch or invented article body occurs.
            assertEquals("https://example.com/article", saved.markdown)
        } finally {
            manager.closeForTest()
            context.getSharedPreferences(namespace, Context.MODE_PRIVATE).edit().clear().commit()
            context.deleteDatabase("shiwen-library-${source.libraryId}.sqlite")
            context.deleteDatabase("shiwen-library-${target.libraryId}.sqlite")
        }
    }
}
