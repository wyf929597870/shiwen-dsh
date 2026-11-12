package io.github.wyf929597870.shiwen.network

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class NodeConnectionTest {
    private fun fixture(): JSONObject = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
        .open("profile-fixture.json").bufferedReader().use { it.readText() })

    @Test fun loginSyncsProfileAndPersistsOriginBoundSessionWithoutPassword() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-connection-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        val server = MockWebServer(); server.start(InetAddress.getByName("127.0.0.1"), 0)
        try {
            val profile = fixture(); val url = server.url("/").toString()
            val id = store.save(null, "隔离测试节点", url, true).getString("id")
            server.enqueue(MockResponse().setBody("{\"authenticated\":false}"))
            server.enqueue(MockResponse().addHeader("Set-Cookie", "fixture-session=fixture-only; Path=/; HttpOnly").setBody("{\"ok\":true}"))
            server.enqueue(MockResponse().setBody("{\"authenticated\":true}"))
            server.enqueue(MockResponse().setBody(JSONObject().put("result", profile).toString()))
            NodeConnection(store).refresh(id, "fixture-password")
            assertEquals("/auth/status", server.takeRequest(2, TimeUnit.SECONDS)!!.path)
            val login = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("/auth/login", login.path)
            assertEquals(url.trimEnd('/'), login.getHeader("Origin"))
            assertEquals("fixture-password", JSONObject(login.body.readUtf8()).getString("password"))
            assertEquals("fixture-session=fixture-only", server.takeRequest(2, TimeUnit.SECONDS)!!.getHeader("Cookie"))
            assertEquals("mobileAgentProfile", JSONObject(server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()).getString("method"))
            assertFalse(store.get(id).toString().contains("fixture-password"))
            store.select(id)
            assertEquals(profile.getString("revision"), store.selectedProfile()!!.getString("revision"))
            assertEquals("synced", store.get(id).getString("profileSyncStatus"))
            assertEquals(1, store.selectedProfile()!!.getJSONArray("memories").length())
            val restored = NodeSettingsStore(context, namespace)
            server.enqueue(MockResponse().setBody("{\"authenticated\":true}"))
            server.enqueue(MockResponse().setBody(JSONObject().put("result", profile).toString()))
            NodeConnection(restored).refresh(id)
            assertEquals("fixture-session=fixture-only", server.takeRequest(2, TimeUnit.SECONDS)!!.getHeader("Cookie"))
            server.takeRequest(2, TimeUnit.SECONDS)
            server.enqueue(MockResponse().setBody("{\"authenticated\":true}"))
            server.enqueue(MockResponse().setResponseCode(404))
            assertEquals("PROFILE_UNSUPPORTED", runCatching { NodeConnection(restored).refresh(id) }.exceptionOrNull()?.message)
            assertEquals("cached", restored.get(id).getString("profileSyncStatus"))
            assertEquals(profile.getString("revision"), restored.selectedProfile()!!.getString("revision"))
        } finally { store.clearForTest(); server.shutdown() }
    }
    @Test fun changedProfileBodyIsRejectedInsteadOfReplacingCache() {
        val profile = fixture(); NodeConnection.validateProfile(profile)
        profile.put("systemContext", "被修改的文本")
        assertEquals("PROFILE_HASH_MISMATCH", runCatching { NodeConnection.validateProfile(profile) }.exceptionOrNull()?.message)
    }

    @Test fun delayedAgentWriteReturnsConfirmedResultBoundToOldNodeAfterAddressChange() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-agent-write-race-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        val oldNode = MockWebServer(); val newNode = MockWebServer()
        val requestArrived = CountDownLatch(1)
        val releaseResponse = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        oldNode.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/auth/status") return MockResponse().setBody("{\"authenticated\":true}")
                requestArrived.countDown()
                check(releaseResponse.await(5, TimeUnit.SECONDS))
                return MockResponse().setBody("""{"result":{"name":"SOUL.md","body":"updated","revision":2}}""")
            }
        }
        oldNode.start(InetAddress.getByName("127.0.0.1"), 0)
        newNode.start(InetAddress.getByName("127.0.0.1"), 0)
        try {
            val oldUrl = oldNode.url("/").toString()
            val id = store.save(null, "old endpoint", oldUrl, true).getString("id")
            store.update(id, oldUrl) { it.put("authenticated", true) }
            val future = executor.submit<BoundNodeAgentResult> {
                NodeConnection(store).agentDocumentSave(id, "SOUL.md", "updated", 1)
            }
            assertTrue(requestArrived.await(3, TimeUnit.SECONDS))
            store.save(id, "new endpoint", newNode.url("/").toString(), true)
            releaseResponse.countDown()

            val result = future.get(5, TimeUnit.SECONDS)
            assertTrue(result.nodeChanged)
            assertEquals(id, result.nodeId)
            assertEquals(oldUrl, result.baseUrl)
            assertEquals("updated", (result.value as JSONObject).getString("body"))
            assertEquals(2, oldNode.requestCount)
            assertEquals(0, newNode.requestCount)
        } finally {
            releaseResponse.countDown()
            executor.shutdownNow()
            store.clearForTest()
            oldNode.shutdown(); newNode.shutdown()
        }
    }

    @Test fun delayedAgentReadIsRejectedWhenNodeAddressChanges() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "node-agent-read-race-${UUID.randomUUID()}"
        val store = NodeSettingsStore(context, namespace)
        val oldNode = MockWebServer(); val newNode = MockWebServer()
        val requestArrived = CountDownLatch(1)
        val releaseResponse = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        oldNode.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/auth/status") return MockResponse().setBody("{\"authenticated\":true}")
                requestArrived.countDown()
                check(releaseResponse.await(5, TimeUnit.SECONDS))
                return MockResponse().setBody("""{"result":{"identity":{},"soul":{},"memories":[]}}""")
            }
        }
        oldNode.start(InetAddress.getByName("127.0.0.1"), 0)
        newNode.start(InetAddress.getByName("127.0.0.1"), 0)
        try {
            val oldUrl = oldNode.url("/").toString()
            val id = store.save(null, "old endpoint", oldUrl, true).getString("id")
            store.update(id, oldUrl) { it.put("authenticated", true) }
            val future = executor.submit<String> {
                runCatching { NodeConnection(store).agentState(id) }
                    .exceptionOrNull()?.message ?: "unexpected success"
            }
            assertTrue(requestArrived.await(3, TimeUnit.SECONDS))
            store.save(id, "new endpoint", newNode.url("/").toString(), true)
            releaseResponse.countDown()

            assertEquals("NODE_CHANGED", future.get(5, TimeUnit.SECONDS))
            assertEquals(2, oldNode.requestCount)
            assertEquals(0, newNode.requestCount)
        } finally {
            releaseResponse.countDown()
            executor.shutdownNow()
            store.clearForTest()
            oldNode.shutdown(); newNode.shutdown()
        }
    }
}
