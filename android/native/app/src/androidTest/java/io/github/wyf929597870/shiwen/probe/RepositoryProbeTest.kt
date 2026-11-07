package io.github.wyf929597870.shiwen.probe

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class RepositoryProbeTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private fun draft(generation: Long = 1) = ProbeDraft(requestId = UUID.randomUUID().toString(),
        title = "日记", markdown = "# 原文\r\n🌱 é\n", kind = "journal", generation = generation)
    private fun count(repository: ProbeRepository, table: String): Int = repository.db.openHelper.readableDatabase
        .query("SELECT count(*) FROM $table").use { it.moveToFirst(); it.getInt(0) }
    private fun cleanup(namespace: String, repository: ProbeRepository) {
        repository.db.close(); repository.executor.shutdown()
        context.deleteDatabase("$namespace-${repository.libraryId}.sqlite")
        context.deleteSharedPreferences("$namespace-installation")
    }
    @Test fun savingAndReopeningRetainsReceiptWithoutDuplicatingActivity() {
        val name = "p0-test-${UUID.randomUUID()}"
        var repository = ProbeRepository(context, name)
        try {
            val request = draft()
            val saved = repository.save(request)
            repository.db.close(); repository.executor.shutdown()
            repository = ProbeRepository(context, name)
            assertEquals(saved, repository.save(request))
            assertEquals(1, count(repository, "records")); assertEquals(1, count(repository, "activities"))
            assertEquals(1, count(repository, "receipts"))
            assertEquals(request.markdown, repository.db.dao().record(saved.id)?.markdown)
            assertTrue(runCatching { repository.save(request.copy(markdown = "changed")) }.isFailure)
        } finally { cleanup(name, repository) }
    }
    @Test fun oldAcknowledgementDoesNotClearANewerDraft() {
        val name = "p0-test-${UUID.randomUUID()}"
        val repository = ProbeRepository(context, name)
        try {
            val request = draft()
            val successor = request.copy(generation = 2, markdown = request.markdown + "后续文字")
            repository.db.dao().putDraft(successor)
            repository.save(request)
            assertEquals(successor, repository.db.dao().draft())
        } finally { cleanup(name, repository) }
    }
    @Test fun failedReceiptRollsBackRecordAndActivity() {
        val name = "p0-test-${UUID.randomUUID()}"
        val repository = ProbeRepository(context, name) { error("injected failure") }
        try {
            val request = draft(); repository.db.dao().putDraft(request)
            assertTrue(runCatching { repository.save(request) }.isFailure)
            for (table in listOf("records", "activities", "receipts")) assertEquals(0, count(repository, table))
            assertEquals(request, repository.db.dao().draft())
        } finally { cleanup(name, repository) }
    }
}
