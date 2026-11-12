package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID

@Entity(tableName = "record_editor_drafts", primaryKeys = ["libraryId", "slot"])
internal data class RecordEditorDraftRow(
    val libraryId: String,
    val slot: String,
    val requestId: String?,
    val localGeneration: Long,
    val contentJson: String,
    val pendingMutationJson: String?,
    val updatedAt: Long
)

@Dao
internal interface RecordEditorDraftDao {
    @Query("SELECT * FROM record_editor_drafts WHERE libraryId=:libraryId")
    fun all(libraryId: String): List<RecordEditorDraftRow>
    @Query("DELETE FROM record_editor_drafts WHERE libraryId=:libraryId") fun deleteLibrary(libraryId: String)
    @Query("SELECT * FROM record_editor_drafts WHERE libraryId=:libraryId AND slot=:slot")
    fun get(libraryId: String, slot: String): RecordEditorDraftRow?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun put(row: RecordEditorDraftRow)
}

@Database(entities = [RecordEditorDraftRow::class], version = 1, exportSchema = true)
internal abstract class RecordEditorDraftDatabase : RoomDatabase() {
    abstract fun dao(): RecordEditorDraftDao
}

/** Durable per-library editor state and immutable write intent for safe process-death recovery. */
internal class RecordEditorDraftStore(context: Context, namespace: String = "shiwen-record-editor-drafts") {
    private val app = context.applicationContext
    private val databaseName = "$namespace.sqlite"
    private val db = Room.databaseBuilder(app, RecordEditorDraftDatabase::class.java, databaseName)
        .openHelperFactory(LargeRowOpenHelperFactory()).build()

    fun archive(libraryId: String): JSONArray = JSONArray(db.dao().all(libraryId)
        .filter { it.slot in setOf("composer", "materials", "articles") || it.slot.startsWith("annotation:") }.map { row ->
            JSONObject().put("slot", row.slot).put("requestId", row.requestId ?: JSONObject.NULL)
                .put("localGeneration", row.localGeneration).put("content", JSONObject(row.contentJson))
                .put("pendingMutation", row.pendingMutationJson?.let(::JSONObject) ?: JSONObject.NULL).put("updatedAt", row.updatedAt)
        })

    fun pendingAnnotationSlots(libraryId: String): JSONArray = JSONArray(db.dao().all(libraryId)
        .filter { it.requestId != null && it.slot.startsWith("annotation:") }
        .map { it.slot.removePrefix("annotation:") })

    fun restoreArchive(libraryId: String, rows: JSONArray, digest: String) = db.runInTransaction {
        val marker = db.dao().get(libraryId, "archive-restore-marker")
        if (marker?.contentJson == digest) return@runInTransaction
        check(db.dao().all(libraryId).isEmpty()) { "DRAFT_RESTORE_TARGET_NOT_EMPTY" }
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i); val slot = row.getString("slot")
            validateScope(libraryId, slot)
            val requestId = row.optString("requestId").takeUnless { it.isBlank() || it == "null" }
            val content = row.getJSONObject("content"); val pending = row.optJSONObject("pendingMutation")
            val generation = row.getLong("localGeneration")
            if (requestId != null) validateRequest(requestId, generation, content, pending)
            db.dao().put(RecordEditorDraftRow(libraryId, slot, requestId, generation, content.toString(), pending?.toString(), row.getLong("updatedAt")))
        }
        db.dao().put(RecordEditorDraftRow(libraryId, "archive-restore-marker", null, 0, digest, null, System.currentTimeMillis()))
    }

    @Synchronized
    fun read(libraryId: String, slot: String): JSONObject {
        validateScope(libraryId, slot)
        val row = db.dao().get(libraryId, slot)
        val hasDraft = row?.requestId != null
        val draft = if (hasDraft) JSONObject()
            .put("requestId", row!!.requestId)
            .put("localGeneration", row.localGeneration)
            .put("content", JSONObject(row.contentJson))
            .put("pendingMutation", row.pendingMutationJson?.let(::JSONObject) ?: JSONObject.NULL)
        else null
        val nextGeneration = when {
            row == null -> 0L
            hasDraft -> row.localGeneration
            row.localGeneration == Long.MAX_VALUE -> Long.MAX_VALUE
            else -> row.localGeneration + 1
        }
        return JSONObject().put("draft", draft ?: JSONObject.NULL).put("nextGeneration", nextGeneration)
    }

    @Synchronized
    fun save(libraryId: String, slot: String, requestId: String, localGeneration: Long,
             content: JSONObject, pendingMutation: JSONObject? = null): JSONObject {
        validateScope(libraryId, slot)
        validateRequest(requestId, localGeneration, content, pendingMutation)
        val contentJson = content.toString()
        val pendingJson = pendingMutation?.toString()
        val current = db.dao().get(libraryId, slot)
        if (current != null) {
            check(localGeneration >= current.localGeneration) { "RECORD_DRAFT_STALE" }
            if (localGeneration == current.localGeneration) {
                check(current.requestId == requestId && current.contentJson == contentJson) { "RECORD_DRAFT_GENERATION_REUSED" }
                when {
                    current.pendingMutationJson == null && pendingJson == null -> Unit
                    current.pendingMutationJson == null && pendingJson != null -> Unit // First transition into immutable pending state.
                    current.pendingMutationJson == pendingJson -> Unit // Exact replay only.
                    else -> error("RECORD_DRAFT_PENDING_IMMUTABLE")
                }
                db.dao().put(current.copy(pendingMutationJson = pendingJson ?: current.pendingMutationJson,
                    updatedAt = System.currentTimeMillis()))
                return JSONObject().put("saved", true)
            }
            check(current.pendingMutationJson == null) { "RECORD_DRAFT_PENDING_LOCKED" }
            check(current.requestId == null || localGeneration > current.localGeneration) { "RECORD_DRAFT_STALE" }
        }
        db.dao().put(RecordEditorDraftRow(libraryId, slot, requestId, localGeneration, contentJson,
            pendingJson, System.currentTimeMillis()))
        return JSONObject().put("saved", true)
    }

    @Synchronized
    fun releaseRejected(libraryId: String, slot: String, requestId: String) {
        validateScope(libraryId, slot)
        val current = db.dao().get(libraryId, slot) ?: return
        if (current.requestId != requestId || current.pendingMutationJson == null) return
        db.dao().put(current.copy(pendingMutationJson = null, updatedAt = System.currentTimeMillis()))
    }

    @Synchronized
    fun acknowledge(libraryId: String, slot: String, requestId: String, localGeneration: Long): JSONObject {
        validateScope(libraryId, slot)
        val current = db.dao().get(libraryId, slot)
        if (current == null || current.localGeneration != localGeneration)
            return JSONObject().put("cleared", false)
        if (current.requestId == null && current.contentJson == "{}" && current.pendingMutationJson == null)
            return JSONObject().put("cleared", true) // Idempotent after the first ACK response was lost.
        if (current.requestId != requestId)
            return JSONObject().put("cleared", false)
        // Retain a generation tombstone. A late queued save from the acknowledged request
        // cannot recreate its draft, and the next editor generation remains monotonic.
        db.dao().put(current.copy(requestId = null, contentJson = "{}", pendingMutationJson = null,
            updatedAt = System.currentTimeMillis()))
        return JSONObject().put("cleared", true)
    }

    private fun validateScope(libraryId: String, slot: String) {
        require(libraryId.length in 1..128 && libraryId != "null") { "INVALID_RECORD_DRAFT_LIBRARY" }
        require(slot in setOf("composer", "materials", "articles") || slot.matches(Regex("annotation:[0-9a-fA-F-]{36}"))) { "INVALID_RECORD_DRAFT_SLOT" }
    }

    private fun validateRequest(requestId: String, generation: Long, content: JSONObject, pending: JSONObject?) {
        try { UUID.fromString(requestId) } catch (_: Exception) { error("INVALID_RECORD_DRAFT_REQUEST") }
        require(generation in 0..9_007_199_254_740_991L) { "INVALID_RECORD_DRAFT_GENERATION" }
        require(content.toString().length <= 2_000_000) { "RECORD_DRAFT_TOO_LARGE" }
        if (pending != null) {
            require(pending.length() <= 16) { "INVALID_RECORD_PENDING_MUTATION" }
            require(pending.optString("requestId") == requestId && pending.optLong("localGeneration", -1) == generation) {
                "RECORD_PENDING_ID_MISMATCH"
            }
            require(pending.optString("action") in setOf("create", "update", "delete", "restore")) {
                "INVALID_RECORD_PENDING_ACTION"
            }
            require(pending.toString().length <= 2_000_000) { "RECORD_PENDING_TOO_LARGE" }
        }
    }

    fun close() { db.close() }
    internal fun clearLibraryForTest(libraryId: String) { db.dao().deleteLibrary(libraryId) }

    fun closeForTest() {
        close()
        app.deleteDatabase(databaseName)
    }
}
