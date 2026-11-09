package io.github.wyf929597870.shiwen.network

/** Pure route ordering: a working endpoint stays first; failed alternatives rotate
 * across bounded rounds so unreachable saved IPs cannot starve new discoveries. */
internal object NodeRoutePolicy {
    fun candidates(current: String, saved: List<String>, discovered: List<String>, offset: Int): List<String> {
        val alternatives = (discovered + saved).filterNot { it == current }.distinct().take(15)
        if (alternatives.isEmpty()) return listOf(current)
        val at = Math.floorMod(offset, alternatives.size)
        return listOf(current) + alternatives.drop(at) + alternatives.take(at)
    }
    fun failedState(failures: Int, identityMismatch: Boolean, serviceResponded: Boolean): String = when {
        serviceResponded -> "service-error"
        identityMismatch -> "identity-mismatch"
        failures >= 2 -> "offline"
        else -> "checking"
    }
}
