package io.github.wyf929597870.shiwen.network
import org.junit.Assert.*
import org.junit.Test
class NodeRoutePolicyTest {
    @Test fun keepsCurrentAndRotatesFailedAddressesWithoutStarvingDiscovery() {
        val first = NodeRoutePolicy.candidates("current", listOf("old1", "old2", "old1"), listOf("new", "current"), 0)
        assertEquals(listOf("current", "new", "old1", "old2"), first)
        assertEquals(listOf("current", "old2", "new", "old1"), NodeRoutePolicy.candidates("current", listOf("old1", "old2"), listOf("new"), 2))
        assertEquals(16, NodeRoutePolicy.candidates("current", (1..100).map { "ip$it" }, emptyList(), 0).size)
    }
    @Test fun offlineNeedsTwoRoundsAndIsDistinctFromIdentityAndApiErrors() {
        assertEquals("checking", NodeRoutePolicy.failedState(1, false, false))
        assertEquals("offline", NodeRoutePolicy.failedState(2, false, false))
        assertEquals("identity-mismatch", NodeRoutePolicy.failedState(4, true, false))
        assertEquals("service-error", NodeRoutePolicy.failedState(4, true, true))
    }
}
