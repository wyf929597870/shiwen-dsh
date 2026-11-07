package io.github.wyf929597870.shiwen.library

import kotlinx.coroutines.CancellationException
import org.json.JSONObject

/** Pure per-library background-sync rules shared by WorkManager and JVM tests. */
internal object LibrarySyncWorkPolicy {
    enum class WifiGate { READY, SKIP_UNTIL_NEXT_PERIOD, INVALID_SETTINGS }
    data class BatchResult(val retry: Boolean, val stopped: Boolean)

    fun eligible(role: String, autoSync: Boolean, backgroundSync: Boolean): Boolean =
        role == "coordinated" && autoSync && backgroundSync

    fun shouldSchedule(rows: List<LibraryRegistryRow>): Boolean = rows.any {
        eligible(it.role, it.autoSync, it.backgroundSync)
    }

    fun wifiGate(wifiOnly: Boolean?, onWifi: Boolean): WifiGate = when {
        wifiOnly == null -> WifiGate.INVALID_SETTINGS
        wifiOnly && !onWifi -> WifiGate.SKIP_UNTIL_NEXT_PERIOD
        else -> WifiGate.READY
    }

    /** An omitted wifiOnly retains the historical default; malformed settings fail closed. */
    fun wifiOnlySetting(syncConditionsJson: String): Boolean? {
        return runCatching {
            val conditions = JSONObject(syncConditionsJson)
            if (!conditions.has("wifiOnly")) false else conditions.opt("wifiOnly") as? Boolean
        }.getOrNull()
    }

    fun wifiGate(syncConditionsJson: String, onWifi: Boolean): WifiGate =
        wifiGate(wifiOnlySetting(syncConditionsJson), onWifi)

    fun shouldRetry(terminalState: String?): Boolean = terminalState != "completed"

    /** One failed library marks the batch retryable but never prevents later libraries from running. */
    suspend fun <T> runEach(targets: List<T>, isStopped: () -> Boolean,
        process: suspend (T) -> Boolean?): BatchResult {
        var retry = false
        for (target in targets) {
            if (isStopped()) return BatchResult(retry = true, stopped = true)
            try {
                if (process(target) == false) retry = true
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                retry = true
            }
        }
        return BatchResult(retry, stopped = false)
    }
}
