package io.github.wyf929597870.shiwen.library

import org.junit.Assert.*
import org.junit.Test

class SyncRejectionTest {
    @Test fun onlyExplicitlyDiscardedConflictIsExcluded() {
        assertFalse(isActionableRejection("rejected", "CONFLICT_DISCARDED"))
        assertTrue(isActionableRejection("rejected", "VALIDATION_ERROR"))
        assertTrue(isActionableRejection("rejected", null))
        assertFalse(isActionableRejection("pending", "VALIDATION_ERROR"))
    }
}
