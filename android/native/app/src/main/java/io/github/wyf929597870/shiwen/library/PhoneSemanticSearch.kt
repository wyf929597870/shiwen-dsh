package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Rebuildable, library-specific index. A record and its vectors become visible in the same commit. */
internal class PhoneSemanticSearch(private val context: Context, private val repo: LibraryRepository) {
    private val db by lazy {
        val identity = MessageDigest.getInstance("SHA-256").digest(repo.registryItem().dbFile.toByteArray())
            .joinToString("") { "%02x".format(it) }
        val file = File(context.cacheDir, "bge-quantized-v1-$identity.sqlite")
        SQLiteDatabase.openOrCreateDatabase(file, null).apply {
            enableWriteAheadLogging()
            execSQL("CREATE TABLE IF NOT EXISTS indexed(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated TEXT NOT NULL)")
            execSQL("CREATE TABLE IF NOT EXISTS chunks(id TEXT, field TEXT, excerpt INTEGER, start INTEGER, end INTEGER, vector BLOB NOT NULL)")
            execSQL("CREATE INDEX IF NOT EXISTS chunks_by_record ON chunks(id)")
        }
    }
    private val encoder get() = PhoneBgeEncoder.get(context)
    private data class Progress(val state: String = "idle", val completed: Int = 0, val total: Int = 0, val error: String? = null)
    @Volatile private var progress = Progress()
    private var working = false
    private var lastCut = -1L
    private var lastCheck = 0L

    @Synchronized private fun schedule(retry: Boolean) {
        if (working || (progress.state == "failed" && !retry)) return
        val cut = repo.dao.discoveryCut()
        if (progress.state == "ready" && cut == lastCut && SystemClock.elapsedRealtime() - lastCheck < 60000) return
        working = true
        if (progress.state == "idle" || progress.state == "failed") progress = Progress("indexing")
        worker.execute {
            try {
                val live = repo.dao.semanticRecordStamps()
                val stored = HashMap<String, SemanticRecordStamp>()
                db.rawQuery("SELECT id,revision,updated FROM indexed", null).use { cursor ->
                    while (cursor.moveToNext()) {
                        val stamp = SemanticRecordStamp(cursor.getString(0), cursor.getLong(1), cursor.getString(2))
                        stored[stamp.id] = stamp
                    }
                }
                val pending = live.filter { stored[it.id] != it }
                val valid = live.mapTo(HashSet()) { it.id }
                db.beginTransactionNonExclusive()
                try {
                    for (id in stored.keys) if (id !in valid) remove(id)
                    db.setTransactionSuccessful()
                } finally { db.endTransaction() }
                var completed = live.size - pending.size
                if (pending.isNotEmpty()) progress = Progress("indexing", completed, live.size)
                for (stamp in pending) {
                    val row = repo.dao.record(stamp.id)
                    if (row != null && !row.deleted && row.kind != "ai_annotation") index(row)
                    progress = Progress("indexing", ++completed, live.size)
                }
                synchronized(this) {
                    lastCut = cut
                    lastCheck = SystemClock.elapsedRealtime()
                    progress = Progress("ready", completed, live.size)
                    working = false
                }
            } catch (e: Exception) {
                synchronized(this) {
                    progress = progress.copy(state = "failed", error = e.localizedMessage ?: "手机索引失败")
                    working = false
                }
            }
        }
    }

    fun status(start: Boolean, retry: Boolean = false): JSONObject {
        if (start || progress.state != "idle") schedule(retry)
        val p = progress
        return JSONObject().put("libraryScope",repo.libraryId).put("state",p.state)
            .put("canSearchSemantic",p.completed > 0 || p.state == "ready")
            .put("completed",p.completed).put("total",p.total).put("message",p.error)
    }

    private fun remove(id: String) {
        db.delete("chunks","id=?",arrayOf(id))
        db.delete("indexed","id=?",arrayOf(id))
    }

    private data class Field(val key: String, val text: String, val excerpt: Int = -1)
    private fun fields(row: LibraryRecord): List<Field> = buildList {
        add(Field("title",row.title))
        val reading = row.kind == "reading_note"
        add(Field(if (reading) "reflection" else "body",row.markdown))
        if (reading) {
            val note = runCatching { JSONObject(row.annotation.orEmpty()) }.getOrNull()
            add(Field("chapter",note?.optString("chapter").orEmpty()))
            note?.optJSONArray("excerpts")?.let { excerpts ->
                for (i in 0 until excerpts.length()) add(Field("excerpt",excerpts.optJSONObject(i)?.optString("text").orEmpty(),i))
            }
        }
    }

    private fun chunks(text: String, prefix: String, emit: (Int,Int,String) -> Unit) {
        var start = 0
        while (start < text.length) {

            // Inspect at most 384 code points, even for very large imported articles.
            var end = start
            var count = 0
            while (end < text.length && count < 384) { end += Character.charCount(text.codePointAt(end)); count++ }
            while (encoder.tokens(prefix + text.substring(start,end)).size > 512) {
                count = (count * 3 / 4).coerceAtLeast(1)
                end = text.offsetByCodePoints(start,count)
            }
            if (end < text.length && count > 192) {
                val mid = text.offsetByCodePoints(start,192)
                val boundary = (end - 1 downTo mid).firstOrNull { text[it] in "\n。！？!?；;" } ?: -1
                if (boundary >= mid) end = boundary + 1
            }
            val passage = text.substring(start,end)
            if (passage.isNotBlank()) emit(start,end,prefix + passage)
            if (end == text.length) break
            start = text.offsetByCodePoints(end,-minOf(32,text.codePointCount(start,end)-1))
        }
    }

    private fun index(row: LibraryRecord) {
        val prefix = row.title.substring(0,row.title.offsetByCodePoints(0,minOf(32,row.title.codePointCount(0,row.title.length)))) + "\n"
        db.beginTransactionNonExclusive()
        try {
            remove(row.id)
            db.compileStatement("INSERT INTO chunks VALUES(?,?,?,?,?,?)").use { insert ->
                for (field in fields(row)) chunks(field.text,if (field.key == "title") "" else prefix) { start,end,input ->
                    val vector = encoder.embed(input)
                    val blob = ByteBuffer.allocate(vector.size * 4).order(ByteOrder.LITTLE_ENDIAN)
                    blob.asFloatBuffer().put(vector)
                    insert.bindString(1,row.id); insert.bindString(2,field.key); insert.bindLong(3,field.excerpt.toLong())
                    insert.bindLong(4,start.toLong()); insert.bindLong(5,end.toLong()); insert.bindBlob(6,blob.array())
                    insert.executeInsert()
                }
            }
            db.execSQL("INSERT INTO indexed VALUES(?,?,?)",arrayOf(row.id,row.revision,row.updatedAt))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    private data class Hit(val id: String,val score: Float,val field: String,val excerpt: Int,val start: Int,val end: Int,
                           val revision: Long,val updated: String)

    fun search(args: JSONObject): JSONObject {
        val query = args.getString("query").trim()
        val limit = args.optInt("limit",20)
        val offset = args.optInt("offset",0)
        require(query.length in 1..2000 && limit in 1..100 && offset in 0..1000000)
        schedule(false)
        val live = repo.dao.semanticRecordStamps().associateBy { it.id }
        val best = HashMap<String,Hit>()
        if (live.isNotEmpty()) {
            val target = encoder.embed("为这个句子生成表示以用于检索相关文章：" + query)
            // Keep each native cursor below CursorWindow size so scanning stays linear as the library grows.
            val high = db.rawQuery("SELECT COALESCE(MAX(rowid),0) FROM chunks",null).use { it.moveToFirst(); it.getLong(0) }
            var after = 0L
            val sql = "SELECT c.id,c.field,c.excerpt,c.start,c.end,c.vector,i.revision,i.updated,c.rowid FROM chunks c JOIN indexed i ON c.id=i.id WHERE c.rowid>? AND c.rowid<=? ORDER BY c.rowid LIMIT 160"
            while (after < high) {
                val previous = after
                db.rawQuery(sql,arrayOf(after.toString(),high.toString())).use { cursor ->
                    while (cursor.moveToNext()) {
                        after = cursor.getLong(8)
                        val id = cursor.getString(0)
                        val stamp = live[id] ?: continue
                        if (stamp.revision != cursor.getLong(6) || stamp.updatedAt != cursor.getString(7)) continue
                        val vector = ByteBuffer.wrap(cursor.getBlob(5)).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
                        var score = 0f
                        for (v in target) score += v * vector.get()
                        if (score > (best[id]?.score ?: Float.NEGATIVE_INFINITY))
                            best[id] = Hit(id,score,cursor.getString(1),cursor.getInt(2),cursor.getInt(3),cursor.getInt(4),stamp.revision,stamp.updatedAt)
                    }
                }
                if (after == previous) break
            }
        }
        val page = best.values.sortedWith(compareByDescending<Hit> { it.score }.thenBy { it.id }).drop(offset).take(limit)
        val items = JSONArray()
        for (hit in page) {
            val row = repo.dao.record(hit.id) ?: continue
            if (row.deleted || row.revision != hit.revision || row.updatedAt != hit.updated) continue
            val field = fields(row).firstOrNull { it.key == hit.field && it.excerpt == hit.excerpt } ?: continue
            val anchor = JSONObject().put("start",hit.start).put("end",hit.end)
            if (hit.excerpt >= 0) anchor.put("excerptIndex",hit.excerpt)
            val match = JSONObject().put("field",hit.field).put("anchor",anchor).put("text",field.text.substring(hit.start,hit.end))
            items.put(JSONObject().put("recordId",row.id).put("revision",row.revision).put("kind",row.kind)
                .put("origin",row.origin).put("contentDay",row.contentDay).put("title",row.title).put("match",match))
        }
        return JSONObject().put("libraryScope",repo.libraryId).put("items",items).put("total",best.size)
            .put("nextOffset",if (offset+limit < best.size) offset+limit else JSONObject.NULL)
    }

    companion object {
        private val worker = Executors.newSingleThreadExecutor { job ->
            Thread({ android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); job.run() }, "shiwen-bge-index")
        }
    }
}
