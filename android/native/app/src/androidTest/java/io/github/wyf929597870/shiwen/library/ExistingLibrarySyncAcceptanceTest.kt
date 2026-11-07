package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.os.Bundle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.wyf929597870.shiwen.network.NodeConnection
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit opt-in acceptance against the user's existing authenticated node.
 * Never creates fixtures, clears databases, exports credentials, or prints content. */
@RunWith(AndroidJUnit4::class)
class ExistingLibrarySyncAcceptanceTest {
    @get:org.junit.Rule val foreground = ForegroundIntegrationRule()
    @Test fun previouslySyncedActiveLibraryRemainsCompleteOffline() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("verifyExistingOffline") == "true")
        val manager = LibraryManager(ApplicationProvider.getApplicationContext<Context>())
        try {
            val repo = manager.active()
            assertEquals("complete", repo.context().integrity)
            assertTrue("The active library has no records", repo.dao.recordCount() > 0)
            val attachments = repo.dao.allAttachments()
            for (attachment in attachments) {
                assertTrue("An attachment has not been downloaded", attachment.downloaded)
                assertEquals("An attachment has an unexpected size", attachment.byteLength, repo.attachmentBytes(attachment.id).size.toLong())
            }
            InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
                putString("stream", "Offline library verified: records=${repo.dao.recordCount()}; attachments=${attachments.size}; integrity=complete\n")
            })
        } finally { manager.close() }
    }
    @Test fun existingAuthenticatedLibraryBecomesACompleteLocalReplica() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("verifyExistingLibrary") == "true")
        val origin = requireNotNull(args.getString("expectedNodeOrigin"))
        val context = ApplicationProvider.getApplicationContext<Context>()
        val nodes = NodeSettingsStore(context)
        val manager = LibraryManager(context)
        val coordinator = LibrarySyncCoordinator(context, manager, nodes)
        try {
            val items = nodes.list().getJSONArray("items")
            val matches = (0 until items.length()).map(items::getJSONObject).filter {
                it.optString("baseUrl").trimEnd('/') == origin.trimEnd('/') && it.optBoolean("authenticated")
            }
            assertEquals("Expected one existing authenticated node for the requested origin", 1, matches.size)
            val node = matches.single()
            val nodeId = node.getString("id"); val revision = node.getString("configRevision")
            val task = coordinator.connect(nodeId)
            val libraryId = task.getString("libraryId")
            val deadline = System.nanoTime() + 240_000_000_000L
            var complete = false
            while (System.nanoTime() < deadline) {
                val progress = coordinator.progress(libraryId, task.getString("operationId"))
                if (progress.optString("state") == "completed") { complete = true; break }
                if (progress.optString("state") == "failed") fail("Library sync failed: " + progress.optString("error"))
                Thread.sleep(200)
            }
            assertTrue("Existing library sync did not complete", complete)
            val repo = manager.openLibrary(libraryId)
            assertEquals("complete", manager.row(libraryId).integrity)
            val binding = JSONObject().put("libraryId", libraryId).put("epoch", manager.row(libraryId).epoch)
                .put("deviceId", repo.deviceId)
            val snapshot = NodeConnection(nodes).mobileSync(nodeId, "bootstrapBegin", binding, revision).getJSONObject("data")
            val manifest = snapshot.getJSONObject("manifest")
            val counts = manifest.getJSONObject("counts")
            val localRecords = repo.dao.recordCount()
            assertTrue("The selected server library must contain existing records", localRecords > 0)
            // The Host's manifest shape is validated by the protocol tests; compare counts without logging documents.
            assertEquals("Record count differs from the server snapshot", counts.getInt("records"), localRecords)
            assertTrue("Missing server history", repo.dao.allVersions().size >= counts.getInt("versions"))
            assertTrue("Missing server activities", repo.dao.allActivities().size >= counts.getInt("activities"))
            assertTrue("Missing original attachments", repo.dao.allAttachments().size >= counts.getInt("attachments"))
            // Make the replica the active library only after full validation succeeds.
            manager.select(libraryId)
            InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
                putString("stream", "Existing library verified: records=$localRecords; integrity=complete\n")
            })
        } finally { coordinator.close(); manager.close() }
    }
}
