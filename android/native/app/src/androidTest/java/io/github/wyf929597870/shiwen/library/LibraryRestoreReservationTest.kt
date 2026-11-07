package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.wyf929597870.shiwen.model.Canonical
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LibraryRestoreReservationTest {
    private class SimulatedProcessDeath : Error("simulated restore process death")

    @Test fun reservationRecoveryIsIdempotentAcrossEachCommitBoundary() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "restore-reservation-${UUID.randomUUID()}"
        val legacy = "$namespace-legacy"
        var failurePoint: String? = null
        var shouldFail = true
        var failWithOrdinaryException = false
        fun newManager() = LibraryManager(context, namespace, legacy) { point ->
            if (point == failurePoint && shouldFail) {
                shouldFail = false
                if (failWithOrdinaryException) throw IllegalStateException("simulated restore failure")
                throw SimulatedProcessDeath()
            }
        }
        var manager = newManager()
        try {
            val source = manager.create("Source archive")
            val body = "原始材料正文"
            source.create(UUID.randomUUID().toString(), JSONObject()
                .put("kind", "journal").put("title", "测试日记").put("markdown", body)
                .put("origin", "personal").put("processing", "original")
                .put("sources", JSONArray().put(JSONObject().put("text", body).put("origin", "personal"))), 1)
            val snapshot = source.archiveSnapshot()
            val requestId = UUID.randomUUID().toString()
            val fingerprint = Canonical.hash(mapOf("test" to requestId, "archive" to snapshot.toString()))

            // A crash after the reservation leaves no visible library. On restart the
            // request-owned empty DB is cleaned and the same request can safely retry.
            failurePoint = "after-reservation"
            assertProcessDeath { manager.restoreArchive(snapshot, emptyMap(), "Recovered copy", requestId,
                fingerprint, asNewLibrary = true) }
            manager.close()
            manager = newManager()
            assertTrue(manager.all().none { it.libraryId != source.libraryId })
            val first = manager.restoreArchive(snapshot, emptyMap(), "Recovered copy", requestId,
                fingerprint, asNewLibrary = true)
            assertNotEquals(source.libraryId, first.libraryId)
            assertEquals(1, first.dao.recordCount())
            assertEquals(source.libraryId, first.dao.meta("imported-from-library-id"))
            assertSameLibraryOnReplay(manager, snapshot, requestId, fingerprint, first.libraryId)

            // A process death after the target DB transaction but before registry commit
            // is recovered from the DB's atomic completion marker.
            val secondRequest = UUID.randomUUID().toString()
            val secondFingerprint = Canonical.hash(mapOf("test" to secondRequest, "archive" to snapshot.toString()))
            failurePoint = "after-data-commit"
            shouldFail = true
            assertProcessDeath { manager.restoreArchive(snapshot, emptyMap(), "Second copy", secondRequest,
                secondFingerprint, asNewLibrary = true) }
            manager.close()
            manager = newManager()
            val recovered = manager.restoreArchive(snapshot, emptyMap(), "Second copy", secondRequest,
                secondFingerprint, asNewLibrary = true)
            assertEquals(1, recovered.dao.recordCount())
            assertSameLibraryOnReplay(manager, snapshot, secondRequest, secondFingerprint, recovered.libraryId)

            // A lost acknowledgement after both durable writes returns the same target;
            // it never imports a second copy.
            val thirdRequest = UUID.randomUUID().toString()
            val thirdFingerprint = Canonical.hash(mapOf("test" to thirdRequest, "archive" to snapshot.toString()))
            failurePoint = "after-registry-commit"
            shouldFail = true
            assertProcessDeath { manager.restoreArchive(snapshot, emptyMap(), "Third copy", thirdRequest,
                thirdFingerprint, asNewLibrary = true) }
            manager.close()
            manager = newManager()
            val third = manager.restoreArchive(snapshot, emptyMap(), "Third copy", thirdRequest,
                thirdFingerprint, asNewLibrary = true)
            assertEquals(1, third.dao.recordCount())
            assertSameLibraryOnReplay(manager, snapshot, thirdRequest, thirdFingerprint, third.libraryId)
            assertNotEquals(first.libraryId, recovered.libraryId)
            assertNotEquals(recovered.libraryId, third.libraryId)
            assertEquals(4, manager.all().size) // source plus exactly three completed restores

            // A normal exception after the data transaction is different from an
            // uncommitted restore: keep the marker/DB, then finish registration on retry.
            val fourthRequest = UUID.randomUUID().toString()
            val fourthFingerprint = Canonical.hash(mapOf("test" to fourthRequest, "archive" to snapshot.toString()))
            failurePoint = "after-data-commit"
            shouldFail = true
            failWithOrdinaryException = true
            val failure = runCatching {
                manager.restoreArchive(snapshot, emptyMap(), "Fourth copy", fourthRequest,
                    fourthFingerprint, asNewLibrary = true)
            }.exceptionOrNull()
            assertEquals("simulated restore failure", failure?.message)
            failWithOrdinaryException = false
            val fourth = manager.restoreArchive(snapshot, emptyMap(), "Fourth copy", fourthRequest,
                fourthFingerprint, asNewLibrary = true)
            assertEquals(1, fourth.dao.recordCount())
            assertSameLibraryOnReplay(manager, snapshot, fourthRequest, fourthFingerprint, fourth.libraryId)
            assertEquals(5, manager.all().size)

            val rejected = runCatching {
                manager.restoreArchive(snapshot, emptyMap(), "Third copy", thirdRequest,
                    Canonical.hash(mapOf("different" to "archive")), asNewLibrary = true)
            }.exceptionOrNull()
            assertEquals("REQUEST_REUSED", rejected?.message)
            assertEquals(5, manager.all().size)
        } finally {
            runCatching { manager.closeForTest() }
        }
    }

    private fun assertProcessDeath(block: () -> Unit) {
        val error = runCatching(block).exceptionOrNull()
        assertTrue("expected simulated process death, got $error", error is SimulatedProcessDeath)
    }

    private fun assertSameLibraryOnReplay(manager: LibraryManager, snapshot: JSONObject,
        requestId: String, fingerprint: String, expectedId: String) {
        val replay = manager.restoreArchive(snapshot, emptyMap(), "${manager.row(expectedId).name}", requestId,
            fingerprint, asNewLibrary = true)
        assertEquals(expectedId, replay.libraryId)
        assertEquals(1, replay.dao.recordCount())
    }
}
