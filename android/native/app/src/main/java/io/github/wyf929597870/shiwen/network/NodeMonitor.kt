package io.github.wyf929597870.shiwen.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Foreground-only health and NSD. Never starts synchronization or writes library data. */
internal class NodeMonitor(context: Context, private val store: NodeSettingsStore) {
    private val context = context.applicationContext
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val nsd = context.getSystemService(NsdManager::class.java)
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val epoch = AtomicLong()
    private val round = AtomicLong()
    private val discoveryExecutor = Executors.newSingleThreadExecutor()
    private val pending = java.util.concurrent.atomic.AtomicInteger()
    private var active = false
    private var discovery: NsdManager.DiscoveryListener? = null
    private var multicast: WifiManager.MulticastLock? = null
    private var task: java.util.concurrent.ScheduledFuture<*>? = null
    private var backoff = 15L
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = changed()
        override fun onLost(network: Network) = changed()
    }
    @Synchronized private fun changed() {
        if (!active) return
        NodeReachability.hasNetwork = connectivity.activeNetwork != null
        NodeReachability.clearHints(); task?.cancel(false); backoff = 15
        schedule(0, round.incrementAndGet())
    }
    @Synchronized fun start() {
        if (active) return
        active = true; val ticket = epoch.incrementAndGet()
        NodeReachability.hasNetwork = connectivity.activeNetwork != null
        runCatching { connectivity.registerDefaultNetworkCallback(callback) }
        val resolving = java.util.concurrent.atomic.AtomicBoolean()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, code: Int) { runCatching { nsd.stopServiceDiscovery(this) } }
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
            override fun onServiceLost(info: NsdServiceInfo) {} // hints expire; loss is not proof of offline
            override fun onServiceFound(info: NsdServiceInfo) {
                if (epoch.get() != ticket || !info.serviceType.contains("_shiwen._tcp")) return
                // NSD permits one resolve on older Android. Queue onto the monitor worker.
                if (pending.incrementAndGet() > 16) { pending.decrementAndGet(); return }
                discoveryExecutor.execute {
                    if (epoch.get() != ticket || !resolving.compareAndSet(false, true)) { pending.decrementAndGet(); return@execute }
                    val completed = java.util.concurrent.CountDownLatch(1)
                    try {
                        @Suppress("DEPRECATION")
                        nsd.resolveService(info, object : NsdManager.ResolveListener {
                            override fun onResolveFailed(service: NsdServiceInfo, code: Int) { completed.countDown() }
                            override fun onServiceResolved(service: NsdServiceInfo) {
                                try {
                                    if (epoch.get() != ticket) return
                                    val fp = service.attributes["fp"]?.toString(Charsets.UTF_8) ?: return
                                    @Suppress("DEPRECATION") val host = service.host?.hostAddress ?: return
                                    if (host.contains(':') || service.host?.isSiteLocalAddress != true || service.port !in 1..65535) return
                                    NodeReachability.discovered(fp, "https://$host:${service.port}/")
                                } finally { completed.countDown() }
                            }
                        })
                        completed.await(5, TimeUnit.SECONDS)
                    } finally { resolving.set(false); pending.decrementAndGet() }
                }
            }
        }
        discovery = listener
        runCatching {
            multicast = context.getSystemService(WifiManager::class.java).createMulticastLock("shiwen-discovery").apply { setReferenceCounted(false); acquire() }
            nsd.discoverServices("_shiwen._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
        }
        schedule(0, round.incrementAndGet())
    }
    @Synchronized private fun schedule(delay: Long, ticket: Long) {
        if (!active || round.get() != ticket) return
        task = executor.schedule({
            var reachable = false
            runCatching {
                val nodes = store.list().getJSONArray("items")
                for (i in 0 until nodes.length()) {
                    if (round.get() != ticket || !active) break
                    runCatching { NodeReachability.resolve(store, nodes.getJSONObject(i).getString("id"), true) { round.get() != ticket || !active } }
                        .getOrNull()?.let { if (it.optString("connectionState") in setOf("online", "login-required")) reachable = true }
                }
            }
            synchronized(this) {
                if (reachable) backoff = 15 else backoff = (backoff * 2).coerceAtMost(120)
                schedule(if (reachable) 30 else backoff, ticket)
            }
        }, delay, TimeUnit.SECONDS)
    }
    @Synchronized fun stop() {
        if (!active) return
        active = false; epoch.incrementAndGet(); round.incrementAndGet(); task?.cancel(true)
        runCatching { connectivity.unregisterNetworkCallback(callback) }
        discovery?.let { runCatching { nsd.stopServiceDiscovery(it) } }; discovery = null
        runCatching { multicast?.release() }; multicast = null
        NodeReachability.clearHints()
    }
    fun close() { stop(); executor.shutdownNow(); discoveryExecutor.shutdownNow() }
}
