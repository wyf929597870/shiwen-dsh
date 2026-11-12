package io.github.wyf929597870.shiwen.library

/** Only adopt a server revision for an exact, fully initialized legacy snapshot. */
internal fun recoverableBootstrapRevision(
    operationId: String, state: String, integrity: String, oldRevision: Long?,
    headRevision: Long?, headVersionId: String?, sameRecord: Boolean, sameSnapshot: Boolean
): Long? {
    if (operationId != "bootstrap" || state != "open" || integrity != "complete" || (oldRevision ?: 0L) > 0L) return null
    if (headRevision == null || headRevision <= 0 || headVersionId.isNullOrBlank() || headVersionId == "null") return null
    return headRevision.takeIf { sameRecord && sameSnapshot }
}

/** Capacitor may decode small JSON integers as Int rather than Long. */
internal fun parseRemoteRevision(value: Any?): Long? {
    val number = value as? Number ?: return null
    val exact = number.toDouble()
    if (!exact.isFinite() || exact < 1.0 || exact > 9_007_199_254_740_991.0) return null
    val revision = number.toLong()
    return revision.takeIf { exact == it.toDouble() }
}

/** A revision alone does not establish identity if the stored snapshot lacks a version ID. */
internal fun sameConflictSnapshot(left: org.json.JSONObject, right: org.json.JSONObject): Boolean = runCatching {
    val a = org.json.JSONObject(left.toString())
    val b = org.json.JSONObject(right.toString())
    for (key in listOf("versionId", "changeId", "currentVersion")) { a.remove(key); b.remove(key) }
    canonicalJsonArrayEquals(org.json.JSONArray().put(a).toString(), org.json.JSONArray().put(b).toString())
}.getOrDefault(false)
