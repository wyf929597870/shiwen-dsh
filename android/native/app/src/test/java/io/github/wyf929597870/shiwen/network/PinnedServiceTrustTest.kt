package io.github.wyf929597870.shiwen.network

import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

class PinnedServiceTrustTest {
    private fun fingerprint(cert: HeldCertificate) = MessageDigest.getInstance("SHA-256")
        .digest(cert.certificate.publicKey.encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
    @Test fun trustIsBoundToThePairedPublicKey() {
        val paired = HeldCertificate.Builder().build()
        val other = HeldCertificate.Builder().build()
        val trust = PinnedServiceTrust(fingerprint(paired))
        trust.checkServerTrusted(arrayOf(paired.certificate), "EC")
        assertTrue(runCatching { trust.checkServerTrusted(arrayOf(other.certificate), "EC") }.isFailure)
        assertTrue(runCatching { trust.checkServerTrusted(emptyArray(), "EC") }.isFailure)
        assertTrue(runCatching { trust.checkClientTrusted(arrayOf(paired.certificate), "EC") }.isFailure)
        assertTrue(runCatching { PinnedServiceTrust("bad") }.isFailure)
    }
}
