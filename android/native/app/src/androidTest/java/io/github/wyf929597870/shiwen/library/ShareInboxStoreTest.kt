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

@RunWith(AndroidJUnit4::class)
class ShareInboxStoreTest {
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
