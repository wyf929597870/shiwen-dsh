package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PhoneSemanticSearchTest {
    private fun withRepository(role:String, block: (LibraryRepository) -> Unit) {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val libraryId = UUID.randomUUID().toString()
        val registryFile = "semantic-fixture-registry-$libraryId.sqlite"
        val libraryFile = "semantic-fixture-library-$libraryId.sqlite"
        val registry = Room.databaseBuilder(context, LibraryRegistryDatabase::class.java, registryFile).build()
        val row = LibraryRegistryRow(libraryId, "Conflict fixture", UUID.randomUUID().toString(), libraryFile,
            role, "complete", UUID.randomUUID().toString(), UUID.randomUUID().toString(), 1,
            null, null, null, "0", null, 1, true, false, false, "{}")
        registry.dao().insert(row)
        val repo = LibraryRepository(context, libraryId, row.deviceId, row.name, registry, row)
        try { block(repo) }
        finally {
            repo.executor.shutdownNow(); repo.db.close(); registry.close()
            context.deleteDatabase(libraryFile); context.deleteDatabase(registryFile)
            java.io.File(context.filesDir, "libraries/$libraryId").deleteRecursively()
        }
    }


    @Test fun searchOfflineAfterEditDeleteAndSwitch() {
        withRepository("standalone") { repo ->
            fun input(kind: String, title: String, body: String) = JSONObject()
                .put("kind",kind).put("title",title).put("markdown",body).put("origin","personal")
                .put("id",UUID.randomUUID().toString()).put("sources",JSONArray().put(JSONObject().put("text",body).put("origin","personal")))
            val excerpt = "总想把事情留到明天，可以从半分钟内就能完成的一件小事开始。"
            val note = JSONObject().put("schema","shiwen.reading-note.v2").put("excerpts",JSONArray().put(JSONObject().put("text",excerpt)))
            val book = repo.create(UUID.randomUUID().toString(),input("reading_note","摘录","").put("annotation",note.toString()),0)
            val other = repo.create(UUID.randomUUID().toString(),input("idea","生活随记","周末想去公园看花。"),0)
            val args = JSONObject().put("query","如何克服拖延，马上着手做一点事情？")
            fun ready() {
                val until = android.os.SystemClock.elapsedRealtime() + 30000
                do {
                    val state = repo.semanticSearch.status(true)
                    check(state.optString("state") != "failed") { state.toString() }
                    if(state.optString("state") == "ready") return
                    Thread.sleep(100)
                } while(android.os.SystemClock.elapsedRealtime() < until)
                error("offline index timeout")
            }
            ready()
            val first = repo.semanticSearch.search(args).getJSONArray("items").getJSONObject(0)
            assertEquals(book.id,first.getString("recordId"))
            assertEquals(excerpt,first.getJSONObject("match").getString("text"))
            assertEquals(0,first.getJSONObject("match").getJSONObject("anchor").getInt("excerptIndex"))
            repo.remove(book.id,book.revision,UUID.randomUUID().toString())
            repo.update(other.id,other.revision,UUID.randomUUID().toString(),JSONObject().put("markdown","今天在郊外种了一棵梨树。"))
            val after = repo.semanticSearch.search(args).getJSONArray("items")
            for(i in 0 until after.length()) assertNotEquals(book.id,after.getJSONObject(i).getString("recordId"))
            val until = android.os.SystemClock.elapsedRealtime() + 30000
            var updated = ""
            do {
                val hits = repo.semanticSearch.search(JSONObject().put("query","种植果树")).getJSONArray("items")
                if(hits.length()>0) updated = hits.getJSONObject(0).getJSONObject("match").getString("text")
                if(updated.contains("梨树")) break
                Thread.sleep(100)
            } while(android.os.SystemClock.elapsedRealtime()<until)
            assertTrue(updated,updated.contains("梨树"))
            withRepository("coordinated") { empty ->
                assertEquals(0,empty.semanticSearch.search(args).getInt("total"))
                while(empty.semanticSearch.status(true).getString("state")=="indexing") Thread.sleep(50)
            }
        }
    }
}
