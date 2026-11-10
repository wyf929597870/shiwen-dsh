package io.github.wyf929597870.shiwen.library

import io.github.wyf929597870.shiwen.probe.ProbeDraft

data class AgentLibraryRecord(val id: String, val title: String, val markdown: String, val kind: String,
    val createdAt: String, val origin: String, val contentDay: String?,
    val revision: Long? = null, val annotation: String? = null)
data class AgentLibraryReceipt(val requestId: String, val recordId: String)

/** Narrow repository port for local agent reads and user-approved writes. */
interface AgentLibraryAccess {
    val libraryId: String
    fun searchForAgent(query: String, limit: Int = 20): List<AgentLibraryRecord>
    fun readForAgent(id: String): AgentLibraryRecord?
    fun saveApprovedDraft(draft: ProbeDraft): AgentLibraryRecord
    fun receiptForAgent(requestId: String): AgentLibraryReceipt?
}
