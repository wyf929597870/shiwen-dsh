package io.github.wyf929597870.shiwen.network

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.TimeUnit

private val handshakes=Collections.synchronizedMap(WeakHashMap<MockWebServer,Int>())

// Perform the same authenticated reachability probe as the real node before measuring application RPCs.
internal fun MockWebServer.verifyFixtureConnection(store:NodeSettingsStore,id:String){
    enqueue(MockResponse().setBody("""{"authenticated":true}"""))
    check(NodeReachability.resolve(store,id,true).getBoolean("authenticated"))
    check(takeRequest(2,TimeUnit.SECONDS)?.path=="/auth/status")
    handshakes[this]=(handshakes[this]?:0)+1
}
internal val MockWebServer.afterHandshakeRequestCount:Int get()=requestCount-(handshakes[this]?:0)
