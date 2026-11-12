package io.github.wyf929597870.shiwen.agent

import android.content.Context
import androidx.room.*
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Callable

internal const val LEGACY_CONVERSATION_ID = "legacy-single-tasks"
internal const val NEW_CONVERSATION_TITLE = "新会话"

@Entity(tableName = "agent_tasks")
internal data class AgentTask(@PrimaryKey val requestId: String, val fingerprint: String,
    val input: String, val modelId: String, val receiptRequestId: String?,
    val status: String = "admitted", val output: String = "", val error: String? = null,
    val updatedAt: String = Instant.now().toString(),
    @ColumnInfo(defaultValue = "''") val submissionHash: String = "",
    @ColumnInfo(defaultValue = "'legacy-single-tasks'") val conversationId: String = LEGACY_CONVERSATION_ID,
    @ColumnInfo(defaultValue = "''") val modelRevision: String = "",
    @ColumnInfo(defaultValue = "'[]'") val contextSnapshot: String = "[]",
    @ColumnInfo(defaultValue = "0") val contextTurns: Int = 0,
    @ColumnInfo(defaultValue = "0") val omittedTurns: Int = 0)

@Entity(tableName = "agent_drafts")
internal data class AgentDraft(@PrimaryKey val slot: String = LEGACY_CONVERSATION_ID, val requestId: String,
    val input: String, val saveOriginal: Boolean, val kind: String, val generation: Long,
    @ColumnInfo(defaultValue = "'legacy-single-tasks'") val conversationId: String = LEGACY_CONVERSATION_ID)

@Entity(tableName = "agent_conversations")
internal data class AgentConversation(@PrimaryKey val id: String, val title: String,
    val model: String?, val modelRevision: String?, val archived: Boolean, val readOnly: Boolean,
    val createdAt: String, val updatedAt: String,
    val profileRevision: String? = null, val profileAgentId: String? = null,
    val profileNodeId: String? = null, val systemContext: String? = null)

@Entity(tableName = "agent_session_state")
internal data class AgentSessionState(@PrimaryKey val key: String = "active", val activeId: String?)

@Dao
internal interface AgentTaskDao {
    @Query("SELECT DISTINCT conversationId FROM agent_tasks WHERE status IN ('admitted','running')")
    fun runningConversationIds(): List<String>
    @Query("SELECT * FROM agent_tasks ORDER BY requestId") fun archiveTasks(): List<AgentTask>
    @Query("SELECT * FROM agent_drafts ORDER BY slot") fun archiveDrafts(): List<AgentDraft>
    @Query("SELECT activeId FROM agent_session_state WHERE `key`='archive-restore-marker'") fun archiveMarker(): String?
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun saveDraft(draft: AgentDraft)
    @Query("SELECT * FROM agent_drafts WHERE conversationId=:conversationId") fun draft(conversationId: String): AgentDraft?
    @Query("DELETE FROM agent_drafts WHERE conversationId=:conversationId AND requestId=:id AND generation=:generation")
    fun clearDraft(conversationId: String, id: String, generation: Long)
    @Insert fun insert(task: AgentTask)
    @Query("SELECT * FROM agent_tasks WHERE requestId=:id") fun get(id: String): AgentTask?
    @Query("SELECT * FROM agent_tasks WHERE conversationId=:conversationId ORDER BY updatedAt DESC, requestId DESC LIMIT :limit OFFSET :offset")
    fun recent(conversationId: String, limit: Int, offset: Int): List<AgentTask>
    @Query("SELECT * FROM agent_tasks WHERE conversationId=:conversationId AND status='succeeded' AND modelRevision=:revision ORDER BY updatedAt DESC, requestId DESC LIMIT :limit")
    fun successfulRecent(conversationId: String, revision: String, limit: Int): List<AgentTask>
    @Query("SELECT COUNT(*) FROM agent_tasks WHERE conversationId=:conversationId AND status='succeeded' AND modelRevision=:revision")
    fun countSuccessful(conversationId: String, revision: String): Int
    @Query("SELECT * FROM agent_conversations ORDER BY archived ASC, updatedAt DESC, id ASC") fun conversations(): List<AgentConversation>
    @Query("SELECT * FROM agent_conversations WHERE id=:id") fun conversation(id: String): AgentConversation?
    @Query("SELECT COUNT(*) FROM agent_tasks WHERE conversationId='legacy-single-tasks'") fun legacyTaskCount(): Int
    @Query("SELECT COUNT(*) FROM agent_drafts WHERE conversationId='legacy-single-tasks'") fun legacyDraftCount(): Int
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insertConversation(conversation: AgentConversation)
    @Query("SELECT * FROM agent_conversations WHERE readOnly=0 ORDER BY updatedAt DESC, id ASC LIMIT 1")
    fun latestWritableConversation(): AgentConversation?
    @Query("DELETE FROM agent_tasks WHERE conversationId=:conversationId") fun deleteTasks(conversationId: String): Int
    @Query("DELETE FROM agent_drafts WHERE conversationId=:conversationId") fun deleteDrafts(conversationId: String): Int
    @Query("DELETE FROM agent_conversations WHERE id=:id AND readOnly=0") fun deleteConversation(id: String): Int
    @Query("UPDATE agent_conversations SET model=:model, modelRevision=:revision, title=:title, profileRevision=:profileRevision, profileAgentId=:profileAgentId, profileNodeId=:profileNodeId, systemContext=:systemContext, updatedAt=:at WHERE id=:id AND modelRevision IS NULL AND readOnly=0")
    fun bindConversation(id: String, model: String, revision: String, title: String, profileRevision: String?,
        profileAgentId: String?, profileNodeId: String?, systemContext: String?, at: String): Int
    @Query("UPDATE agent_conversations SET updatedAt=:at WHERE id=:id") fun touchConversation(id: String, at: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun saveSessionState(state: AgentSessionState)
    @Query("SELECT activeId FROM agent_session_state WHERE `key`='active'") fun activeConversationId(): String?
    @Query("UPDATE agent_tasks SET status='running', updatedAt=:at WHERE requestId=:id AND status='admitted'")
    fun start(id: String, at: String): Int
    @Query("UPDATE agent_tasks SET output=output || :text, updatedAt=:at WHERE requestId=:id AND status='running'")
    fun append(id: String, text: String, at: String)
    @Query("UPDATE agent_tasks SET status=:status, error=:error, updatedAt=:at WHERE requestId=:id AND status IN ('running','admitted')")
    fun finish(id: String, status: String, error: String?, at: String)
    @Query("UPDATE agent_tasks SET status='succeeded', output=:output, updatedAt=:at WHERE requestId=:id AND status='running'")
    fun succeed(id: String, output: String, at: String)
    @Query("UPDATE agent_tasks SET status='interrupted', error='PROCESS_INTERRUPTED', updatedAt=:at WHERE status IN ('admitted','running')")
    fun recoverInterrupted(at: String)
}

@Database(entities = [AgentTask::class, AgentDraft::class, AgentConversation::class, AgentSessionState::class], version = 4, exportSchema = true,
    autoMigrations = [AutoMigration(from = 1, to = 2), AutoMigration(from = 2, to = 3), AutoMigration(from = 3, to = 4)])
internal abstract class AgentTaskDatabase : RoomDatabase() { abstract fun tasks(): AgentTaskDao }

/** Separate P0 journal per library. Opening a view does not mutate the personal library. */
internal class AgentTaskStore(context: Context, val libraryId: String, namespace: String = "shiwen-p0-agent") {
    init { UUID.fromString(libraryId) }
    val db = Room.databaseBuilder(context.applicationContext, AgentTaskDatabase::class.java,
        "$namespace-$libraryId.sqlite").openHelperFactory(io.github.wyf929597870.shiwen.library.LargeRowOpenHelperFactory()).build()
    val dao get() = db.tasks()

    fun ensureLegacyConversation() {
        db.runInTransaction(Callable {
            if (dao.conversation(LEGACY_CONVERSATION_ID) == null &&
                (dao.legacyTaskCount() > 0 || dao.legacyDraftCount() > 0)) {
                val now = Instant.now().toString()
                dao.insertConversation(AgentConversation(LEGACY_CONVERSATION_ID, "历史单次任务", null, null,
                    archived = true, readOnly = true, createdAt = now, updatedAt = now))
            }
        })
    }

    fun admit(task: AgentTask): Pair<AgentTask, Boolean> = db.runInTransaction(Callable {
        UUID.fromString(task.requestId)
        val old = dao.get(task.requestId)
        if (old != null) {
            check(old.fingerprint == task.fingerprint) { "REQUEST_REUSED" }
            old to false
        } else {
            dao.insert(task)
            task to true
        }
    })
}
