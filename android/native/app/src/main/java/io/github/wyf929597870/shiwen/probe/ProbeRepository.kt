package io.github.wyf929597870.shiwen.probe

import android.content.Context
import androidx.room.Room
import io.github.wyf929597870.shiwen.model.Canonical
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import io.github.wyf929597870.shiwen.library.AgentLibraryAccess
import io.github.wyf929597870.shiwen.library.AgentLibraryRecord
import io.github.wyf929597870.shiwen.library.AgentLibraryReceipt

class ProbeRepository internal constructor(context: Context, private val namespace: String = "shiwen-p0",
    private val beforeReceipt: () -> Unit = {}) : AgentLibraryAccess {
    val executor = Executors.newSingleThreadExecutor()
    private val preferences = context.getSharedPreferences("$namespace-installation", Context.MODE_PRIVATE)
    private fun identity(key: String): String = preferences.getString(key, null) ?: UUID.randomUUID().toString().also {
        check(preferences.edit().putString(key, it).commit()) { "STORAGE_FULL" }
    }
    override val libraryId = identity("libraryId")
    val deviceId = identity("deviceId")
    val db = Room.databaseBuilder(context, ProbeDatabase::class.java, "$namespace-$libraryId.sqlite").build()
    fun save(draft: ProbeDraft): ProbeRecord {
        UUID.fromString(draft.requestId)
        require(draft.markdown.isNotBlank() && draft.markdown.length <= 1_000_000)
        require(draft.title.length <= 200 && draft.generation >= 0)
        require(draft.kind in listOf("journal", "freewrite", "reading_note", "idea", "web", "ai", "reference"))
        val hash = Canonical.hash(mapOf("title" to draft.title, "markdown" to draft.markdown,
            "kind" to draft.kind, "generation" to draft.generation))
        return db.runInTransaction(Callable {
            val dao = db.dao()
            dao.receipt(draft.requestId)?.let {
                check(it.fingerprint == hash) { "OPERATION_REUSED" }
                dao.clearDraft(draft.requestId, draft.generation)
                return@Callable checkNotNull(dao.record(it.recordId))
            }
            val at = Instant.now().toString()
            val record = ProbeRecord(UUID.randomUUID().toString(), draft.title.ifBlank { draft.markdown.take(32) },
                draft.markdown, draft.kind, at, UUID.randomUUID().toString(), UUID.randomUUID().toString(), deviceId)
            val sources = listOf(mapOf("text" to draft.markdown, "origin" to "personal"))
            dao.insertRecord(record)
            dao.insertActivity(ProbeActivity(UUID.randomUUID().toString(), record.id, deviceId, at,
                Canonical.hash(mapOf("markdown" to draft.markdown, "segments" to sources))))
            beforeReceipt()
            dao.insertReceipt(ProbeReceipt(draft.requestId, hash, record.id))
            dao.clearDraft(draft.requestId, draft.generation)
            record
        })
    }
    override fun searchForAgent(query: String, limit: Int): List<AgentLibraryRecord> = db.dao().search(query).take(limit).map {
        AgentLibraryRecord(it.id, it.title, it.markdown, it.kind, it.createdAt, "personal", null)
    }
    override fun readForAgent(id: String): AgentLibraryRecord? = db.dao().record(id)?.let {
        AgentLibraryRecord(it.id, it.title, it.markdown, it.kind, it.createdAt, "personal", null)
    }
    override fun saveApprovedDraft(draft: ProbeDraft): AgentLibraryRecord = save(draft).let {
        AgentLibraryRecord(it.id, it.title, it.markdown, it.kind, it.createdAt, "personal", null)
    }
    override fun receiptForAgent(requestId: String): AgentLibraryReceipt? = db.dao().receipt(requestId)?.let {
        AgentLibraryReceipt(it.requestId, it.recordId)
    }
    companion object {
        @Volatile private var instance: ProbeRepository? = null
        fun get(context: Context): ProbeRepository = instance ?: synchronized(this) {
            instance ?: ProbeRepository(context.applicationContext).also { instance = it }
        }
    }
}
