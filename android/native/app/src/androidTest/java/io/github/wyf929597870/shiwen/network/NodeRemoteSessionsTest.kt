package io.github.wyf929597870.shiwen.network

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class NodeRemoteSessionsTest {
    private fun server() = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
    private fun node(store: NodeSettingsStore, server: MockWebServer): JSONObject {
        val row = store.save(null, "Synthetic sessions", server.url("/").toString(), true)
        store.update(row.getString("id"), row.getString("baseUrl"), row.getString("configRevision")) {
            it.put("authenticated", true).put("cookies", JSONArray().put("node-session=fixture; Path=/"))
        }
        return row
    }
    @Test fun requestsAreBoundToExplicitNodeAndExactSessionMethod() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val store = NodeSettingsStore(context, "remote-session-fixture-${UUID.randomUUID()}")
        val server = server()
        try {
            val row = node(store, server)
            server.enqueue(MockResponse().setBody("{\"result\":{\"action\":\"list\",\"data\":{\"items\":[]}}}"))
            val result = NodeConnection(store).mobileSessions(row.getString("id"), "list", JSONObject(), row.getString("configRevision"))
            assertEquals("list", result.getString("action"))
            val request = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("/api/shiwen", request.path)
            assertEquals("node-session=fixture", request.getHeader("Cookie"))
            val body = JSONObject(request.body.readUtf8())
            assertEquals("mobileSessions", body.getString("method"))
            assertEquals("list", body.getJSONObject("args").getString("action"))
            assertNotNull(runCatching { NodeConnection(store).mobileSessions(row.getString("id"), "shell", JSONObject()) }.exceptionOrNull())
            assertEquals(1, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }
    @Test fun staleNodeRevisionIsRejectedBeforeTheRequestLeavesThePhone() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "remote-fence-${UUID.randomUUID()}")
        val server = server()
        try {
            val row = node(store, server)
            val result = runCatching { NodeConnection(store).mobileSessions(row.getString("id"), "send", JSONObject(), "old-revision") }
            assertEquals("NODE_CHANGED", result.exceptionOrNull()?.message)
            assertEquals(0, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }
    @Test fun lostWriteAcknowledgementIsNotAutomaticallyRetried() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "remote-lost-${UUID.randomUUID()}")
        val server = server()
        try {
            val row = node(store, server)
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            val result = runCatching { NodeConnection(store).mobileSessions(row.getString("id"), "send",
                JSONObject().put("requestId", UUID.randomUUID().toString()).put("sessionId", "synthetic").put("mode", "queue")
                    .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", "synthetic message")))) }
            assertEquals("NODE_SESSION_WRITE_UNKNOWN", result.exceptionOrNull()?.message)
            assertEquals(1, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }
    @Test fun pendingDraftSurvivesNewStoreInstanceAndCannotCrossNodeRevision() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "remote-draft-fixture-${UUID.randomUUID()}"
        val first = NodeSessionDraftStore(context, namespace)
        val second = NodeSessionDraftStore(context, namespace)
        val draft = JSONObject().put("requestId", UUID.randomUUID().toString()).put("text", "保留未知发送原文")
            .put("mode", "queue").put("pending", true).put("localGeneration", 2)
        try {
            first.save("node-a", "revision-a", "session-a", draft)
            assertTrue(second.read("node-a", "revision-a", "session-a").getJSONObject("draft").getBoolean("pending"))
            assertTrue(second.read("node-a", "revision-b", "session-a").isNull("draft"))
            assertTrue(second.read("node-b", "revision-a", "session-a").isNull("draft"))
            assertNotNull(runCatching { second.save("node-a", "revision-a", "session-a", JSONObject(draft.toString()).put("localGeneration", 1)) }.exceptionOrNull())
            assertNotNull(runCatching { second.save("node-a", "revision-a", "session-a", JSONObject(draft.toString()).put("pending", false)) }.exceptionOrNull())
            assertTrue(second.read("node-a", "revision-a", "session-a").getJSONObject("draft").getBoolean("pending"))
            second.save("node-a", "revision-a", "session-a", JSONObject(draft.toString()).put("pending", false).put("localGeneration", 3))
            assertFalse(first.read("node-a", "revision-a", "session-a").getJSONObject("draft").getBoolean("pending"))
        } finally { first.closeForTest(); second.closeForTest() }
    }
}
