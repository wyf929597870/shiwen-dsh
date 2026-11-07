package io.github.wyf929597870.shiwen.network

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
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
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class NodeAgentActionsTest {
    private fun fixture(): JSONObject = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
        .open("profile-fixture.json").bufferedReader().use { it.readText() })

    private fun server() = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }

    private fun authenticatedNode(store: NodeSettingsStore, server: MockWebServer, name: String): String {
        val row = store.save(null, name, server.url("/").toString(), true)
        val id = row.getString("id")
        store.update(id, row.getString("baseUrl"), row.getString("configRevision")) {
            it.put("authenticated", true).put("cookies", JSONArray().put("node-session=fixture; Path=/"))
        }
        return id
    }

    @Test fun stateUsesTheExplicitAuthenticatedNodeAndReturnsOnlyGlobalAgentFields() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-agent-state-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        val server = server()
        try {
            val id = authenticatedNode(store, server, "node-A")
            store.select(null) // The operation must use its explicit id, not a mutable selection.
            val raw = JSONObject().put("identity", JSONObject().put("body", "助手身份").put("revision", 3))
                .put("soul", JSONObject().put("body", "交流方式").put("revision", 4))
                .put("policy", JSONObject().put("secret", "never expose"))
                .put("events", JSONArray().put(JSONObject().put("secret", "never expose")))
                .put("memories", JSONArray()
                    .put(memory("global-active", "全局记忆", "memory", "active", "global"))
                    .put(memory("global-pending", "待确认", "user", "pending", "global"))
                    .put(memory("project", "项目记忆", "project", "active", "article-1"))
                    .put(memory("unscoped", "缺少来源范围", "memory", "active", null)))
            server.enqueue(MockResponse().setBody(JSONObject().put("result", raw).toString()))

            val result = NodeAgentActions(store).state(id)
            assertEquals("助手身份", result.getJSONObject("identity").getString("body"))
            assertEquals(3, result.getJSONObject("identity").getInt("revision"))
            assertFalse(result.has("policy")); assertFalse(result.has("events"))
            val memories = result.getJSONArray("memories")
            assertEquals(2, memories.length())
            assertEquals("global-active", memories.getJSONObject(0).getString("id"))
            assertEquals("pending", memories.getJSONObject(1).getString("status"))
            assertFalse(result.toString().contains("项目记忆"))
            assertFalse(result.toString().contains("缺少来源范围"))
            assertFalse(result.toString().contains("never expose"))
            val request = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("/api/shiwen", request.path)
            assertEquals("node-session=fixture", request.getHeader("Cookie"))
            val rpc = JSONObject(request.body.readUtf8())
            assertEquals("agentState", rpc.getString("method"))
            assertEquals(0, rpc.getJSONObject("args").length())
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun successfulWriteStaysSuccessfulWhenFollowingProfileRefreshFails() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-agent-refresh-failure-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        val server = server()
        try {
            val id = authenticatedNode(store, server, "node-A")
            server.enqueue(MockResponse().setBody(JSONObject().put("result", JSONObject()
                .put("name", "IDENTITY.md").put("body", "新身份").put("revision", 8)).toString()))
            server.enqueue(MockResponse().setBody("{\"authenticated\":true}"))
            server.enqueue(MockResponse().setResponseCode(503).setBody("{\"error\":\"profile service unavailable\"}"))

            val result = NodeAgentActions(store).saveDocument(id, "IDENTITY.md", "新身份", 7)
            assertTrue(result.getBoolean("saved"))
            assertFalse(result.getBoolean("profileSynced"))
            assertEquals("profile service unavailable", result.getString("syncError"))
            val write = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("POST", write.method); assertEquals("/api/shiwen", write.path)
            val rpc = JSONObject(write.body.readUtf8())
            assertEquals("agentDocumentSave", rpc.getString("method"))
            assertEquals("global", rpc.getJSONObject("args").getString("scope"))
            assertEquals(7, rpc.getJSONObject("args").getInt("revision"))
            assertEquals("GET", server.takeRequest(2, TimeUnit.SECONDS)!!.method)
            assertEquals("mobileAgentProfile", JSONObject(server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()).getString("method"))
            assertEquals("Write POST must be issued exactly once", 3, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun revisionConflictIsReturnedWithoutRefreshingOrRetryingTheWrite() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-agent-conflict-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        val server = server()
        try {
            val id = authenticatedNode(store, server, "node-A")
            server.enqueue(MockResponse().setResponseCode(400)
                .setBody("{\"error\":\"配置已变更，请刷新后再保存\"}"))
            val error = runCatching { NodeAgentActions(store).saveDocument(id, "SOUL.md", "新交流方式", 2) }
                .exceptionOrNull()
            assertEquals("配置已变更，请刷新后再保存", error?.message)
            val request = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("agentDocumentSave", JSONObject(request.body.readUtf8()).getString("method"))
            assertEquals(1, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun successfulHttpWithoutTypedWriteResultIsNotReportedAsSaved() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-agent-unknown-result-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        val server = server()
        try {
            val id = authenticatedNode(store, server, "node-A")
            server.enqueue(MockResponse().setBody("{\"ok\":true}")) // Missing RPC result envelope.
            val error = runCatching { NodeAgentActions(store).saveDocument(id, "IDENTITY.md", "内容", 1) }
                .exceptionOrNull()
            assertEquals("NODE_WRITE_RESULT_UNKNOWN", error?.message)
            assertEquals(1, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun lostWriteAcknowledgementIsUnknownAndIsNeverAutomaticallyRetried() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-agent-lost-ack-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        val server = server()
        try {
            val id = authenticatedNode(store, server, "node-A")
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            val error = runCatching { NodeAgentActions(store).saveDocument(id, "IDENTITY.md", "新身份", 1) }
                .exceptionOrNull()
            assertEquals("NODE_WRITE_RESULT_UNKNOWN", error?.message)
            val request = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("agentDocumentSave", JSONObject(request.body.readUtf8()).getString("method"))
            assertEquals("POST", request.method)
            assertEquals("Only the user may decide whether to retry an unacknowledged write", 1, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun delayedWriteForEditedNodeIdDoesNotRefreshItsNewAddress() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-agent-edited-address-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        val oldServer = server(); val newServer = server()
        try {
            val id = authenticatedNode(store, oldServer, "same-node-id")
            oldServer.enqueue(MockResponse().setBody(JSONObject().put("result", JSONObject()
                .put("name", "SOUL.md").put("body", "更新的风格").put("revision", 5)).toString())
                .setBodyDelay(700, TimeUnit.MILLISECONDS))
            val pending = CompletableFuture.supplyAsync {
                NodeAgentActions(store).saveDocument(id, "SOUL.md", "更新的风格", 4)
            }
            val writeRequest = oldServer.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("agentDocumentSave", JSONObject(writeRequest.body.readUtf8()).getString("method"))
            val current = store.get(id)
            store.save(id, "same-node-id", newServer.url("/").toString(), true)

            val result = pending.get(5, TimeUnit.SECONDS)
            assertTrue(result.getBoolean("saved"))
            assertFalse(result.getBoolean("profileSynced"))
            assertEquals("NODE_CHANGED", result.getString("syncError"))
            assertEquals(1, oldServer.requestCount)
            assertEquals("Edited address must not receive a profile refresh from the old write", 0, newServer.requestCount)
            assertNotEquals(current.getString("configRevision"), store.get(id).getString("configRevision"))
        } finally { store.clearForTest(); oldServer.shutdown(); newServer.shutdown() }
    }

    @Test fun delayedNodeARefreshCannotWriteItsProfileIntoNodeB() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-agent-node-isolation-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        val serverA = server(); val serverB = server()
        try {
            val idA = authenticatedNode(store, serverA, "node-A")
            val idB = authenticatedNode(store, serverB, "node-B")
            val profileA = profile("persona-A")
            val profileB = profile("persona-B")
            serverA.enqueue(MockResponse().setBody("{\"authenticated\":true}"))
            serverA.enqueue(MockResponse().setBody(JSONObject().put("result", profileA).toString())
                .setBodyDelay(700, TimeUnit.MILLISECONDS))
            val delayed = CompletableFuture.runAsync { NodeConnection(store).refresh(idA) }
            assertEquals("/auth/status", serverA.takeRequest(2, TimeUnit.SECONDS)!!.path)
            assertEquals("/api/shiwen", serverA.takeRequest(2, TimeUnit.SECONDS)!!.path)

            store.select(idB)
            serverB.enqueue(MockResponse().setBody("{\"authenticated\":true}"))
            serverB.enqueue(MockResponse().setBody(JSONObject().put("result", profileB).toString()))
            NodeConnection(store).refresh(idB)
            delayed.get(5, TimeUnit.SECONDS)
            assertEquals(profileA.getString("revision"), store.get(idA).getJSONObject("profile").getString("revision"))
            assertEquals(profileB.getString("revision"), store.get(idB).getJSONObject("profile").getString("revision"))
            assertEquals(idB, store.selectedProfile()!!.getString("nodeId"))
        } finally { store.clearForTest(); serverA.shutdown(); serverB.shutdown() }
    }

    @Test fun memoryApprovalEditAndDeleteUseActualObjectRevisionsAndRefreshAfterWrites() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-agent-memory-${UUID.randomUUID()}")
        val server = server()
        try {
            val id = authenticatedNode(store, server, "memory-node")
            fun state(row: JSONObject) = JSONObject().put("identity", JSONObject().put("body", "identity").put("revision", 1))
                .put("soul", JSONObject().put("body", "soul").put("revision", 1)).put("memories", JSONArray().put(row))
            fun enqueue(before: JSONObject, result: Any) {
                server.enqueue(MockResponse().setBody(JSONObject().put("result", state(before)).toString()))
                server.enqueue(MockResponse().setBody(JSONObject().put("result", result).toString()))
                server.enqueue(MockResponse().setBody("{\"authenticated\":true}"))
                server.enqueue(MockResponse().setBody(JSONObject().put("result", fixture()).toString()))
            }
            val pending = memory("candidate", "用户偏好", "user", "pending", "global")
            val accepted = JSONObject(pending.toString()).put("status", "active").put("revision", 2)
            enqueue(pending, accepted)
            val actions = NodeAgentActions(store)
            assertEquals(2, actions.decideMemory(id, "candidate", 1, true).getJSONObject("item").getInt("revision"))
            val edited = JSONObject(accepted.toString()).put("body", "修改后的用户偏好").put("revision", 3)
            enqueue(accepted, edited)
            assertTrue(actions.saveMemory(id, "candidate", "修改后的用户偏好", "user", 2).getBoolean("profileSynced"))
            enqueue(edited, true)
            assertTrue(actions.deleteMemory(id, "candidate", 3).getBoolean("saved"))
            val requests = (0 until 12).map { server.takeRequest(2, TimeUnit.SECONDS)!! }
            assertEquals("memoryDecide", JSONObject(requests[1].body.readUtf8()).getString("method"))
            val edit = JSONObject(requests[5].body.readUtf8()).getJSONObject("args")
            assertEquals("global", edit.getString("scope")); assertEquals(2, edit.getInt("revision"))
            val delete = JSONObject(requests[9].body.readUtf8())
            assertEquals("memoryDelete", delete.getString("method")); assertEquals(3, delete.getJSONObject("args").getInt("revision"))
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun projectMemoryCannotBeMutatedThroughGlobalMobileEditor() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-agent-scope-${UUID.randomUUID()}")
        val server = server()
        try {
            val id = authenticatedNode(store, server, "memory-node")
            val state = JSONObject().put("identity", JSONObject().put("body", "identity").put("revision", 1))
                .put("soul", JSONObject().put("body", "soul").put("revision", 1))
                .put("memories", JSONArray().put(memory("project", "文章专属要求", "project", "active", "article")))
            server.enqueue(MockResponse().setBody(JSONObject().put("result", state).toString()))
            assertEquals("MEMORY_NOT_FOUND_OR_OUT_OF_SCOPE", runCatching { NodeAgentActions(store).deleteMemory(id, "project", 1) }.exceptionOrNull()?.message)
            assertEquals(1, server.requestCount)
            assertEquals("agentState", JSONObject(server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()).getString("method"))
        } finally { store.clearForTest(); server.shutdown() }
    }

    private fun memory(id: String, body: String, category: String, status: String, scope: String?): JSONObject =
        JSONObject().put("id", id).put("body", body).put("category", category).put("status", status)
            .put("revision", 1).put("evidence", "private evidence").put("updated", "2026-11-06")
            .apply { if (scope != null) put("scope", scope) }

    private fun profile(context: String): JSONObject {
        val value = fixture().put("systemContext", context)
        val plain = plain(value)
        (plain as MutableMap<String, Any?>).remove("revision")
        value.put("revision", io.github.wyf929597870.shiwen.model.Canonical.hash(plain))
        return value
    }

    private fun plain(value: Any?): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        else -> value
    }
}
