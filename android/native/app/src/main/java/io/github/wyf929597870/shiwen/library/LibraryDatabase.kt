package io.github.wyf929597870.shiwen.library

import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject

@Entity(tableName = "records")
data class LibraryRecord(
    @PrimaryKey val id: String,
    val kind: String,
    val title: String,
    val markdown: String,
    val origin: String,
    val processing: String,
    val contentDay: String?,
    val dateBasis: String,
    val url: String?,
    val annotation: String?,
    val stage: String?,
    val sourceIdsJson: String,
    val sourcesJson: String,
    val attachmentDescriptorsJson: String,
    val createdAt: String,
    val updatedAt: String,
    val deleted: Boolean,
    val createdByDevice: String?,
    val versionId: String,
    val changeId: String,
    val baseVersionId: String?,
    val serverRevision: Long?,
    val localGeneration: Long,
    val revision: Long,
    val syncState: String,
    val annotationOfJson: String? = null
)

@Entity(tableName = "heads")
data class LibraryHead(@PrimaryKey val recordId: String, val revision: Long, val versionId: String?,
    val changeId: String?, val deleted: Boolean)

@Entity(tableName = "remote_heads")
data class LibraryRemoteHead(@PrimaryKey val recordId: String, val revision: Long, val versionId: String?,
    val changeId: String?, val deleted: Boolean, val recordJson: String, val updatedAt: String)

@Entity(tableName = "versions", primaryKeys = ["id"] , indices = [Index("recordId"), Index(value = ["recordId", "revision"])])
data class LibraryVersion(val id: String, val recordId: String, val revision: Long, val markdown: String,
    val title: String, val createdAt: String, val reason: String, val changeId: String?, val serverRevision: Long?,
    val docJson: String?, @ColumnInfo(defaultValue = "'[]'") val sourcesJson: String = "[]",
    @ColumnInfo(defaultValue = "'[]'") val parentVersionIdsJson: String = "[]",
    @ColumnInfo(defaultValue = "1") val sourcesDerived: Boolean = false,
    @ColumnInfo(defaultValue = "1") val parentsDerived: Boolean = false, val journalInputJson: String? = null)

@Entity(tableName = "provenance")
data class LibraryProvenance(@PrimaryKey val recordId: String, val json: String)

@Entity(tableName = "branches", indices = [Index("recordId"), Index("state")])
data class LibraryBranch(@PrimaryKey val branchId: String, val recordId: String, val state: String, val json: String)

@Entity(tableName = "branch_attachments", primaryKeys = ["branchId", "attachmentId"], indices = [Index("hash")])
data class LibraryBranchAttachment(val branchId: String, val attachmentId: String, val name: String, val createdAt: String,
    val hash: String, val byteLength: Long, val localRelativePath: String?, val downloaded: Boolean, val uploaded: Boolean)

@Entity(tableName = "activities", indices = [Index("recordId"), Index("occurredAt")])
data class LibraryActivity(@PrimaryKey val activityId: String, val recordId: String, val changeId: String?,
    val originDeviceId: String?, val occurredAt: String, val timeZone: String, val beforeHash: String,
    val afterHash: String, val afterSegmentsJson: String, val action: String, val authorship: String,
    val added: Int, val removed: Int, val serverSeq: Long?)

@Entity(tableName = "links", primaryKeys = ["articleId", "materialId"], indices = [Index("materialId")])
data class LibraryLink(val articleId: String, val materialId: String)

@Entity(tableName = "attachments", indices = [Index("recordId"), Index("hash")])
data class LibraryAttachment(@PrimaryKey val id: String, val recordId: String, val name: String,
    val createdAt: String, val hash: String, val byteLength: Long, val localRelativePath: String?,
    val downloaded: Boolean, val uploaded: Boolean)

@Entity(tableName = "outbox", indices = [Index("recordId"), Index("state"), Index("createdAt")])
data class LibraryOutbox(@PrimaryKey val operationId: String, val recordId: String, val changeId: String,
    val versionId: String, val baseVersionId: String?, val baseRevision: Long?, val localGeneration: Long,
    val action: String, val payloadJson: String, val fingerprint: String, val state: String,
    val attempts: Int, val createdAt: String, val lastError: String?)

@Entity(tableName = "receipts")
data class LibraryReceipt(@PrimaryKey val requestId: String, val fingerprint: String, val recordId: String,
    val status: String, val appliedAt: String)

@Entity(tableName = "conflicts", indices = [Index("recordId"), Index("state")])
data class LibraryConflict(@PrimaryKey val id: String, val recordId: String, val operationId: String,
    val baseJson: String, val localJson: String, val remoteJson: String, val remoteRevision: Long?,
    val state: String, val createdAt: String)

@Entity(tableName = "library_meta")
data class LibraryMeta(@PrimaryKey val key: String, val value: String)

@Entity(tableName = "drafts")
data class LibraryDraft(@PrimaryKey val slot: String, val requestId: String, val title: String,
    val markdown: String, val kind: String, val generation: Long, val updatedAt: String)

@Dao
interface LibraryDao {
    @Query("SELECT * FROM records WHERE kind!='ai_annotation' AND (:includeDeleted=1 OR deleted=0) AND (:query='' OR instr(title,:query)>0 OR instr(markdown,:query)>0) AND (:kind IS NULL OR kind=:kind) AND (:excludeKind IS NULL OR kind!=:excludeKind) ORDER BY CASE WHEN contentDay IS NULL THEN 1 ELSE 0 END, contentDay DESC, createdAt DESC, id DESC LIMIT :limit OFFSET :offset")
    fun records(query: String, kind: String?, includeDeleted: Boolean, limit: Int, offset: Int, excludeKind: String? = null): List<LibraryRecord>
    @Query("SELECT * FROM records WHERE id=:id") fun record(id: String): LibraryRecord?
    @Query("SELECT * FROM records WHERE kind='journal' AND deleted=0 AND contentDay=:day ORDER BY createdAt,id LIMIT 1")
    fun journalForDay(day: String): LibraryRecord?
    @Query("SELECT contentDay FROM records WHERE kind='journal' AND deleted=0 AND contentDay IS NOT NULL GROUP BY contentDay HAVING count(*)>1")
    fun duplicateJournalDays(): List<String>
    @Query("SELECT * FROM records WHERE kind='journal' AND deleted=0 AND contentDay=:day ORDER BY createdAt,id")
    fun journalsForDay(day: String): List<LibraryRecord>
    @Query("SELECT * FROM records ORDER BY id") fun allRecords(): List<LibraryRecord>
    @Query("SELECT * FROM heads WHERE recordId=:id") fun head(id: String): LibraryHead?
    @Query("SELECT * FROM heads ORDER BY recordId") fun allHeads(): List<LibraryHead>
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putRemoteHead(row: LibraryRemoteHead)
    @Query("SELECT * FROM remote_heads WHERE recordId=:id") fun remoteHead(id: String): LibraryRemoteHead?
    @Query("SELECT * FROM remote_heads ORDER BY recordId") fun allRemoteHeads(): List<LibraryRemoteHead>
    @Query("SELECT count(*) FROM records") fun recordCount(): Int
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insertRecord(row: LibraryRecord)
    @Insert(onConflict = OnConflictStrategy.IGNORE) fun insertRemoteRecord(row: LibraryRecord): Long
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putHead(row: LibraryHead)
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putLink(row: LibraryLink)
    @Query("DELETE FROM links WHERE articleId=:articleId") fun clearLinks(articleId: String)
    @Query("SELECT * FROM links WHERE articleId=:articleId ORDER BY materialId") fun links(articleId: String): List<LibraryLink>
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putAttachment(row: LibraryAttachment)
    @Query("SELECT * FROM attachments WHERE recordId=:recordId ORDER BY createdAt,id") fun attachments(recordId: String): List<LibraryAttachment>
    @Query("SELECT * FROM attachments WHERE downloaded=0 ORDER BY recordId,id") fun attachmentsNotDownloaded(): List<LibraryAttachment>
    @Query("SELECT * FROM attachments ORDER BY id") fun allAttachments(): List<LibraryAttachment>
    @Update fun updateRecord(row: LibraryRecord): Int
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insertVersion(row: LibraryVersion)
    @Insert(onConflict = OnConflictStrategy.IGNORE) fun insertRemoteVersion(row: LibraryVersion): Long
    @Query("SELECT * FROM versions WHERE recordId=:recordId ORDER BY revision DESC, id DESC") fun versions(recordId: String): List<LibraryVersion>
    @Query("SELECT * FROM versions ORDER BY recordId,revision,id") fun allVersions(): List<LibraryVersion>
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putProvenance(row: LibraryProvenance)
    @Query("SELECT * FROM provenance WHERE recordId=:recordId") fun provenance(recordId: String): LibraryProvenance?
    @Query("SELECT * FROM provenance ORDER BY recordId") fun allProvenance(): List<LibraryProvenance>
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putBranch(row: LibraryBranch)
    @Query("SELECT * FROM branches ORDER BY branchId") fun allBranches(): List<LibraryBranch>
    @Query("SELECT * FROM branches WHERE branchId=:id") fun branch(id: String): LibraryBranch?
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putBranchAttachment(row: LibraryBranchAttachment)
    @Query("SELECT * FROM branch_attachments ORDER BY branchId,attachmentId") fun allBranchAttachments(): List<LibraryBranchAttachment>
    @Query("SELECT * FROM branch_attachments WHERE branchId=:branchId AND attachmentId=:attachmentId") fun branchAttachment(branchId: String, attachmentId: String): LibraryBranchAttachment?
    @Query("SELECT * FROM branch_attachments WHERE downloaded=0 ORDER BY branchId,attachmentId") fun branchAttachmentsNotDownloaded(): List<LibraryBranchAttachment>
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insertActivity(row: LibraryActivity)
    @Insert(onConflict = OnConflictStrategy.IGNORE) fun insertRemoteActivity(row: LibraryActivity): Long
    @Query("SELECT * FROM activities WHERE recordId=:recordId ORDER BY occurredAt DESC, activityId DESC") fun activities(recordId: String): List<LibraryActivity>
    @Query("SELECT * FROM activities WHERE occurredAt>=:from AND occurredAt<:to ORDER BY occurredAt, activityId") fun activitiesBetween(from: String, to: String): List<LibraryActivity>
    @Query("SELECT * FROM activities ORDER BY recordId,occurredAt,activityId") fun allActivities(): List<LibraryActivity>
    @Query("SELECT * FROM links ORDER BY articleId,materialId") fun allLinks(): List<LibraryLink>
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putReceipt(row: LibraryReceipt)
    @Query("SELECT * FROM receipts WHERE requestId=:id") fun receipt(id: String): LibraryReceipt?
    @Query("SELECT * FROM receipts ORDER BY requestId") fun allReceipts(): List<LibraryReceipt>
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insertOutbox(row: LibraryOutbox)
    @Query("SELECT * FROM outbox WHERE state IN ('pending','unknown','blocked-dependency') ORDER BY createdAt, operationId LIMIT :limit") fun pendingOutbox(limit: Int): List<LibraryOutbox>
    @Query("SELECT * FROM outbox ORDER BY createdAt,operationId") fun allOutbox(): List<LibraryOutbox>
    @Query("SELECT * FROM outbox WHERE operationId=:id") fun outbox(id: String): LibraryOutbox?
    @Query("SELECT * FROM outbox WHERE versionId=:versionId ORDER BY createdAt,operationId LIMIT 1") fun outboxByVersionId(versionId: String): LibraryOutbox?
    @Update fun updateOutbox(row: LibraryOutbox): Int
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putConflict(row: LibraryConflict)
    @Query("SELECT * FROM conflicts WHERE state='open' ORDER BY createdAt DESC, id DESC LIMIT :limit OFFSET :offset") fun conflicts(limit: Int, offset: Int): List<LibraryConflict>
    @Query("SELECT * FROM conflicts WHERE id=:id") fun conflict(id: String): LibraryConflict?
    @Query("SELECT * FROM conflicts ORDER BY id") fun allConflicts(): List<LibraryConflict>
    @Update fun updateConflict(row: LibraryConflict): Int
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putMeta(row: LibraryMeta)
    @Query("SELECT value FROM library_meta WHERE `key`=:key") fun meta(key: String): String?
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putDraft(row: LibraryDraft)
    @Query("SELECT * FROM drafts WHERE slot=:slot") fun draft(slot: String): LibraryDraft?
    @Query("SELECT * FROM drafts ORDER BY slot") fun allDrafts(): List<LibraryDraft>
    @Query("DELETE FROM drafts WHERE slot=:slot AND requestId=:requestId AND generation=:generation") fun clearDraft(slot: String, requestId: String, generation: Long): Int
}

@Database(entities = [LibraryRecord::class, LibraryVersion::class, LibraryActivity::class, LibraryLink::class,
    LibraryAttachment::class, LibraryOutbox::class, LibraryReceipt::class, LibraryConflict::class, LibraryMeta::class,
    LibraryDraft::class, LibraryHead::class, LibraryProvenance::class, LibraryRemoteHead::class, LibraryBranch::class,
    LibraryBranchAttachment::class], version = 7, exportSchema = true)
abstract class LibraryDatabase : RoomDatabase() { abstract fun dao(): LibraryDao }

val LIBRARY_MIGRATION_6_7 = object : Migration(6, 7) {
    override fun migrate(db: SupportSQLiteDatabase) { db.execSQL("ALTER TABLE `versions` ADD COLUMN `journalInputJson` TEXT") }
}

val LIBRARY_MIGRATION_5_6 = object : Migration(5, 6) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `records` ADD COLUMN `annotationOfJson` TEXT")
    }
}

val LIBRARY_MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        fun hasColumn(table: String, column: String): Boolean = db.query("PRAGMA table_info(`$table`)").use { cursor ->
            val nameIndex = cursor.getColumnIndex("name")
            var found = false
            while (cursor.moveToNext()) if (cursor.getString(nameIndex) == column) found = true
            found
        }
        if (!hasColumn("versions", "docJson")) db.execSQL("ALTER TABLE `versions` ADD COLUMN `docJson` TEXT")
        db.execSQL("DROP INDEX IF EXISTS `index_versions_recordId_revision`")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_versions_recordId_revision` ON `versions` (`recordId`, `revision`)")
        db.execSQL("CREATE TABLE IF NOT EXISTS `provenance` (`recordId` TEXT NOT NULL, `json` TEXT NOT NULL, PRIMARY KEY(`recordId`))")
        db.execSQL("CREATE TABLE IF NOT EXISTS `remote_heads` (`recordId` TEXT NOT NULL, `revision` INTEGER NOT NULL, `versionId` TEXT, `changeId` TEXT, `deleted` INTEGER NOT NULL, `recordJson` TEXT NOT NULL, `updatedAt` TEXT NOT NULL, PRIMARY KEY(`recordId`))")
    }
}

val LIBRARY_MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `versions` ADD COLUMN `sourcesJson` TEXT NOT NULL DEFAULT '[]'")
        db.execSQL("ALTER TABLE `versions` ADD COLUMN `parentVersionIdsJson` TEXT NOT NULL DEFAULT '[]'")
        db.execSQL("UPDATE `versions` SET `sourcesJson`=(SELECT `sourcesJson` FROM `records` WHERE `records`.`versionId`=`versions`.`id`) WHERE EXISTS(SELECT 1 FROM `records` WHERE `records`.`versionId`=`versions`.`id`)")
        db.execSQL("CREATE TABLE IF NOT EXISTS `activities_new` (`activityId` TEXT NOT NULL, `recordId` TEXT NOT NULL, `changeId` TEXT, `originDeviceId` TEXT, `occurredAt` TEXT NOT NULL, `timeZone` TEXT NOT NULL, `beforeHash` TEXT NOT NULL, `afterHash` TEXT NOT NULL, `afterSegmentsJson` TEXT NOT NULL, `action` TEXT NOT NULL, `authorship` TEXT NOT NULL, `added` INTEGER NOT NULL, `removed` INTEGER NOT NULL, `serverSeq` INTEGER, PRIMARY KEY(`activityId`))")
        db.execSQL("INSERT INTO `activities_new` (`activityId`,`recordId`,`changeId`,`originDeviceId`,`occurredAt`,`timeZone`,`beforeHash`,`afterHash`,`afterSegmentsJson`,`action`,`authorship`,`added`,`removed`,`serverSeq`) SELECT `activityId`,`recordId`,`changeId`,NULLIF(NULLIF(`originDeviceId`,'null'),''),`occurredAt`,`timeZone`,`beforeHash`,`afterHash`,`afterSegmentsJson`,`action`,`authorship`,`added`,`removed`,`serverSeq` FROM `activities`")
        db.execSQL("DROP TABLE `activities`")
        db.execSQL("ALTER TABLE `activities_new` RENAME TO `activities`")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_activities_recordId` ON `activities` (`recordId`)")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_activities_occurredAt` ON `activities` (`occurredAt`)")
    }
}

val LIBRARY_MIGRATION_3_4 = object : Migration(3, 4) {
    override fun migrate(db: SupportSQLiteDatabase) {
        fun hasColumn(table: String, column: String): Boolean = db.query("PRAGMA table_info(`$table`)").use { cursor ->
            val index = cursor.getColumnIndex("name"); var found = false
            while (cursor.moveToNext()) if (cursor.getString(index) == column) found = true
            found
        }
        if (!hasColumn("versions", "sourcesDerived")) db.execSQL("ALTER TABLE `versions` ADD COLUMN `sourcesDerived` INTEGER NOT NULL DEFAULT 1")
        if (!hasColumn("versions", "parentsDerived")) db.execSQL("ALTER TABLE `versions` ADD COLUMN `parentsDerived` INTEGER NOT NULL DEFAULT 1")
        val revisionCounts = mutableMapOf<Pair<String, Long>, Int>()
        db.query("SELECT `recordId`,`revision`,COUNT(*) FROM `versions` GROUP BY `recordId`,`revision`").use { rows ->
            while (rows.moveToNext()) revisionCounts[rows.getString(0) to rows.getLong(1)] = rows.getInt(2)
        }
        db.query("SELECT `id`,`recordId`,`revision`,`markdown`,`docJson`,`sourcesJson`,`parentVersionIdsJson`,`sourcesDerived`,`parentsDerived` FROM `versions` ORDER BY `recordId`,`revision`,`id`").use { cursor ->
            var priorRecord: String? = null; var priorId: String? = null; var priorRevision = -1L
            val update = db.compileStatement("UPDATE `versions` SET `sourcesJson`=?,`parentVersionIdsJson`=?,`sourcesDerived`=?,`parentsDerived`=? WHERE `id`=?")
            while (cursor.moveToNext()) {
                val id = cursor.getString(0); val recordId = cursor.getString(1); val revision = cursor.getLong(2)
                val markdown = cursor.getString(3); val doc = runCatching { if (cursor.isNull(4)) null else JSONObject(cursor.getString(4)) }.getOrNull()
                val existingSources = runCatching { JSONArray(cursor.getString(5)) }.getOrNull()
                val existingParents = runCatching { JSONArray(cursor.getString(6)) }.getOrNull()
                val oldSourcesDerived = cursor.getInt(7) != 0; val oldParentsDerived = cursor.getInt(8) != 0
                fun validSegments(value: JSONArray?): JSONArray? {
                    if (value == null) return null
                    val copy = runCatching { JSONArray(value.toString()) }.getOrNull() ?: return null
                    val joined = runCatching { buildString { for (i in 0 until copy.length()) append(copy.getJSONObject(i).getString("text")) } }.getOrNull()
                    return copy.takeIf { joined == markdown }
                }
                val currentSources = db.query("SELECT `sourcesJson` FROM `records` WHERE `versionId`=?", arrayOf(id)).use { rows ->
                    if (rows.moveToFirst()) runCatching { JSONArray(rows.getString(0)) }.getOrNull() else null
                }
                var sources = validSegments(existingSources) ?: validSegments(currentSources) ?: validSegments(doc?.optJSONArray("sources"))
                var sourcesDerived = oldSourcesDerived
                if (sources == null) {
                    val sourceRef = doc?.optString("sourceRef")?.takeIf { it.isNotBlank() && it != "null" }
                    sources = JSONArray().put(JSONObject().put("text", markdown).put("origin", "unknown")
                        .put("sourceRef", sourceRef ?: "legacy-derived"))
                    sourcesDerived = true
                }
                val docParents = doc?.optJSONArray("parentVersionIds")
                var parents = existingParents?.takeIf { it.length() > 0 }
                var parentsDerived = oldParentsDerived
                if (parents == null && docParents != null && docParents.length() <= 1000) {
                    parents = JSONArray(docParents.toString()); parentsDerived = false
                }
                if (parents == null) {
                    val linearParent = priorRecord == recordId && priorId != null && revision == priorRevision + 1 &&
                        revisionCounts[recordId to priorRevision] == 1 && revisionCounts[recordId to revision] == 1
                    parents = if (linearParent) JSONArray().put(priorId) else JSONArray()
                    parentsDerived = true
                }
                update.clearBindings(); update.bindString(1, sources.toString()); update.bindString(2, parents.toString())
                update.bindLong(3, if (sourcesDerived) 1 else 0); update.bindLong(4, if (parentsDerived) 1 else 0)
                update.bindString(5, id); update.executeUpdateDelete()
                priorRecord = recordId; priorId = id; priorRevision = revision
            }
        }
        // Normalize the historical literal produced when nullable originDeviceId was
        // serialized as the string "null" before this migration path was installed.
        db.execSQL("UPDATE `activities` SET `originDeviceId`=NULL WHERE `originDeviceId`='null' OR `originDeviceId`=''")
        db.execSQL("CREATE TABLE IF NOT EXISTS `branches` (`branchId` TEXT NOT NULL, `recordId` TEXT NOT NULL, `state` TEXT NOT NULL, `json` TEXT NOT NULL, PRIMARY KEY(`branchId`))")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_branches_recordId` ON `branches` (`recordId`)")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_branches_state` ON `branches` (`state`)")
    }
}

val LIBRARY_MIGRATION_4_5 = object : Migration(4, 5) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("UPDATE `activities` SET `originDeviceId`=NULL WHERE `originDeviceId`='null' OR `originDeviceId`=''")
        db.query("SELECT `id`,`markdown`,`sourcesJson` FROM `versions`").use { cursor ->
            val update = db.compileStatement("UPDATE `versions` SET `sourcesJson`=?,`sourcesDerived`=1 WHERE `id`=?")
            while (cursor.moveToNext()) {
                val id = cursor.getString(0); val markdown = cursor.getString(1).orEmpty()
                val sources = runCatching { JSONArray(cursor.getString(2)) }.getOrNull()
                val joined = sources?.let { rows -> buildString {
                    for (index in 0 until rows.length()) append(rows.optJSONObject(index)?.optString("text").orEmpty())
                } }
                if (joined != markdown) {
                    val fallback = JSONArray()
                    if (markdown.isNotEmpty()) fallback.put(JSONObject().put("text", markdown).put("origin", "unknown")
                        .put("sourceRef", "legacy-derived"))
                    update.clearBindings(); update.bindString(1, fallback.toString()); update.bindString(2, id); update.executeUpdateDelete()
                }
            }
        }
        db.execSQL("CREATE TABLE IF NOT EXISTS `branch_attachments` (`branchId` TEXT NOT NULL, `attachmentId` TEXT NOT NULL, `name` TEXT NOT NULL, `createdAt` TEXT NOT NULL, `hash` TEXT NOT NULL, `byteLength` INTEGER NOT NULL, `localRelativePath` TEXT, `downloaded` INTEGER NOT NULL, `uploaded` INTEGER NOT NULL, PRIMARY KEY(`branchId`,`attachmentId`))")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_branch_attachments_hash` ON `branch_attachments` (`hash`)")
    }
}

@Entity(tableName = "libraries")
data class LibraryRegistryRow(@PrimaryKey val libraryId: String, val name: String, val deviceId: String,
    val dbFile: String, val role: String, val integrity: String, val serverId: String?, val epoch: String?,
    val protocolVersion: Int, val lastSyncedAt: String?, val appliedCursor: String?, val completeCursor: String?,
    val cursor: String?, val manifestDigest: String?, val pageGeneration: Long, val migrationP0Done: Boolean,
    val autoSync: Boolean, val backgroundSync: Boolean, val syncConditionsJson: String)

@Dao
interface LibraryRegistryDao {
    @Query("SELECT * FROM libraries ORDER BY name COLLATE NOCASE, libraryId") fun all(): List<LibraryRegistryRow>
    @Query("SELECT * FROM libraries WHERE libraryId=:id") fun get(id: String): LibraryRegistryRow?
    @Query("DELETE FROM libraries WHERE libraryId=:id") fun delete(id: String): Int
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insert(row: LibraryRegistryRow)
    @Update fun update(row: LibraryRegistryRow): Int
    @Query("SELECT value FROM registry_meta WHERE `key`=:key") fun meta(key: String): String?
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putMeta(row: RegistryMeta)
    @Query("SELECT * FROM restore_reservations WHERE requestId=:requestId") fun restoreReservation(requestId: String): LibraryRestoreReservation?
    @Query("SELECT * FROM restore_reservations WHERE targetLibraryId=:libraryId AND state='reserved' LIMIT 1")
    fun reservedRestoreForLibrary(libraryId: String): LibraryRestoreReservation?
    @Query("SELECT * FROM restore_reservations WHERE state='reserved' ORDER BY createdAt,requestId")
    fun pendingRestoreReservations(): List<LibraryRestoreReservation>
    @Query("SELECT * FROM restore_reservations ORDER BY createdAt,requestId")
    fun allRestoreReservations(): List<LibraryRestoreReservation>
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insertRestoreReservation(row: LibraryRestoreReservation)
    @Update fun updateRestoreReservation(row: LibraryRestoreReservation): Int
}

@Entity(tableName = "registry_meta") data class RegistryMeta(@PrimaryKey val key: String, val value: String)
@Entity(tableName = "restore_reservations", indices = [Index(value = ["targetLibraryId"])])
data class LibraryRestoreReservation(
    @PrimaryKey val requestId: String,
    val fingerprint: String,
    val targetLibraryId: String,
    val sourceLibraryId: String,
    val name: String,
    val deviceId: String,
    val dbFile: String,
    val asNewLibrary: Boolean,
    val state: String,
    val createdAt: String,
    val completedAt: String?
)

@Database(entities = [LibraryRegistryRow::class, RegistryMeta::class, LibraryRestoreReservation::class], version = 2, exportSchema = true)
abstract class LibraryRegistryDatabase : RoomDatabase() { abstract fun dao(): LibraryRegistryDao }

val LIBRARY_REGISTRY_MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS `restore_reservations` (`requestId` TEXT NOT NULL, `fingerprint` TEXT NOT NULL, `targetLibraryId` TEXT NOT NULL, `sourceLibraryId` TEXT NOT NULL, `name` TEXT NOT NULL, `deviceId` TEXT NOT NULL, `dbFile` TEXT NOT NULL, `asNewLibrary` INTEGER NOT NULL, `state` TEXT NOT NULL, `createdAt` TEXT NOT NULL, `completedAt` TEXT, PRIMARY KEY(`requestId`))")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_restore_reservations_targetLibraryId` ON `restore_reservations` (`targetLibraryId`)")
    }
}
