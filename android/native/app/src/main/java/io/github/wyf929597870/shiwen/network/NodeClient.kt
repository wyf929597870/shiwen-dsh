package io.github.wyf929597870.shiwen.network

import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/** Native node transport. Cookies never enter WebView state.
 * Optional persistence callback stores sessions in a node-specific encrypted store. */
internal class NodeClient(baseUrl: String, allowPrivateHttp: Boolean = false,
    initialCookies: List<String> = emptyList(), fingerprint: String? = null, private val bearer: String? = null,
    timeoutSeconds: Long = 10, private val persistCookies: (List<String>) -> Unit = {}) {
    private val origin = baseUrl.toHttpUrl().also {
        require(it.encodedPath == "/" && it.query == null && it.fragment == null && it.username.isEmpty() && it.password.isEmpty())
        require(it.isHttps || allowPrivateHttp) { "HTTP_REQUIRES_EXPLICIT_CONSENT" }
    }
    @Volatile private var closed = false
    private val jar = OriginCookieJar(origin, initialCookies, persistCookies)
    private val client = OkHttpClient.Builder().cookieJar(jar)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(timeoutSeconds, TimeUnit.SECONDS).readTimeout(if (timeoutSeconds < 10) timeoutSeconds else 30, TimeUnit.SECONDS)
        .callTimeout(if (timeoutSeconds < 10) timeoutSeconds else 60, TimeUnit.SECONDS)
        .apply {
            if (!fingerprint.isNullOrEmpty()) {
                require(origin.isHttps) { "PIN_REQUIRES_TLS" }
                val trust = PinnedServiceTrust(fingerprint)
                sslSocketFactory(trust.socketFactory(), trust)
                // The QR-pinned public key is the service identity, independent of IP/DNS.
                hostnameVerifier { _, session ->
                    runCatching { trust.checkServerTrusted(session.peerCertificates.map { it as java.security.cert.X509Certificate }.toTypedArray(), "EC"); true }.getOrDefault(false)
                }
            }
        }
        .dns(object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = Dns.SYSTEM.lookup(hostname).also { addresses ->
                if (!origin.isHttps) require(addresses.isNotEmpty() && addresses.all(::privateAddress)) { "HTTP_PUBLIC_ADDRESS_DENIED" }
            }
        }).build()
    fun request(path: String, method: String = "GET", body: RequestBody? = null): Call {
        check(!closed) { "SESSION_CLOSED" }
        val url = requireNotNull(origin.resolve(path))
        require(sameOrigin(origin, url)) { "CROSS_ORIGIN_REQUEST_DENIED" }
        require(url.username.isEmpty() && url.password.isEmpty() && url.fragment == null)
        return client.newCall(Request.Builder().url(url).header("Origin", origin.toString().trimEnd('/')).apply { if (!bearer.isNullOrBlank()) header("Authorization", "Bearer $bearer") }.method(method, body).build())
    }
    fun revoke() { closed = true; jar.close(); client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
    companion object {
        private fun privateAddress(address: InetAddress): Boolean {
            val bytes = address.address
            return address.isLoopbackAddress || address.isSiteLocalAddress ||
                (bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc)
        }
    }
}
private fun sameOrigin(a: HttpUrl, b: HttpUrl) = a.scheme == b.scheme && a.host == b.host && a.port == b.port
internal class OriginCookieJar(private val origin: HttpUrl, initial: List<String> = emptyList(),
    private val persist: (List<String>) -> Unit = {}) : CookieJar {
    private val cookies = initial.mapNotNull { Cookie.parse(origin, it) }.filter { it.matches(origin) }.toMutableList()
    private var closed = false
    @Synchronized override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (closed) return
        require(sameOrigin(origin, url)) { "CROSS_ORIGIN_COOKIE_DENIED" }
        for (cookie in cookies) {
            this.cookies.removeAll { it.name == cookie.name && it.domain == cookie.domain && it.path == cookie.path }
            if (cookie.expiresAt > System.currentTimeMillis()) this.cookies.add(cookie)
        }
        persist(this.cookies.map { it.toString() })
    }
    @Synchronized override fun loadForRequest(url: HttpUrl): List<Cookie> {
        if (closed || !sameOrigin(origin, url)) return emptyList()
        cookies.removeAll { it.expiresAt <= System.currentTimeMillis() }
        return cookies.filter { it.matches(url) }.toList()
    }
    @Synchronized fun close() { closed = true; cookies.clear() }
}
