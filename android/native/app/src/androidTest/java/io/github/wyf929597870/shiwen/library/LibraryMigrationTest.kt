package io.github.wyf929597870.shiwen.library

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Start from real exported old schemas, then let the production repository migrate. */
@RunWith(AndroidJUnit4::class)
class LibraryMigrationTest {
    @Test fun oldVersionOneWithoutHistoryDocumentMigratesWithoutLosingData() = migrate(1, true)
    @Test fun versionTwoRetainsHistoricalSourcesAndDrafts() = migrate(2, false)
    @Test fun alreadyInstalledVersionThreeReceivesNewFieldsWithoutDataLoss() = migrate(3, false)
    @Test fun alreadyInstalledVersionFourReceivesBranchAttachmentsWithoutDataLoss() = migrate(4, false)

    private fun migrate(version: Int, earlyVersionOne: Boolean) {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val libraryId = UUID.randomUUID().toString(); val deviceId = UUID.randomUUID().toString()
        val databaseName = "migration-fixture-$libraryId.sqlite"; val registryName = "migration-registry-$libraryId.sqlite"
        val schema = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
            .open("io.github.wyf929597870.shiwen.library.LibraryDatabase/$version.json").bufferedReader().use { it.readText() }).getJSONObject("database")
        val entities = schema.getJSONArray("entities"); val recordId = UUID.randomUUID().toString()
        val firstVersion = UUID.randomUUID().toString(); val secondVersion = UUID.randomUUID().toString()
        val source = JSONArray().put(JSONObject().put("text", "先前正文").put("origin", "personal").put("sourceRef", "voice:synthetic"))
        val registry = Room.databaseBuilder(context, LibraryRegistryDatabase::class.java, registryName).build()
        var repository: LibraryRepository? = null
        try {
            context.getDatabasePath(databaseName).parentFile!!.mkdirs()
            SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(databaseName), null).use { old ->
                for (i in 0 until entities.length()) {
                    val entity = entities.getJSONObject(i); val table = entity.getString("tableName")
                    if (earlyVersionOne && table in setOf("provenance", "remote_heads")) continue
                    var sql = entity.getString("createSql").replace("\${TABLE_NAME}", table)
                    if (earlyVersionOne && table == "versions") sql = sql.replace(", `docJson` TEXT", "")
                    old.execSQL(sql)
                    val indexes = entity.optJSONArray("indices") ?: JSONArray()
                    for (j in 0 until indexes.length()) old.execSQL(indexes.getJSONObject(j).getString("createSql").replace("\${TABLE_NAME}", table))
                }
                fun insert(table: String, overrides: Map<String, Any?>) {
                    val entity = (0 until entities.length()).map(entities::getJSONObject).first { it.getString("tableName") == table }
                    val fields = entity.getJSONArray("fields"); val values = ContentValues()
                    for (i in 0 until fields.length()) {
                        val field = fields.getJSONObject(i);val column = field.getString("columnName")
                        if (earlyVersionOne && column == "docJson") continue
                        val value = if (overrides.containsKey(column)) overrides[column] else if (!field.optBoolean("notNull", false)) null else if (field.getString("affinity") == "INTEGER") 0L else ""
                        when (value) { null -> values.putNull(column); is Number -> values.put(column, value.toLong()); else -> values.put(column, value.toString()) }
                    }
                    old.insertOrThrow(table, null, values)
                }
                insert("records", mapOf("id" to recordId,"title" to "迁移测试","kind" to "journal","markdown" to "当前正文","origin" to "personal","processing" to "original","sourceIdsJson" to "[]","sourcesJson" to "[{\"text\":\"当前正文\",\"origin\":\"personal\"}]","attachmentDescriptorsJson" to "[]","versionId" to secondVersion,"revision" to 2,"syncState" to "local-only"))
                insert("versions", mapOf("id" to firstVersion,"recordId" to recordId,"revision" to 1,"markdown" to "先前正文","docJson" to JSONObject().put("sources",source).toString(),"sourcesJson" to source.toString(),"parentVersionIdsJson" to "[]"))
                insert("versions", mapOf("id" to secondVersion,"recordId" to recordId,"revision" to 2,"markdown" to "当前正文","sourcesJson" to "[]","parentVersionIdsJson" to "[]"))
                insert("activities", mapOf("activityId" to "historic-activity","recordId" to recordId,"originDeviceId" to "null","afterSegmentsJson" to source.toString(),"action" to "write","authorship" to "personal"))
                insert("drafts", mapOf("slot" to "composer","requestId" to "draft-fixture","markdown" to "未保存草稿","generation" to 7))
                insert("receipts", mapOf("requestId" to "receipt-fixture","recordId" to recordId,"status" to "applied"))
                old.version = version
            }
            val row=LibraryRegistryRow(libraryId,"Migration fixture",deviceId,databaseName,"standalone","complete",null,null,1,null,null,null,null,null,1,true,false,false,"{}")
            registry.dao().insert(row)
            val repo=LibraryRepository(context,libraryId,deviceId,row.name,registry,row);repository=repo
            assertEquals("当前正文",repo.read(recordId).markdown)
            val history=repo.dao.versions(recordId);assertEquals(2,history.size)
            for(item in history){val segments=JSONArray(item.sourcesJson);assertEquals(item.markdown,(0 until segments.length()).joinToString(""){segments.getJSONObject(it).getString("text")})}
            if(!earlyVersionOne)assertEquals("voice:synthetic",JSONArray(history.first { it.id==firstVersion }.sourcesJson).getJSONObject(0).getString("sourceRef"))
            assertNull(repo.dao.activities(recordId).single().originDeviceId)
            assertEquals("未保存草稿",repo.dao.draft("composer")!!.markdown)
            assertEquals(7L,repo.dao.draft("composer")!!.generation)
            assertEquals("applied",repo.dao.receipt("receipt-fixture")!!.status)
        } finally {
            repository?.executor?.shutdownNow();repository?.db?.close();registry.close()
            context.deleteDatabase(databaseName);context.deleteDatabase(registryName)
        }
    }
}
