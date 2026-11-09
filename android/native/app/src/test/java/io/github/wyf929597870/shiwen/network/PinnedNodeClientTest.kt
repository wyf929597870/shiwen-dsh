package io.github.wyf929597870.shiwen.network

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class PinnedNodeClientTest {
    private fun fingerprint(cert: HeldCertificate) = MessageDigest.getInstance("SHA-256")
        .digest(cert.certificate.publicKey.encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun server(cert: HeldCertificate) = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        start()
    }
    @Test fun correctPinCarriesCredentialAndWrongPinSendsNoRequest() {
        val known = HeldCertificate.Builder().commonName("stable-service-key").build()
        val unknown = HeldCertificate.Builder().commonName("reassigned-ip").build()
        server(known).use { good ->
            good.enqueue(MockResponse().setBody("{}"))
            val client = NodeClient(good.url("/").toString(), fingerprint = fingerprint(known), bearer = "test-device-credential")
            try {
                client.request("/auth/status").execute().use { assertEquals(200, it.code) }
                assertEquals("Bearer test-device-credential", good.takeRequest().getHeader("Authorization"))
            } finally { client.revoke() }
        }
        server(unknown).use { wrong ->
            wrong.enqueue(MockResponse().setBody("{}"))
            val client = NodeClient(wrong.url("/").toString(), fingerprint = fingerprint(known), bearer = "must-not-leak", timeoutSeconds = 2)
            try {
                assertTrue(runCatching { client.request("/api/shiwen").execute().close() }.isFailure)
                assertNull(wrong.takeRequest(100, TimeUnit.MILLISECONDS))
            } finally { client.revoke() }
        }
    }
    @Test fun redirectCannotMoveCredentialToAnotherEndpoint() {
        val cert = HeldCertificate.Builder().build()
        server(cert).use { source -> server(cert).use { target ->
            source.enqueue(MockResponse().setResponseCode(307).addHeader("Location", target.url("/api/shiwen")))
            val client = NodeClient(source.url("/").toString(), fingerprint = fingerprint(cert), bearer = "scoped-device-token")
            try {
                client.request("/auth/status").execute().use { assertEquals(307, it.code) }
                assertNull(target.takeRequest(100, TimeUnit.MILLISECONDS))
            } finally { client.revoke() }
        } }
    }
}
