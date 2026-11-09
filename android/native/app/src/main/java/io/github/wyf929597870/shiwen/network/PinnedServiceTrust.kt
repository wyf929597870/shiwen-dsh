package io.github.wyf929597870.shiwen.network

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/** Trust is scoped to one paired service key. It never alters platform-wide TLS. */
internal class PinnedServiceTrust(fingerprint: String) : X509TrustManager {
    private val expected: ByteArray = fingerprint.also {
        require(it.matches(Regex("[0-9a-f]{64}"))) { "INVALID_SERVICE_FINGERPRINT" }
    }.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        if (chain.isNullOrEmpty() || authType.isNullOrBlank()) throw CertificateException("SERVICE_IDENTITY_MISSING")
        val leaf = chain[0]
        leaf.checkValidity()
        val actual = MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded)
        if (!MessageDigest.isEqual(expected, actual)) throw CertificateException("SERVICE_IDENTITY_MISMATCH")
    }
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("CLIENT_CERTIFICATES_NOT_SUPPORTED")
    }
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    fun socketFactory(): SSLSocketFactory = SSLContext.getInstance("TLS").apply {
        init(null, arrayOf(this@PinnedServiceTrust), null)
    }.socketFactory
}
