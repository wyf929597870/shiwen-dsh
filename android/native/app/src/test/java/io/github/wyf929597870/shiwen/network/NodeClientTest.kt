package io.github.wyf929597870.shiwen.network

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress

class NodeClientTest {
    @Test fun rememberedCookieAndOriginAreBoundToOneNode() {
        val server = MockWebServer(); server.start(InetAddress.getByName("127.0.0.1"), 0)
        var persisted = emptyList<String>()
        val client = NodeClient(server.url("/").toString(), true, listOf("session=remembered; Path=/; HttpOnly")) { persisted = it }
        try {
            server.enqueue(MockResponse().addHeader("Set-Cookie", "session=renewed; Path=/; HttpOnly"))
            client.request("/auth/status").execute().close()
            val request = server.takeRequest()
            assertEquals("session=remembered", request.getHeader("Cookie"))
            assertEquals(server.url("/").toString().trimEnd('/'), request.getHeader("Origin"))
            assertTrue(persisted.single().startsWith("session=renewed"))
        } finally { client.revoke(); server.shutdown() }
    }
    @Test fun sameHostDifferentPortsDoNotShareCookiesAndRedirectsAreNotFollowed() {
        val a = MockWebServer(); val b = MockWebServer()
        a.start(InetAddress.getByName("127.0.0.1"), 0); b.start(InetAddress.getByName("127.0.0.1"), 0)
        val first = NodeClient(a.url("/").toString(), true)
        val second = NodeClient(b.url("/").toString(), true)
        try {
            a.enqueue(MockResponse().addHeader("Set-Cookie", "session=test-a; Path=/; HttpOnly"))
            first.request("/auth/login").execute().close(); a.takeRequest()
            b.enqueue(MockResponse().addHeader("Set-Cookie", "session=test-b; Path=/; HttpOnly"))
            second.request("/auth/login").execute().close()
            assertNull(b.takeRequest().getHeader("Cookie"))
            a.enqueue(MockResponse()); first.request("/identity").execute().close()
            assertEquals("session=test-a", a.takeRequest().getHeader("Cookie"))
            b.enqueue(MockResponse()); second.request("/identity").execute().close()
            assertEquals("session=test-b", b.takeRequest().getHeader("Cookie"))
            a.enqueue(MockResponse().setResponseCode(302).addHeader("Location", b.url("/identity")))
            first.request("/redirect").execute().use { assertEquals(302, it.code) }
            assertEquals(2, b.requestCount)
            assertTrue(runCatching { first.request(b.url("/identity").toString()) }.isFailure)
            first.revoke()
            assertTrue(runCatching {first.request("/identity")}.isFailure)
            val fresh = NodeClient(a.url("/").toString(), true)
            try {
                a.enqueue(MockResponse()); fresh.request("/identity").execute().close()
                a.takeRequest() // /redirect
                assertNull(a.takeRequest().getHeader("Cookie"))
            } finally { fresh.revoke() }
        } finally {first.revoke(); second.revoke(); a.shutdown(); b.shutdown()}
    }
    @Test fun httpRequiresConsentAndCredentialsCannotBeEmbeddedInAnAddress() {
        assertTrue(runCatching {NodeClient("http://127.0.0.1:3081/")}.isFailure)
        assertTrue(runCatching {NodeClient("https://user:password@example.invalid/")}.isFailure)
        assertTrue(runCatching {NodeClient("https://example.invalid/?token=test")}.isFailure)
        val a = NodeClient("https://example.invalid/")
        assertTrue(runCatching {a.request("https://elsewhere.invalid/")}.isFailure)
        a.revoke()
    }
}
