package io.github.wyf929597870.shiwen.network

import android.content.Context
import androidx.room.Database
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import java.util.concurrent.Callable
import org.json.JSONObject

@Entity(tableName = "remote_session_drafts")
internal data class NodeSessionDraft(
    @PrimaryKey val key: String,
    val nodeId: String,
    val configRevision: String,
    val sessionId: String,
    val requestId: String?,
    val text: String,
    val mode: String,
    val pending: Boolean,
    val localGeneration: Long,
    val updatedAt: Long
)

@Dao
internal interface NodeSessionDraftDao {
    @Query("SELECT * FROM remote_session_drafts WHERE key=:key") fun get(key: String): NodeSessionDraft?
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun put(row: NodeSessionDraft)
    @Query("DELETE FROM remote_session_drafts WHERE key=:key") fun delete(key: String)
}

@Database(entities = [NodeSessionDraft::class], version = 1, exportSchema = true)
internal abstract class NodeSessionDraftDatabase : RoomDatabase() {
    abstract fun dao(): NodeSessionDraftDao
}

/** Local recovery only; remote session drafts and pending-send markers are isolated per node config. */
internal class NodeSessionDraftStore(context: Context, namespace: String = "shiwen-remote-session-drafts") {
    private val app = context.applicationContext
    private val databaseName = "$namespace.sqlite"
    private val db = Room.databaseBuilder(context.applicationContext, NodeSessionDraftDatabase::class.java,
        databaseName).build()

    fun read(nodeId: String, configRevision: String, sessionId: String): JSONObject {
        require(nodeId.length in 1..128 && configRevision.length in 1..128 && sessionId.length in 1..256) { "INVALID_NODE_DRAFT_SCOPE" }
        val row = db.dao().get(key(nodeId, configRevision, sessionId))
        val draft = row?.let { JSONObject().put("requestId", it.requestId ?: JSONObject.NULL)
            .put("text", it.text).put("mode", it.mode).put("pending", it.pending).put("localGeneration", it.localGeneration) }
        return JSONObject().put("draft", draft ?: JSONObject.NULL)
    }

    fun save(nodeId: String, configRevision: String, sessionId: String, draft: JSONObject): JSONObject {
        require(nodeId.length in 1..128 && configRevision.length in 1..128) { "INVALID_NODE_DRAFT_SCOPE" }
        require(sessionId.length in 1..256 && sessionId != "null") { "INVALID_NODE_SESSION_ID" }
        val text = draft.optString("text")
        val mode = draft.optString("mode", "queue")
        val requestId = draft.optString("requestId").takeUnless { it.isBlank() || it == "null" }
        val generation = draft.optLong("localGeneration", 0L)
        require(text.length <= 32_000 && mode in setOf("queue", "steer")) { "INVALID_NODE_DRAFT" }
        require(generation >= 0) { "INVALID_NODE_DRAFT_GENERATION" }
        val key = key(nodeId, configRevision, sessionId)
        return db.runInTransaction(Callable {
        val current = db.dao().get(key)
        val pending = draft.optBoolean("pending")
        if (current != null) {
            check(generation >= current.localGeneration) { "NODE_DRAFT_STALE" }
            if (generation == current.localGeneration) {
                check(current.requestId == requestId && current.text == text && current.mode == mode && current.pending == pending) {
                    "NODE_DRAFT_GENERATION_REUSED"
                }
                return@Callable JSONObject().put("saved", true)
            }
            check(!current.pending || pending || generation > current.localGeneration) { "NODE_DRAFT_PENDING_LOCKED" }
        }
        db.dao().put(NodeSessionDraft(key, nodeId, configRevision, sessionId, requestId,
            text, mode, pending, generation, System.currentTimeMillis()))
        JSONObject().put("saved", true)
        })
    }

    private fun key(nodeId: String, revision: String, sessionId: String): String =
        "${nodeId.length}:$nodeId${revision.length}:$revision${sessionId.length}:$sessionId"

    fun closeForTest() { db.close(); app.deleteDatabase(databaseName) }
}
