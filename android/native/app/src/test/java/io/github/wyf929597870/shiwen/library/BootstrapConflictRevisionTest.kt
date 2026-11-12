package io.github.wyf929597870.shiwen.library

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BootstrapConflictRevisionTest {
    private fun recover(op: String = "bootstrap", state: String = "open", integrity: String = "complete",
        old: Long? = null, revision: Long? = 7, version: String? = "server-version",
        sameRecord: Boolean = true, sameSnapshot: Boolean = true) =
        recoverableBootstrapRevision(op, state, integrity, old, revision, version, sameRecord, sameSnapshot)

    @Test fun exactCompletedLegacySnapshotGetsTheKnownRevision() {
        assertEquals(7L, recover())
        assertEquals(7L, recover(old = 0))
    }

    @Test fun unknownOrChangedHeadsNeverGetARevisionGuessed() {
        assertNull(recover(op = "push")); assertNull(recover(state = "resolved"))
        assertNull(recover(integrity = "incomplete")); assertNull(recover(old = 3))
        assertNull(recover(revision = null)); assertNull(recover(revision = 0))
        assertNull(recover(version = null)); assertNull(recover(version = "null"))
        assertNull(recover(sameRecord = false)); assertNull(recover(sameSnapshot = false))
    }
    @Test fun bridgeAcceptsIntegerLongAndExactDoubleButRejectsInvalidRevisions() {
        assertEquals(2L, parseRemoteRevision(2))
        assertEquals(2L, parseRemoteRevision(2L))
        assertEquals(2L, parseRemoteRevision(2.0))
        assertNull(parseRemoteRevision(null)); assertNull(parseRemoteRevision("2"))
        assertNull(parseRemoteRevision(0)); assertNull(parseRemoteRevision(-1))
        assertNull(parseRemoteRevision(1.5)); assertNull(parseRemoteRevision(Double.NaN))
        assertNull(parseRemoteRevision(9_007_199_254_740_992L))
    }
}
