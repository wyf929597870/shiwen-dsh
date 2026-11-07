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
import java.util.concurrent.CompletableFuture

@RunWith(AndroidJUnit4::class)
class NodeManagementActionsTest {
    private fun server() = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }

    private fun fixture(store: NodeSettingsStore, server: MockWebServer): String {
        val row = store.save(null, "management node", server.url("/").toString(), true)
        val id = row.getString("id")
        store.update(id, row.getString("baseUrl"), row.getString("configRevision")) {
            it.put("authenticated", true).put("cookies", JSONArray().put("node-session=fixture; Path=/"))
        }
        return id
    }

    @Test fun managementUsesFixedEnvelopeExplicitNodeAndAuthenticatedOwnerCookie() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val store = NodeSettingsStore(context, "node-management-${UUID.randomUUID()}")
        val server = server()
        try {
            val id = fixture(store, server)
            store.select(null)
            val data = JSONObject().put("supportedActions", JSONArray().put("capabilities"))
                .put("unavailableServices", JSONArray())
            server.enqueue(MockResponse().setBody(JSONObject().put("result", JSONObject()
                .put("action", "capabilities").put("data", data)).toString()))

            val result = NodeManagementActions(NodeConnection(store)).manage(id, "capabilities", JSONObject())
            assertEquals("capabilities", result.getString("action"))
            assertEquals(data.toString(), result.getJSONObject("data").toString())
            val request = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("node-session=fixture", request.getHeader("Cookie"))
            assertEquals("/api/shiwen", request.path)
            val body = JSONObject(request.body.readUtf8())
            assertEquals("mobileManagement", body.getString("method"))
            assertEquals("capabilities", body.getJSONObject("args").getString("action"))
            assertEquals(0, body.getJSONObject("args").getJSONObject("args").length())
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun arbitraryManagementActionIsRejectedBeforeAnyNetworkRequest() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-management-deny-${UUID.randomUUID()}")
        val server = server()
        try {
            val id = fixture(store, server)
            val error = runCatching { NodeManagementActions(NodeConnection(store)).manage(id, "../arbitrary", JSONObject()) }
                .exceptionOrNull()
            assertEquals("NODE_MANAGEMENT_ACTION_DENIED", error?.message)
            assertEquals(0, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun externalStatusProjectsSafeFieldsAndNeverReturnsTokenOrServerPaths() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-external-status-${UUID.randomUUID()}")
        val server = server()
        try {
            val id = fixture(store, server)
            val raw = JSONObject().put("running", true).put("endpoint", "http://127.0.0.1:38191")
                .put("root", "/secret/home/library").put("command", "/secret/node")
                .put("clients", JSONArray().put(JSONObject().put("id", "client-1").put("name", "Agent")
                    .put("scopes", JSONArray().put("read").put("create")).put("created", "2026-11-06")
                    .put("revoked", JSONObject.NULL).put("last_used", JSONObject.NULL).put("token", "sw_secret")))
            server.enqueue(MockResponse().setBody(JSONObject().put("result", raw).toString()))

            val result = NodeManagementActions(NodeConnection(store)).externalStatus(id)
            assertTrue(result.getBoolean("running"))
            assertEquals("http://127.0.0.1:38191", result.getString("endpoint"))
            assertEquals("client-1", result.getJSONArray("clients").getJSONObject(0).getString("id"))
            assertFalse(result.toString().contains("sw_secret"))
            assertFalse(result.toString().contains("/secret"))
            assertFalse(result.has("root")); assertFalse(result.has("command"))
            val request = JSONObject(server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8())
            assertEquals("externalStatus", request.getString("method"))
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun createTokenIsAvailableOnlyToNativeMetadataBoundaryAndNeverInSafeResult() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-external-create-${UUID.randomUUID()}")
        val server = server()
        try {
            val id = fixture(store, server)
            val issued = JSONObject().put("id", "client-2").put("name", "My agent")
                .put("scopes", JSONArray().put("create").put("read")).put("created", "2026-11-06T10:00:00Z")
                .put("token", "sw_${"A".repeat(43)}")
            server.enqueue(MockResponse().setBody(JSONObject().put("result", issued).toString()))

            val actions = NodeManagementActions(NodeConnection(store))
            val nativeOnly = actions.createExternalClientForNativeDialog(id, "My agent", listOf("create", "read"))
            val safe = actions.externalClientMetadata(nativeOnly)
            assertEquals("client-2", safe.getString("id"))
            assertFalse(safe.has("token"))
            assertFalse(safe.toString().contains("sw_${"A".repeat(43)}"))
            val request = JSONObject(server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8())
            assertEquals("externalClientCreate", request.getString("method"))
            assertEquals("My agent", request.getJSONObject("args").getString("name"))
            assertEquals(1, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun lostManagementWriteAcknowledgementIsUnknownAndNeverRetried() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-management-lost-ack-${UUID.randomUUID()}")
        val server = server()
        try {
            val id = fixture(store, server)
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            val error = runCatching {
                NodeManagementActions(NodeConnection(store)).manage(id, "schedules.run", JSONObject()
                    .put("request", JSONObject().put("id", "schedule-1")))
            }.exceptionOrNull()
            assertEquals("NODE_WRITE_RESULT_UNKNOWN", error?.message)
            assertEquals(1, server.requestCount)
            val request = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("schedules.run", JSONObject(request.body.readUtf8()).getJSONObject("args").getString("action"))
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun invalidManagementWriteEnvelopeIsUnknownAndDoesNotLeakResponseBody() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-management-invalid-${UUID.randomUUID()}")
        val server = server()
        try {
            val id = fixture(store, server)
            server.enqueue(MockResponse().setBody(JSONObject().put("result", JSONObject()
                .put("action", "schedules.run").put("error", "sw_sensitive")).toString()))
            val error = runCatching {
                NodeManagementActions(NodeConnection(store)).manage(id, "schedules.run", JSONObject())
            }.exceptionOrNull()
            assertEquals("NODE_WRITE_RESULT_UNKNOWN", error?.message)
            assertFalse(error?.message.orEmpty().contains("sw_sensitive"))
            assertEquals(1, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun remoteErrorCodeIsUsedWithoutEchoingServerBody() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-management-error-${UUID.randomUUID()}")
        val server = server()
        try {
            val id = fixture(store, server)
            server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"token sw_secret invalid","code":"INVALID_REQUEST"}"""))
            val error = runCatching {
                NodeManagementActions(NodeConnection(store)).manage(id, "schedules.create", JSONObject())
            }.exceptionOrNull()
            assertEquals("INVALID_REQUEST", error?.message)
            assertFalse(error?.message.orEmpty().contains("sw_secret"))
            assertEquals(1, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun unrecognizedHttp400ForWriteIsUnknownBecauseHostMayHaveAppliedIt() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-management-unknown-400-${UUID.randomUUID()}")
        val server = server()
        try {
            val id = fixture(store, server)
            server.enqueue(MockResponse().setResponseCode(400)
                .setBody("""{"error":"possibly-applied sw_secret","code":"UNRECOGNIZED_HOST_FAILURE"}"""))
            val error = runCatching {
                NodeManagementActions(NodeConnection(store)).manage(id, "schedules.run", JSONObject())
            }.exceptionOrNull()
            assertEquals("NODE_WRITE_RESULT_UNKNOWN", error?.message)
            assertFalse(error?.message.orEmpty().contains("sw_secret"))
            assertEquals(1, server.requestCount)
        } finally { store.clearForTest(); server.shutdown() }
    }

    @Test fun delayedWriteForReconfiguredNodeReturnsOnlyOldNodeResultAndFlagsIt() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-management-node-change-${UUID.randomUUID()}")
        val oldServer = server(); val newServer = server()
        try {
            val id = fixture(store, oldServer)
            oldServer.enqueue(MockResponse().setBody(JSONObject().put("result", JSONObject()
                .put("action", "schedules.run").put("data", JSONObject().put("status", "started"))).toString())
                .setBodyDelay(600, TimeUnit.MILLISECONDS))
            val pending = CompletableFuture.supplyAsync {
                NodeManagementActions(NodeConnection(store)).manage(id, "schedules.run", JSONObject())
            }
            assertNotNull(oldServer.takeRequest(2, TimeUnit.SECONDS))
            val row = store.get(id)
            store.save(id, "management node", newServer.url("/").toString(), true)
            val result = pending.get(5, TimeUnit.SECONDS)
            assertTrue(result.getBoolean("nodeChanged"))
            assertEquals("started", result.getJSONObject("data").getString("status"))
            assertEquals(1, oldServer.requestCount)
            assertEquals(0, newServer.requestCount)
            assertNotEquals(row.getString("configRevision"), store.get(id).getString("configRevision"))
        } finally { store.clearForTest(); oldServer.shutdown(); newServer.shutdown() }
    }

    @Test fun delayedReadForReconfiguredNodeFailsClosed() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "node-management-read-change-${UUID.randomUUID()}")
        val oldServer = server(); val newServer = server()
        try {
            val id = fixture(store, oldServer)
            oldServer.enqueue(MockResponse().setBody(JSONObject().put("result", JSONObject()
                .put("action", "capabilities").put("data", JSONObject().put("supportedActions", JSONArray()))).toString())
                .setBodyDelay(600, TimeUnit.MILLISECONDS))
            val pending = CompletableFuture.supplyAsync {
                NodeManagementActions(NodeConnection(store)).manage(id, "capabilities", JSONObject())
            }
            assertNotNull(oldServer.takeRequest(2, TimeUnit.SECONDS))
            store.save(id, "management node", newServer.url("/").toString(), true)
            val error = runCatching { pending.get(5, TimeUnit.SECONDS) }.exceptionOrNull()
            assertEquals("NODE_CHANGED", error?.cause?.message ?: error?.message)
            assertEquals(0, newServer.requestCount)
        } finally { store.clearForTest(); oldServer.shutdown(); newServer.shutdown() }
    }
}
