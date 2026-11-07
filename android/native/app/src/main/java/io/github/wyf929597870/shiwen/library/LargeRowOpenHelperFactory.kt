package io.github.wyf929597870.shiwen.library

import android.database.Cursor
import android.database.CursorWindow
import android.database.sqlite.SQLiteCursor
import android.os.CancellationSignal
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.SupportSQLiteQuery
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory

/** Legal near-limit Markdown can occupy several UTF-8 columns in one record/version/conflict row.
 * API 28 public CursorWindow sizing keeps this bounded without reflection or global overrides.
 * Memory grows with rows up to the cap: https://developer.android.com/reference/android/database/CursorWindow
 */
internal class LargeRowOpenHelperFactory : SupportSQLiteOpenHelper.Factory {
    override fun create(configuration: SupportSQLiteOpenHelper.Configuration): SupportSQLiteOpenHelper {
        val original = configuration.callback
        val callback = object : SupportSQLiteOpenHelper.Callback(original.version) {
            override fun onConfigure(db: SupportSQLiteDatabase) = original.onConfigure(Database(db))
            override fun onCreate(db: SupportSQLiteDatabase) = original.onCreate(Database(db))
            override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = original.onUpgrade(Database(db), oldVersion, newVersion)
            override fun onDowngrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = original.onDowngrade(Database(db), oldVersion, newVersion)
            override fun onOpen(db: SupportSQLiteDatabase) = original.onOpen(Database(db))
            override fun onCorruption(db: SupportSQLiteDatabase) = original.onCorruption(Database(db))
        }
        val options = SupportSQLiteOpenHelper.Configuration.builder(configuration.context).name(configuration.name)
            .callback(callback).noBackupDirectory(configuration.useNoBackupDirectory)
            .allowDataLossOnRecovery(configuration.allowDataLossOnRecovery).build()
        val helper = FrameworkSQLiteOpenHelperFactory().create(options)
        return object : SupportSQLiteOpenHelper by helper {
            override val writableDatabase: SupportSQLiteDatabase get() = Database(helper.writableDatabase)
            override val readableDatabase: SupportSQLiteDatabase get() = Database(helper.readableDatabase)
        }
    }
    private class Database(private val original: SupportSQLiteDatabase) : SupportSQLiteDatabase by original {
        override fun query(query: String): Cursor = sized(original.query(query))
        override fun query(query: String, bindArgs: Array<out Any?>): Cursor = sized(original.query(query, bindArgs))
        override fun query(query: SupportSQLiteQuery): Cursor = sized(original.query(query))
        override fun query(query: SupportSQLiteQuery, cancellationSignal: CancellationSignal?): Cursor = sized(original.query(query, cancellationSignal))
        private fun sized(cursor: Cursor): Cursor {
            try {
                if (cursor is SQLiteCursor) cursor.window = CursorWindow("shiwen-library", MAX_WINDOW_BYTES)
                return cursor
            } catch (error: Throwable) { cursor.close(); throw error }
        }
    }
    companion object { private const val MAX_WINDOW_BYTES = 64L * 1024 * 1024 }
}
