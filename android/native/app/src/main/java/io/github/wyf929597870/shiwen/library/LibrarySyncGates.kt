package io.github.wyf929597870.shiwen.library

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore

/** A per-library gate whose permit may be released by a different executor thread. */
internal object LibrarySyncGates {
    private val gates = ConcurrentHashMap<String, Semaphore>()

    fun tryAcquire(libraryId: String): Boolean =
        gates.computeIfAbsent(libraryId) { Semaphore(1, true) }.tryAcquire()

    fun release(libraryId: String) {
        val gate = gates[libraryId] ?: error("SYNC_GATE_NOT_FOUND")
        check(gate.availablePermits() == 0) { "SYNC_GATE_NOT_HELD" }
        gate.release()
    }
}
