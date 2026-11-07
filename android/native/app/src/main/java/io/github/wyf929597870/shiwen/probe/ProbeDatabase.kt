package io.github.wyf929597870.shiwen.probe

import androidx.room.*

// P0 uses a separate database name; this schema is not the production library.
@Entity(tableName = "records")
data class ProbeRecord(@PrimaryKey val id: String, val title: String, val markdown: String,
    val kind: String, val createdAt: String, val versionId: String, val changeId: String, val originDeviceId: String)
@Entity(tableName = "activities")
data class ProbeActivity(@PrimaryKey val activityId: String, val recordId: String,
    val originDeviceId: String, val occurredAt: String, val afterHash: String)
@Entity(tableName = "receipts")
data class ProbeReceipt(@PrimaryKey val requestId: String, val fingerprint: String, val recordId: String)
@Entity(tableName = "drafts")
data class ProbeDraft(@PrimaryKey val slot: String = "composer", val requestId: String, val title: String,
    val markdown: String, val kind: String, val generation: Long)
@Dao
interface ProbeDao {
    @Insert fun insertRecord(value: ProbeRecord)
    @Insert fun insertActivity(value: ProbeActivity)
    @Insert fun insertReceipt(value: ProbeReceipt)
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putDraft(value: ProbeDraft)
    @Query("SELECT * FROM records ORDER BY createdAt DESC, id DESC LIMIT :limit OFFSET :offset")
    fun records(offset: Int, limit: Int): List<ProbeRecord>
    @Query("SELECT * FROM records WHERE instr(title, :query)>0 OR instr(markdown, :query)>0 ORDER BY createdAt DESC, id DESC LIMIT 20")
    fun search(query: String): List<ProbeRecord>
    @Query("SELECT * FROM records WHERE id=:id") fun record(id: String): ProbeRecord?
    @Query("SELECT * FROM records ORDER BY createdAt, id") fun allRecords(): List<ProbeRecord>
    @Query("SELECT * FROM activities ORDER BY occurredAt, activityId") fun allActivities(): List<ProbeActivity>
    @Query("SELECT * FROM receipts ORDER BY requestId") fun allReceipts(): List<ProbeReceipt>
    @Query("SELECT * FROM drafts WHERE slot='composer'") fun composerDraft(): ProbeDraft?
    @Query("SELECT * FROM receipts WHERE requestId=:id") fun receipt(id: String): ProbeReceipt?
    @Query("SELECT * FROM drafts WHERE slot='composer'") fun draft(): ProbeDraft?
    @Query("DELETE FROM drafts WHERE slot='composer' AND requestId=:requestId AND generation=:generation")
    fun clearDraft(requestId: String, generation: Long)
}
@Database(entities = [ProbeRecord::class, ProbeActivity::class, ProbeReceipt::class, ProbeDraft::class], version = 1, exportSchema = true)
abstract class ProbeDatabase : RoomDatabase() { abstract fun dao(): ProbeDao }
