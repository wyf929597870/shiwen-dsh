package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.wyf929597870.shiwen.agent.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LibraryClientArchiveTest {
    @Test fun draftsAndConversationArchivesRestoreWithoutResendingOrOverwritingLaterEdits() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "client-archive-${UUID.randomUUID()}"
        val manager = LibraryManager(context, namespace, "$namespace-legacy")
        val source = manager.create("Source"); val target = manager.create("Target")
        val drafts = RecordEditorDraftStore(context)
        val agent = AgentTaskStore(context, source.libraryId); val restoredAgent = AgentTaskStore(context, target.libraryId)
        val conversationId = UUID.randomUUID().toString(); val requestId = UUID.randomUUID().toString(); val at = Instant.now().toString()
        try {
            drafts.save(source.libraryId, "materials", requestId, 7, JSONObject().put("markdown", "尚未保存的正文"))
            agent.dao.insertConversation(AgentConversation(conversationId, "A conversation", "synthetic-model", "revision", false, false, at, at))
            agent.dao.insert(AgentTask(UUID.randomUUID().toString(), "fingerprint", "question", "synthetic-model", null,
                status = "running", output = "partial answer", conversationId = conversationId))
            agent.dao.saveDraft(AgentDraft(conversationId, UUID.randomUUID().toString(), "unsent", false, "idea", 3, conversationId))
            val transfer = LibraryClientArchive(context)
            val archive = transfer.capture(source)
            assertFalse(archive.has("modelConfig")); assertFalse(archive.has("nodes")); assertFalse(archive.has("apiKey"))
            assertFalse(transfer.capture(source, false).has("agentArchive"))
            target.dao.putMeta(LibraryMeta("restored-client-archive-v1", archive.toString()))
            transfer.restoreDrafts(target); transfer.restoreConversations(target, restoredAgent)
            assertEquals("尚未保存的正文", drafts.read(target.libraryId, "materials").getJSONObject("draft").getJSONObject("content").getString("markdown"))
            val restored = restoredAgent.dao.archiveTasks().single()
            assertEquals("interrupted", restored.status); assertEquals("partial answer", restored.output)
            assertTrue(restoredAgent.dao.conversation(conversationId)!!.readOnly)
            assertEquals("unsent", restoredAgent.dao.draft(conversationId)!!.input)
            drafts.save(target.libraryId, "materials", requestId, 8, JSONObject().put("markdown", "恢复后继续编辑"))
            // Simulate interruption between the secondary DB commit and the library marker commit.
            target.dao.putMeta(LibraryMeta("restored-editor-archive-digest", ""))
            target.dao.putMeta(LibraryMeta("restored-agent-archive-digest", ""))
            transfer.restoreDrafts(target); transfer.restoreConversations(target, restoredAgent)
            assertEquals("恢复后继续编辑", drafts.read(target.libraryId, "materials").getJSONObject("draft").getJSONObject("content").getString("markdown"))
            assertEquals(1, restoredAgent.dao.archiveTasks().size)
        } finally {
            drafts.clearLibraryForTest(source.libraryId); drafts.clearLibraryForTest(target.libraryId); drafts.close()
            agent.db.close(); restoredAgent.db.close(); manager.closeForTest()
            for (id in listOf(source.libraryId, target.libraryId)) {
                context.deleteDatabase("shiwen-p0-agent-$id.sqlite")
                context.deleteDatabase("shiwen-library-$id.sqlite")
            }
        }
    }
}
