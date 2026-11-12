package io.github.wyf929597870.shiwen.library

internal fun isActionableRejection(state: String, error: String?): Boolean =
    state == "rejected" && error != "CONFLICT_DISCARDED"
