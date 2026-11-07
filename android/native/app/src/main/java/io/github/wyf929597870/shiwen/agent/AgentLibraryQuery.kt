package io.github.wyf929597870.shiwen.agent

import io.github.wyf929597870.shiwen.library.LibraryRepository
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

internal class AgentLibraryQuery(private val repo: LibraryRepository) {
    fun byDate(start: String, end: String, offset: Int = 0, limit: Int = 20): JSONObject {
        val from = LocalDate.parse(start); val through = LocalDate.parse(end)
        require(!through.isBefore(from) && offset >= 0 && limit in 1..200) { "INVALID_DATE_QUERY" }
        val db = repo.db.openHelper.readableDatabase
        val count = db.query("SELECT COUNT(*) FROM records WHERE deleted=0 AND contentDay>=? AND contentDay<=?", arrayOf(start,end)).use { cursor ->
            cursor.moveToFirst();cursor.getLong(0)
        }
        val items = JSONArray()
        db.query("SELECT id,title,kind,origin,contentDay,dateBasis FROM records WHERE deleted=0 AND contentDay>=? AND contentDay<=? ORDER BY contentDay DESC,updatedAt DESC,id ASC LIMIT ? OFFSET ?", arrayOf<Any>(start,end,limit,offset)).use { cursor ->
            while (cursor.moveToNext()) items.put(JSONObject().put("id",cursor.getString(0)).put("title",cursor.getString(1))
                .put("kind",cursor.getString(2)).put("origin",cursor.getString(3)).put("contentDay",cursor.getString(4)).put("dateBasis",cursor.getString(5)))
        }
        return JSONObject().put("libraryId",repo.libraryId).put("start",start).put("end",end).put("count",count)
            .put("records",items).put("nextCursor",if(offset+items.length()<count) (offset+items.length()).toString() else JSONObject.NULL)
            .put("truncated",offset+items.length()<count).put("integrity",repo.context().integrity)
    }
}
