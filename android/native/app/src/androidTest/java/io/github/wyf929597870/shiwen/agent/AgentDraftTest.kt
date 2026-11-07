package io.github.wyf929597870.shiwen.agent

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class AgentDraftTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val libraryId = UUID.randomUUID().toString()

    private fun withStore(block: (AgentTaskStore, String) -> Unit) {
        val namespace = "agent-draft-test-${UUID.randomUUID()}"
        val filename = "$namespace-$libraryId.sqlite"
        try { block(AgentTaskStore(context, libraryId, namespace), filename) }
        finally {
            runCatching { context.deleteDatabase(filename) }
        }
    }

    @Test fun openingVersionOneTaskJournalMigratesWithoutLosingRunningTurn() = withStore { _, filename ->
        // This is the exact exported v1 schema and identity hash, seeded in an isolated test DB.
        val path = context.getDatabasePath(filename)
        path.parentFile?.mkdirs()
        val v1 = SQLiteDatabase.openOrCreateDatabase(path, null)
        try {
            v1.execSQL("CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)")
            v1.execSQL("CREATE TABLE agent_tasks (requestId TEXT NOT NULL, fingerprint TEXT NOT NULL, input TEXT NOT NULL, modelId TEXT NOT NULL, receiptRequestId TEXT, status TEXT NOT NULL, output TEXT NOT NULL, error TEXT, updatedAt TEXT NOT NULL, PRIMARY KEY(requestId))")
            v1.execSQL("INSERT INTO room_master_table (id,identity_hash) VALUES(42,'f917bb868eed385bac1abfaa200dd308')")
            v1.execSQL("INSERT INTO agent_tasks VALUES('legacy-request','fingerprint','旧请求','model-a',NULL,'running','已输出片段',NULL,'2026-11-06T00:00:00Z')")
            v1.version = 1
        } finally { v1.close() }

        val migrated = AgentTaskStore(context, libraryId, filename.removeSuffix("-$libraryId.sqlite"))
        try {
            val task = checkNotNull(migrated.dao.get("legacy-request"))
            assertEquals("running", task.status)
            assertEquals("已输出片段", task.output)
            assertEquals("A v1 task has no draft binding and must never authorize an ACK", "", task.submissionHash)
            assertEquals(LEGACY_CONVERSATION_ID, task.conversationId)
            migrated.ensureLegacyConversation()
            val legacy = checkNotNull(migrated.dao.conversation(LEGACY_CONVERSATION_ID))
            assertTrue(legacy.archived)
            assertTrue(legacy.readOnly)
            // The newly added draft table is available, and old task identity remains queryable.
            migrated.dao.saveDraft(AgentDraft(requestId = "composer-id", input = "未发送草稿",
                saveOriginal = true, kind = "journal", generation = 3))
            assertEquals("未发送草稿", migrated.dao.draft(LEGACY_CONVERSATION_ID)?.input)
        } finally { migrated.db.close() }
    }

    @Test fun acknowledgementOnlyClearsTheExactDraftGenerationAndRequest() = withStore { store, _ ->
        try {
            val conversationId = UUID.randomUUID().toString()
            val first = AgentDraft(slot = conversationId, requestId = "first-request", input = "正在发送的内容",
                saveOriginal = true, kind = "journal", generation = 8, conversationId = conversationId)
            store.dao.saveDraft(first)
            val newer = AgentDraft(slot = conversationId, requestId = "second-request", input = "新写的内容",
                saveOriginal = false, kind = "idea", generation = 9, conversationId = conversationId)
            store.dao.saveDraft(newer)

            store.dao.clearDraft(conversationId, first.requestId, first.generation)
            assertEquals("The old ACK cannot erase the newer conversation draft", newer, store.dao.draft(conversationId))
            store.dao.clearDraft(conversationId, newer.requestId, 8)
            assertEquals("Wrong generation cannot clear the draft", newer, store.dao.draft(conversationId))
            store.dao.clearDraft(conversationId, newer.requestId, newer.generation)
            assertNull(store.dao.draft(conversationId))
        } finally { store.db.close() }
    }
}
