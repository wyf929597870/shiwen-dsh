package io.github.wyf929597870.shiwen.library

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class LibrarySyncWorkPolicyTest {
    @Test fun periodicWorkIsScheduledOnlyWhenAtLeastOneLibraryOptsIntoBackgroundSync() {
        assertFalse(LibrarySyncWorkPolicy.shouldSchedule(listOf(row("standalone", true, true), row("coordinated", true, false))))
        assertTrue(LibrarySyncWorkPolicy.shouldSchedule(listOf(row("coordinated", true, true))))
    }

    @Test fun wifiOnlyDefersCellularAndMalformedSettingsFailClosed() {
        assertEquals(LibrarySyncWorkPolicy.WifiGate.SKIP_UNTIL_NEXT_PERIOD,
            LibrarySyncWorkPolicy.wifiGate(true, onWifi = false))
        assertEquals(LibrarySyncWorkPolicy.WifiGate.READY,
            LibrarySyncWorkPolicy.wifiGate(true, onWifi = true))
        assertEquals(LibrarySyncWorkPolicy.WifiGate.INVALID_SETTINGS,
            LibrarySyncWorkPolicy.wifiGate(null, onWifi = false))
    }

    @Test fun wifiPolicyFailsClosedForUnknownParsedValues() {
        assertEquals(LibrarySyncWorkPolicy.WifiGate.SKIP_UNTIL_NEXT_PERIOD,
            LibrarySyncWorkPolicy.wifiGate(true, onWifi = false))
        assertEquals(LibrarySyncWorkPolicy.WifiGate.INVALID_SETTINGS,
            LibrarySyncWorkPolicy.wifiGate(null, onWifi = false))
    }

    @Test fun aFailedLibraryDoesNotPreventLaterLibrariesAndRequestsBatchRetry() = runBlocking {
        val attempted = mutableListOf<String>()
        val result = LibrarySyncWorkPolicy.runEach(listOf("broken", "healthy", "other"), { false }) { id ->
            attempted += id
            when (id) {
                "broken" -> error("synthetic sync failure")
                "healthy" -> true
                else -> false
            }
        }
        assertEquals(listOf("broken", "healthy", "other"), attempted)
        assertTrue(result.retry)
        assertFalse(result.stopped)
    }

    @Test fun successfulAndWifiDeferredLibrariesDoNotScheduleRetry() = runBlocking {
        val result = LibrarySyncWorkPolicy.runEach(listOf(1, 2), { false }) { value ->
            if (value == 1) true else null
        }
        assertFalse(result.retry)
        assertFalse(LibrarySyncWorkPolicy.shouldRetry("completed"))
        assertTrue(LibrarySyncWorkPolicy.shouldRetry("failed"))
        assertTrue(LibrarySyncWorkPolicy.shouldRetry(null))
    }

    @Test fun stoppedBatchReportsRetryAndDoesNotStartLaterLibraries() = runBlocking {
        val attempted = mutableListOf<Int>()
        var checks = 0
        val result = LibrarySyncWorkPolicy.runEach(listOf(1, 2), { ++checks > 1 }) { value ->
            attempted += value
            true
        }
        assertEquals(listOf(1), attempted)
        assertTrue(result.retry)
        assertTrue(result.stopped)
    }

    private fun row(role: String, auto: Boolean, background: Boolean) = LibraryRegistryRow(
        libraryId = "$role-$auto-$background", name = "fixture", deviceId = "device", dbFile = "fixture.db",
        role = role, integrity = "complete", serverId = null, epoch = null, protocolVersion = 1,
        lastSyncedAt = null, appliedCursor = null, completeCursor = null, cursor = null, manifestDigest = null,
        pageGeneration = 1, migrationP0Done = true, autoSync = auto, backgroundSync = background,
        syncConditionsJson = "{}"
    )
}
