package io.github.wyf929597870.shiwen.library

import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LibrarySyncGatesTest {
    @Test fun permitCanBeReleasedByWorkerAndReacquiredForNextSync() {
        val libraryId = "gate-${UUID.randomUUID()}"
        assertTrue(LibrarySyncGates.tryAcquire(libraryId))

        val executor = Executors.newSingleThreadExecutor()
        try {
            val released = executor.submit<Boolean> {
                LibrarySyncGates.release(libraryId)
                true
            }
            assertTrue(released.get(2, TimeUnit.SECONDS))
            assertTrue("a completed sync must allow the next sync", LibrarySyncGates.tryAcquire(libraryId))
            LibrarySyncGates.release(libraryId)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test fun concurrentAndRepeatedAcquiresAreSerializedPerLibrary() {
        val libraryId = "gate-${UUID.randomUUID()}"
        assertTrue(LibrarySyncGates.tryAcquire(libraryId))

        val executor = Executors.newFixedThreadPool(2)
        try {
            val competingAcquire = executor.submit<Boolean> { LibrarySyncGates.tryAcquire(libraryId) }
            assertFalse("overlapping sync must be rejected", competingAcquire.get(2, TimeUnit.SECONDS))

            LibrarySyncGates.release(libraryId)
            assertTrue("a later sync must acquire the released permit", LibrarySyncGates.tryAcquire(libraryId))
            val overlapping = executor.submit<Boolean> { LibrarySyncGates.tryAcquire(libraryId) }
            assertFalse(overlapping.get(2, TimeUnit.SECONDS))
            LibrarySyncGates.release(libraryId)
        } finally {
            executor.shutdownNow()
        }
    }
}
