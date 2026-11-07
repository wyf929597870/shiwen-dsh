package io.github.wyf929597870.shiwen.library

import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.json.JSONObject
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicReference

/** One native document picker at a time, bound to the library selected when it was opened. */
internal class LibraryTransferController(
    private val activity: Activity,
    private val manager: LibraryManager,
    private val executor: Executor,
    private val launch: (PluginCall, Intent) -> Unit,
) {
    private val files = LibraryFileTransfer(activity)
    private val transfer = LibraryImportExport(files)
    private data class Pending(val call: PluginCall, val repo: LibraryRepository, val kind: String,
        val valid: () -> Boolean, var document: LibraryExportDocument? = null, var encrypted: Boolean = false)
    private val pending = AtomicReference<Pending?>()

    fun start(call: PluginCall, repo: LibraryRepository, kind: String, valid: () -> Boolean) {
        if (kind == "libraryBackupRestore") {
            val requestId = call.getString("requestId") ?: error("RESTORE_REQUEST_ID_REQUIRED")
            runCatching { java.util.UUID.fromString(requestId) }.getOrElse { error("INVALID_RESTORE_REQUEST_ID") }
        }
        val task = Pending(call, repo, kind, valid)
        check(pending.compareAndSet(null, task)) { "FILE_TRANSFER_BUSY" }
        when (kind) {
            "markdownImport" -> picker(task, files.markdownImportIntent())
            "libraryBackupRestore" -> picker(task, files.backupImportIntent().putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
            "recordExport" -> work(task) {
                task.document = transfer.exportRecord(repo, call.getString("id") ?: error("RECORD_ID_REQUIRED"))
                val doc = task.document!!
                picker(task, files.createDocumentIntent(doc.fileName, doc.mimeType))
            }
            "libraryBackupExport" -> LibraryArchivePasswordDialog.chooseExport(activity, language()) { choice ->
                if (choice == null) cancel(task) else work(task, cleanup = { choice.password?.fill('\u0000') }) {
                    task.encrypted = choice.encrypted
                    val includeConversations = call.getBoolean("includeConversations") != false
                    val bytes = if (choice.encrypted) transfer.createEncryptedBackup(repo, choice.password!!, includeConversations)
                        else transfer.createBackup(repo, includeConversations)
                    val name = "shiwen-${repo.libraryId.take(8)}-${java.time.LocalDate.now()}" +
                        if (choice.encrypted) ".shiwen" else ".zip"
                    task.document = LibraryExportDocument(name,
                        if (choice.encrypted) "application/octet-stream" else "application/zip", bytes)
                    picker(task, files.createDocumentIntent(name, task.document!!.mimeType))
                }
            }
            else -> fail(task, "UNKNOWN_FILE_TRANSFER")
        }
    }

    fun onResult(call: PluginCall?, result: ActivityResult) {
        val task = pending.get()
        if (task == null || task.call.callbackId != call?.callbackId) {
            call?.reject("TRANSFER_INTERRUPTED"); return
        }
        if (result.resultCode != Activity.RESULT_OK) { cancel(task); return }
        work(task) {
            val uris = files.selectedUris(result.data)
            check(uris.isNotEmpty()) { "DOCUMENT_UNAVAILABLE" }
            when (task.kind) {
                "markdownImport" -> {
                    val rows = JSArray(); val failures = JSArray()
                    for ((index, uri) in uris.withIndex()) {
                        check(task.valid()) { "STALE_CONTEXT" }
                        try {
                            val row = transfer.importMarkdown(task.repo, uri)
                            rows.put(JSObject().put("id", row.id).put("title", row.title)
                                .put("contentDay", row.contentDay ?: JSONObject.NULL))
                        } catch (error: Exception) {
                            failures.put(JSObject().put("index", index).put("code", safeCode(error)))
                        }
                    }
                    succeed(task, JSObject().put("imported", rows.length()).put("skipped", failures.length())
                        .put("records", rows).put("failures", failures))
                }
                "recordExport", "libraryBackupExport" -> {
                    require(uris.size == 1) { "SELECT_ONE_DOCUMENT" }
                    files.writeUri(uris.single(), task.document?.bytes ?: error("TRANSFER_INTERRUPTED"))
                    succeed(task, JSObject().put("exported", true).put("encrypted", task.encrypted))
                }
                "libraryBackupRestore" -> {
                    require(uris.size == 1) { "SELECT_ONE_DOCUMENT" }
                    val bytes = files.readUri(uris.single(), LibraryFileTransfer.MAX_TRANSFER_BYTES)
                    if (LibraryArchiveCrypto.isEncrypted(bytes)) {
                        LibraryArchivePasswordDialog.requestRestorePassword(activity, language()) { password ->
                            if (password == null) cancel(task) else work(task, cleanup = { password.fill('\u0000') }) {
                                restore(task, bytes, password)
                            }
                        }
                    } else restore(task, bytes, null)
                }
            }
        }
    }

    private fun restore(task: Pending, bytes: ByteArray, password: CharArray?) {
        val language = activity.getSharedPreferences("shiwen-appearance", 0).getString("language", "zh-CN")
        val restored = transfer.restoreBackup(manager, bytes,
            task.call.getString("name")?.takeIf { it.isNotBlank() } ?: if (language == "en") "Restored library" else "恢复的资料库", password,
            asNewLibrary = task.call.getBoolean("asNewLibrary") == true,
            requestId = task.call.getString("requestId") ?: error("RESTORE_REQUEST_ID_REQUIRED"))
        succeed(task, JSObject().put("restored", true).put("libraryId", restored.libraryId).put("name", restored.name)
            .put("requestId", restored.requestId)
            .put("recordCount", restored.restored).put("attachments", restored.attachments)
            .put("sourceLibraryId", restored.sourceLibraryId).put("role", restored.role).put("integrity", restored.integrity))
    }

    private fun picker(task: Pending, intent: Intent) = activity.runOnUiThread {
        try { checkActive(task); launch(task.call, intent) } catch (error: Exception) { fail(task, safeCode(error)) }
    }
    private fun work(task: Pending, cleanup: () -> Unit = {}, block: () -> Unit) {
        try {
            executor.execute {
                try { checkActive(task); block() } catch (error: Exception) { fail(task, safeCode(error)) }
                finally { cleanup() }
            }
        } catch (error: Exception) {
            // Activity shutdown may reject a queued password callback before it starts.
            cleanup()
            fail(task, safeCode(error))
        }
    }
    private fun checkActive(task: Pending) {
        check(pending.get() === task && !activity.isDestroyed && !activity.isFinishing) { "TRANSFER_INTERRUPTED" }
        check(task.valid()) { "STALE_CONTEXT" }
    }
    private fun cancel(task: Pending) = succeed(task, JSObject().put("cancelled", true).put("exported", false).put("restored", false))
    private fun succeed(task: Pending, result: JSObject) {
        if (pending.compareAndSet(task, null)) { task.document = null; task.call.resolve(result) }
    }
    private fun fail(task: Pending, code: String) {
        if (pending.compareAndSet(task, null)) { task.document = null; task.call.reject(code) }
    }
    fun destroy() { pending.get()?.let { fail(it, "TRANSFER_INTERRUPTED") } }
    private fun language() = activity.getSharedPreferences("shiwen-appearance", 0).getString("language", "zh-CN") ?: "zh-CN"
    private fun safeCode(error: Exception): String = error.message?.takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{1,100}")) }
        ?: "FILE_TRANSFER_FAILED"
}
