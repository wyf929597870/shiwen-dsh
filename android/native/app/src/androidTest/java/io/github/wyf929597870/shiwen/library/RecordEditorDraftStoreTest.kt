package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class RecordEditorDraftStoreTest {
    private fun id() = UUID.randomUUID().toString()
    private fun content(text: String) = JSONObject().put("title", "标题").put("markdown", text)

    @Test fun pendingMutationAndDraftSurviveStoreRecreationAndRemainLibraryScoped() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "record-editor-reopen-${id()}"
        val library = id()
        val request = id()
        val first = RecordEditorDraftStore(context, namespace)
        val content = content("等待确认的正文")
        val pending = JSONObject().put("action", "create").put("requestId", request)
            .put("localGeneration", 3).put("record", JSONObject().put("markdown", "等待确认的正文"))
        try {
            first.save(library, "materials", request, 3, content)
            first.save(library, "materials", request, 3, content, pending)
            first.close()

            val reopened = RecordEditorDraftStore(context, namespace)
            try {
                val recovered = reopened.read(library, "materials")
                val draft = recovered.getJSONObject("draft")
                assertEquals(request, draft.getString("requestId"))
                assertEquals(3L, draft.getLong("localGeneration"))
                assertEquals("等待确认的正文", draft.getJSONObject("content").getString("markdown"))
                assertEquals("create", draft.getJSONObject("pendingMutation").getString("action"))
                assertTrue(reopened.read(id(), "materials").isNull("draft"))
                assertTrue(reopened.read(library, "articles").isNull("draft"))
            } finally { reopened.closeForTest() }
        } finally { runCatching { first.closeForTest() } }
    }

    @Test fun ackRequiresExactRequestAndGenerationAndLateSaveCannotResurrect() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val store = RecordEditorDraftStore(context, "record-editor-ack-${id()}")
        val library = id(); val request = id(); val body = content("已提交内容")
        val pending = JSONObject().put("action", "create").put("requestId", request)
            .put("localGeneration", 8).put("record", JSONObject().put("markdown", "已提交内容"))
        try {
            store.save(library, "composer", request, 8, body, pending)
            assertFalse(store.acknowledge(library, "composer", id(), 8).getBoolean("cleared"))
            assertFalse(store.acknowledge(library, "composer", request, 7).getBoolean("cleared"))
            assertTrue(store.acknowledge(library, "composer", request, 8).getBoolean("cleared"))
            val empty = store.read(library, "composer")
            assertTrue(empty.isNull("draft"))
            assertEquals(9L, empty.getLong("nextGeneration"))
            assertNotNull(runCatching { store.save(library, "composer", request, 8, body, pending) }.exceptionOrNull())
            assertTrue(store.read(library, "composer").isNull("draft"))
            val nextRequest = id()
            store.save(library, "composer", nextRequest, 9, content("下一条草稿"))
            assertEquals("下一条草稿", store.read(library, "composer").getJSONObject("draft").getJSONObject("content").getString("markdown"))
        } finally { store.closeForTest() }
    }

    @Test fun pendingMutationCannotBeChangedOrOverwrittenByANewerDraft() {
        val store = RecordEditorDraftStore(ApplicationProvider.getApplicationContext(), "record-editor-lock-${id()}")
        val library = id(); val request = id(); val body = content("保持的内容")
        val pending = JSONObject().put("action", "update").put("requestId", request)
            .put("localGeneration", 2).put("id", "record-1").put("expectedRevision", 4).put("patch", JSONObject(body.toString()))
        try {
            store.save(library, "materials", request, 2, body, pending)
            val changed = JSONObject(pending.toString()).put("expectedRevision", 5)
            assertEquals("RECORD_DRAFT_PENDING_IMMUTABLE", runCatching {
                store.save(library, "materials", request, 2, body, changed)
            }.exceptionOrNull()?.message)
            assertEquals("RECORD_DRAFT_PENDING_LOCKED", runCatching {
                store.save(library, "materials", id(), 3, content("不可覆盖"))
            }.exceptionOrNull()?.message)
            assertEquals(4L, store.read(library, "materials").getJSONObject("draft").getJSONObject("pendingMutation").getLong("expectedRevision"))
        } finally { store.closeForTest() }
    }
}
