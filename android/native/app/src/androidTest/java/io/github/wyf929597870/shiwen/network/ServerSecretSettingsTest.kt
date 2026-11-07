package io.github.wyf929597870.shiwen.network

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
class ServerSecretSettingsTest {
    @Test fun nativeSecretNeverReturnsThroughBridgeAndStaleNodeCannotSend() {
        val store = NodeSettingsStore(ApplicationProvider.getApplicationContext(), "native-secret-fixture-${UUID.randomUUID()}")
        val server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
        try {
            val node = store.save(null, "Synthetic secret fixture", server.url("/").toString(), true)
            val id = node.getString("id"); val revision = node.getString("configRevision")
            store.update(id, node.getString("baseUrl"), revision) { it.put("authenticated", true).put("cookies", JSONArray().put("fixture-session=yes; Path=/")) }
            val writer = ServerSecretSettings(store); val path = JSONArray().put("apiKey")
            assertEquals("NODE_CHANGED", runCatching { writer.set(id, "stale", "model", path, 4, "synthetic-secret") }.exceptionOrNull()?.message)
            assertEquals(0, server.requestCount)
            server.enqueue(MockResponse().setBody("{\"result\":{\"action\":\"settings.secretSet\",\"data\":{\"ok\":true,\"unexpectedEcho\":\"synthetic-secret\"}}}"))
            val result = writer.set(id, revision, "model", path, 4, "synthetic-secret")
            assertEquals("saved", result.getString("status")); assertFalse(result.toString().contains("synthetic-secret"))
            val request = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("fixture-session=yes", request.getHeader("Cookie"))
            val body = JSONObject(request.body.readUtf8())
            assertEquals("mobileManagement", body.getString("method"))
            assertEquals("synthetic-secret", body.getJSONObject("args").getJSONObject("args").getString("value"))
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            assertEquals("unknown", writer.set(id, revision, "model", path, 5, "synthetic-secret").getString("status"))
            assertEquals(2, server.requestCount)
            server.enqueue(MockResponse().setResponseCode(400).setBody("{\"error\":\"synthetic-secret\"}"))
            val rejected = writer.set(id, revision, "model", path, 5, "synthetic-secret")
            assertEquals("rejected", rejected.getString("status"));assertFalse(rejected.toString().contains("synthetic-secret"))
        } finally { store.clearForTest(); server.shutdown() }
    }
}
