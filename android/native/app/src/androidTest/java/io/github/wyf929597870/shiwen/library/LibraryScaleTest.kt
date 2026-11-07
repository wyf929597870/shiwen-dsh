package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.os.Bundle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import kotlin.system.measureNanoTime

/** Opt-in benchmark on an isolated library; never changes or enumerates the user's records. */
@RunWith(AndroidJUnit4::class)
class LibraryScaleTest {
    @Test fun tenThousandHistoricalRecordsRemainSearchableAndLargeBodyReadsFully() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("runScale") == "true")
        val context = ApplicationProvider.getApplicationContext<Context>()
        val namespace = "scale-${UUID.randomUUID()}"
        val manager = LibraryManager(context, namespace, "$namespace-legacy")
        val repo = manager.create("Synthetic scale fixture")
        try {
            val text = "完整历史资料无需依赖服务器。".repeat(20)
            val prototype = repo.create(UUID.randomUUID().toString(), JSONObject().put("title", "历史素材 00000")
                .put("kind", "journal").put("markdown", text).put("origin", "personal").put("processing", "original")
                .put("contentDay", "2020-03-01"), 1)
            val version = repo.versions(prototype.id).single()
            repo.db.runInTransaction {
                for (i in 1 until 10_000) {
                    val id = UUID(0, i.toLong()).toString(); val versionId = UUID(1, i.toLong()).toString()
                    val record = prototype.copy(id = id, title = "历史素材 ${i.toString().padStart(5, '0')}", versionId = versionId,
                        changeId = UUID(2, i.toLong()).toString())
                    repo.dao.insertRecord(record)
                    repo.dao.putHead(LibraryHead(id, 1, versionId, record.changeId, false))
                    repo.dao.insertVersion(version.copy(id = versionId, recordId = id, title = record.title, changeId = record.changeId))
                }
            }
            val largeText = "长篇内容甲".repeat(200_000)
            val large = repo.create(UUID.randomUUID().toString(), JSONObject().put("title", "Near-limit text")
                .put("kind", "article").put("markdown", largeText).put("origin", "personal").put("processing", "original"), 1)
            var pageTime = 0L; var readTime = 0L; var searchTime = 0L
            pageTime = measureNanoTime { assertEquals(30, repo.list(limit = 30).size) }
            readTime = measureNanoTime { assertEquals(largeText, repo.read(large.id).markdown) }
            searchTime = measureNanoTime { assertEquals(1, repo.list(query = "历史素材 09999").size) }
            assertEquals(10_001, repo.dao.recordCount())
            assertTrue("Local page exceeded one second", pageTime < 1_000_000_000)
            assertTrue("Local text read exceeded 300 ms", readTime < 300_000_000)
            val result = Bundle().apply {
                putLong("recordCount", 10_001); putLong("largeCharacters", largeText.length.toLong())
                putLong("pageMs", pageTime / 1_000_000); putLong("bodyReadMs", readTime / 1_000_000)
                putLong("searchMs", searchTime / 1_000_000)
            }
            InstrumentationRegistry.getInstrumentation().sendStatus(2, result)
        } finally {
            manager.closeForTest(); context.deleteDatabase("shiwen-library-${repo.libraryId}.sqlite")
        }
    }
}
