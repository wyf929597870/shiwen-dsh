package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.wyf929597870.shiwen.model.Canonical
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LibrarySyncWirePayloadTest {
    @Test fun longImportedRecordUsesStrictWireAttachmentShapeAndRejectedPushIsVisible() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val libraryId = UUID.randomUUID().toString()
        val namespace = "sync-wire-${UUID.randomUUID()}"
        val manager = LibraryManager(context, namespace, "$namespace-legacy")
        manager.attachRemote(libraryId, UUID.randomUUID().toString(), UUID.randomUUID().toString(), 1,
            "synthetic-node", "synthetic-config", "Wire fixture")
        manager.update(manager.row(libraryId).copy(integrity = "complete", appliedCursor = "0", completeCursor = "0", cursor = "0",
            manifestDigest = "a".repeat(64)))
        val nodes = NodeSettingsStore(context, "$namespace-nodes")
        val repo = manager.openLibrary(libraryId)
        try {
            val markdown = "长文资料".repeat(200_000)
            val raw = markdown.toByteArray(Charsets.UTF_8)
            val record = repo.importMarkdown(UUID.randomUUID().toString(), "Android long fixture", markdown,
                JSONObject().put("kind", "reference").put("origin", "external").put("processing", "original")
                    .put("contentDay", "2024-03-03"), "long-original.md", raw, "import")
            val descriptor = JSONArray(record.attachmentDescriptorsJson).getJSONObject(0)
            assertTrue(descriptor.has("createdAt")) // local metadata remains intact
            assertArrayEquals(raw, repo.attachmentBytes(descriptor.getString("id")))

            val outbox = repo.dao.pendingOutbox(10).single()
            val operation = JSONObject(outbox.payloadJson)
            val payload = operation.getJSONObject("payload")
            assertEquals(markdown, payload.getString("markdown"))
            val wireDescriptor = payload.getJSONArray("attachmentDescriptors").getJSONObject(0)
            assertEquals(setOf("id", "hash", "byteLength", "name"), wireDescriptor.keys().asSequence().toSet())
            assertEquals(descriptor.getString("id"), wireDescriptor.getString("id"))
            assertEquals(raw.size.toLong(), wireDescriptor.getLong("byteLength"))
            assertTrue(outbox.payloadJson.toByteArray(Charsets.UTF_8).size > 512 * 1024)

            val coordinator = LibrarySyncCoordinator(context, manager, nodes)
            try {
                val localAttachment = repo.dao.attachments(record.id).single()
                repo.dao.putAttachment(localAttachment.copy(uploaded = true))
                val oldOperation = JSONObject(outbox.payloadJson)
                oldOperation.getJSONObject("payload").getJSONArray("attachmentDescriptors").getJSONObject(0)
                    .put("createdAt", descriptor.getString("createdAt"))
                val rejectedLegacy = outbox.copy(payloadJson = oldOperation.toString(),
                    fingerprint = Canonical.hash(plain(oldOperation)), state = "rejected", lastError = "VALIDATION_ERROR")
                repo.dao.updateOutbox(rejectedLegacy)
                assertEquals(1, coordinator.repairKnownRejectedAttachmentDescriptors(repo))
                val repaired = checkNotNull(repo.dao.outbox(outbox.operationId))
                assertEquals("pending", repaired.state)
                val repairedDescriptor = JSONObject(repaired.payloadJson).getJSONObject("payload")
                    .getJSONArray("attachmentDescriptors").getJSONObject(0)
                assertEquals(setOf("id", "hash", "byteLength", "name"), repairedDescriptor.keys().asSequence().toSet())
                // Retire the repaired synthetic row so the next assertion can isolate
                // an unrelated non-recoverable rejection.
                repo.dao.updateOutbox(repaired.copy(state = "applied"))

                val unrelated = repo.create(UUID.randomUUID().toString(), JSONObject()
                    .put("kind", "idea").put("title", "Unrelated rejected operation").put("markdown", "留待诊断")
                    .put("origin", "personal").put("processing", "original")
                    .put("sources", JSONArray().put(JSONObject().put("text", "留待诊断").put("origin", "personal"))), 1)
                val unrelatedOutbox = repo.dao.outboxByVersionId(unrelated.versionId)!!
                repo.dao.updateOutbox(unrelatedOutbox.copy(state = "rejected", lastError = "VALIDATION_ERROR"))

            // A permanently rejected receipt must not disappear just because it is no
            // longer counted as pending; status exposes its operation and safe code.
                val status = coordinator.status(libraryId)
                assertEquals(0, status.getInt("pendingCount"))
                assertEquals(1, status.getInt("rejectedCount"))
                assertEquals("attention", status.getString("state"))
                assertEquals("VALIDATION_ERROR", status.getJSONArray("rejectedOperations").getJSONObject(0).getString("code"))
            } finally {
                coordinator.closeForTest()
            }
        } finally {
            manager.closeForTest()
            nodes.clearForTest()
            File(context.filesDir, "libraries/$libraryId").deleteRecursively()
        }
    }

    private fun plain(value: Any?): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        else -> value
    }
}
