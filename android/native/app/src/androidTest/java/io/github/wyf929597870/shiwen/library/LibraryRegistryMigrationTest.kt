package io.github.wyf929597870.shiwen.library

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LibraryRegistryMigrationTest {
    @Test fun versionOneRegistryUpgradePreservesRowsMarkersAndPreferences() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "registry-upgrade-${UUID.randomUUID()}"
        val databaseName = "$namespace.sqlite"
        val libraryId = UUID.randomUUID().toString()
        val deviceId = UUID.randomUUID().toString()
        val dbFile = "shiwen-library-$libraryId.sqlite"
        val oldRow = LibraryRegistryRow(libraryId, "Existing local library", deviceId, dbFile,
            "standalone", "complete", null, null, 1, "2026-11-07T01:02:03Z", "17", "17", "17",
            "manifest-marker", 9, true, true, false, "{\"wifiOnly\":true}")
        val prefs = context.getSharedPreferences("$namespace-context", Context.MODE_PRIVATE)
        val markerValue = JSONObject().put("state", "existing-marker").put("generation", 4).toString()
        var upgraded: LibraryRegistryDatabase? = null
        try {
            val oldSchema = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
                .open("io.github.wyf929597870.shiwen.library.LibraryRegistryDatabase/1.json")
                .bufferedReader().use { it.readText() }).getJSONObject("database")
            context.getDatabasePath(databaseName).parentFile!!.mkdirs()
            SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(databaseName), null).use { old ->
                val entities = oldSchema.getJSONArray("entities")
                for (i in 0 until entities.length()) {
                    old.execSQL(entities.getJSONObject(i).getString("createSql")
                        .replace("\${TABLE_NAME}", entities.getJSONObject(i).getString("tableName")))
                }
                val setup = oldSchema.getJSONArray("setupQueries")
                for (i in 0 until setup.length()) old.execSQL(setup.getString(i))
                val row = ContentValues().apply {
                    put("libraryId", oldRow.libraryId); put("name", oldRow.name); put("deviceId", oldRow.deviceId)
                    put("dbFile", oldRow.dbFile); put("role", oldRow.role); put("integrity", oldRow.integrity)
                    put("protocolVersion", oldRow.protocolVersion); put("lastSyncedAt", oldRow.lastSyncedAt)
                    put("appliedCursor", oldRow.appliedCursor); put("completeCursor", oldRow.completeCursor)
                    put("cursor", oldRow.cursor); put("manifestDigest", oldRow.manifestDigest)
                    put("pageGeneration", oldRow.pageGeneration); put("migrationP0Done", oldRow.migrationP0Done)
                    put("autoSync", oldRow.autoSync); put("backgroundSync", oldRow.backgroundSync)
                    put("syncConditionsJson", oldRow.syncConditionsJson)
                }
                old.insertOrThrow("libraries", null, row)
                old.insertOrThrow("registry_meta", null, ContentValues().apply {
                    put("key", "migration-marker"); put("value", markerValue)
                })
                old.version = 1
            }
            prefs.edit().putString("activeLibraryId", libraryId).putBoolean("userPreference", true).commit()

            val migrated = Room.databaseBuilder(context, LibraryRegistryDatabase::class.java, databaseName)
                .addMigrations(LIBRARY_REGISTRY_MIGRATION_1_2).build()
            upgraded = migrated

            assertEquals(oldRow, migrated.dao().get(libraryId))
            assertEquals(listOf(oldRow), migrated.dao().all())
            assertEquals(markerValue, migrated.dao().meta("migration-marker"))
            assertEquals(libraryId, prefs.getString("activeLibraryId", null))
            assertTrue(prefs.getBoolean("userPreference", false))
            assertTrue(migrated.dao().allRestoreReservations().isEmpty())
            val indices = buildSet {
                migrated.openHelper.readableDatabase.query("PRAGMA index_list('restore_reservations')").use { cursor ->
                    val nameIndex = cursor.getColumnIndexOrThrow("name")
                    while (cursor.moveToNext()) add(cursor.getString(nameIndex))
                }
            }
            assertTrue(indices.contains("index_restore_reservations_targetLibraryId"))
        } finally {
            upgraded?.close()
            context.deleteDatabase(databaseName)
            prefs.edit().clear().commit()
        }
    }
}
