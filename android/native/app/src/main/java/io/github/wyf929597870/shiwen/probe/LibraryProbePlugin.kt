package io.github.wyf929597870.shiwen.probe

import org.json.JSONObject

import android.net.Uri
import androidx.activity.result.ActivityResult
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicBoolean
import io.github.wyf929597870.shiwen.agent.PhoneAgent
import io.github.wyf929597870.shiwen.agent.AgentRecordActions
import io.github.wyf929597870.shiwen.agent.LocalAgentProfileStore
import io.github.wyf929597870.shiwen.agent.ModelConfigDialog
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import io.github.wyf929597870.shiwen.network.NodeConnection
import io.github.wyf929597870.shiwen.network.NodeAgentActions
import io.github.wyf929597870.shiwen.network.NodeSettingsDialog
import io.github.wyf929597870.shiwen.network.NodeManagementActions
import io.github.wyf929597870.shiwen.network.ExternalClientTokenDialog
import io.github.wyf929597870.shiwen.library.LibraryManager
import io.github.wyf929597870.shiwen.library.LibraryRepository
import io.github.wyf929597870.shiwen.library.LibraryRecord
import io.github.wyf929597870.shiwen.library.RecordEditorDraftStore
import io.github.wyf929597870.shiwen.library.LibrarySyncCoordinator
import io.github.wyf929597870.shiwen.library.LibrarySyncScheduler
import io.github.wyf929597870.shiwen.library.LibrarySyncWorkPolicy

@CapacitorPlugin(name = "LibraryProbe")
class LibraryProbePlugin : Plugin() {
    @PluginMethod fun storageInfo(call: PluginCall) = run(call) {
        JSObject(io.github.wyf929597870.shiwen.library.LibraryStorageInfo(context).read(repository).toString())
    }
    @PluginMethod fun storageClearTemporary(call: PluginCall) = run(call) {
        JSObject(io.github.wyf929597870.shiwen.library.LibraryStorageInfo(context).clearExpired().toString())
    }
    @PluginMethod fun libraryRename(call: PluginCall) = run(call) {
        val name = call.getString("name")?.trim() ?: error("LIBRARY_NAME_REQUIRED")
        require(name.length in 1..80) { "INVALID_LIBRARY_NAME" }
        libraryManager.update(libraryManager.row(repository.libraryId).copy(name = name))
        JSObject().put("libraryId", repository.libraryId).put("name", name)
    }
    private val shareInbox by lazy { io.github.wyf929597870.shiwen.library.ShareInboxStore(context) }
    @PluginMethod fun shareInboxList(call: PluginCall) = run(call) { JSObject(shareInbox.list().toString()) }
    @PluginMethod fun shareInboxDismiss(call: PluginCall) = run(call) {
        JSObject(shareInbox.dismiss(call.getString("id") ?: error("SHARE_ID_REQUIRED")).toString())
    }
    @PluginMethod fun shareInboxSave(call: PluginCall) = run(call) {
        val target = libraryManager.openLibrary(call.getString("targetLibraryId") ?: error("TARGET_LIBRARY_REQUIRED"))
        val row = shareInbox.save(call.getString("id") ?: error("SHARE_ID_REQUIRED"), target,
            call.getObject("record") ?: error("RECORD_REQUIRED"))
        JSObject().put("record", json(row, true)).put("libraryId", target.libraryId).put("syncState", row.syncState)
            .put("receipt", JSObject().put("status", "applied").put("recordId", row.id))
    }
    private val fileTransferDelegate = lazy {
        io.github.wyf929597870.shiwen.library.LibraryTransferController(activity, libraryManager, libraryExecutor) { call, intent ->
            startActivityForResult(call, intent, "fileTransferResult")
        }
    }
    private val fileTransfers by fileTransferDelegate
    override fun handleOnDestroy() {
        if (fileTransferDelegate.isInitialized()) fileTransfers.destroy()
        if (recoveryCoordinatorDelegate.isInitialized()) recoveryCoordinator.close()
        super.handleOnDestroy()
    }
    private fun beginTransfer(call: PluginCall, kind: String) = trusted({
        val admitted = generation.get()
        libraryExecutor.execute {
            try {
                val bound = currentRepository ?: libraryManager.active().also { currentRepository = it }
                check(call.getString("libraryId") == bound.libraryId && call.getLong("pageGeneration") == admitted &&
                    generation.get() == admitted) { "STALE_CONTEXT" }
                fileTransfers.start(call, bound, kind) { generation.get() == admitted && currentRepository === bound }
            } catch (error: Exception) { call.reject(error.message ?: "FILE_TRANSFER_FAILED") }
        }
    }, call)
    @PluginMethod fun markdownImport(call: PluginCall) = beginTransfer(call, "markdownImport")
    @PluginMethod fun attachmentPick(call: PluginCall) = beginTransfer(call, "attachmentPick")
    @PluginMethod fun attachmentStageDelete(call: PluginCall) = run(call) {
        val ids = call.getArray("ids") ?: org.json.JSONArray()
        val store = io.github.wyf929597870.shiwen.library.LibraryAttachmentDraftStore(context, repository.libraryId)
        for (index in 0 until ids.length()) store.delete(ids.getString(index))
        JSObject().put("deleted", ids.length())
    }
    @PluginMethod fun recordExport(call: PluginCall) = beginTransfer(call, "recordExport")
    @PluginMethod fun recordExportWithImages(call: PluginCall) = beginTransfer(call, "recordExportWithImages")
    @PluginMethod fun libraryBackupExport(call: PluginCall) = beginTransfer(call, "libraryBackupExport")
    @PluginMethod fun libraryBackupRestore(call: PluginCall) = beginTransfer(call, "libraryBackupRestore")
    @ActivityCallback private fun fileTransferResult(call: PluginCall?, result: ActivityResult) = fileTransfers.onResult(call, result)
    @PluginMethod fun recordCopy(call: PluginCall) = run(call) {
        val target = libraryManager.openLibrary(call.getString("targetLibraryId") ?: error("TARGET_LIBRARY_REQUIRED"))
        val row = io.github.wyf929597870.shiwen.library.LibraryImportExport(
            io.github.wyf929597870.shiwen.library.LibraryFileTransfer(context)).copyRecordText(repository, target,
            call.getString("id") ?: error("RECORD_ID_REQUIRED"), call.getString("requestId") ?: error("MISSING_REQUEST"))
        JSObject().put("record", json(row, true)).put("syncState", row.syncState)
            .put("receipt", JSObject().put("status", "applied").put("recordId", row.id))
    }
    @PluginMethod fun recordCopyWithImages(call: PluginCall) = run(call) {
        val target = libraryManager.openLibrary(call.getString("targetLibraryId") ?: error("TARGET_LIBRARY_REQUIRED"))
        val row = io.github.wyf929597870.shiwen.library.LibraryImageCopy.copy(repository, target,
            call.getString("id") ?: error("RECORD_ID_REQUIRED"), call.getString("requestId") ?: error("MISSING_REQUEST"))
        JSObject().put("record", JSObject().put("id", row.id).put("title", row.title)).put("libraryId", target.libraryId)
    }
    @PluginMethod fun recordShare(call: PluginCall) = shareFile(call, attachment = false, share = true)
    @PluginMethod fun attachmentOpen(call: PluginCall) = shareFile(call, attachment = true, share = false)
    @PluginMethod fun attachmentShare(call: PluginCall) = shareFile(call, attachment = true, share = true)
    @PluginMethod fun recordAttachments(call: PluginCall) = run(call) {
        val row = repository.read(call.getString("recordId") ?: error("RECORD_ID_REQUIRED"))
        JSObject().put("items", attachmentDescriptors(row))
    }
    @PluginMethod fun attachmentImageRead(call: PluginCall) = run(call) {
        val recordId = call.getString("recordId") ?: error("RECORD_ID_REQUIRED")
        val directId = call.getString("attachmentId")
        val branchId = call.getString("branchId")
        val expectedHash = call.getString("expectedHash")?.lowercase()
        val target = call.getString("sourceTarget")
        if (branchId == null) repository.read(recordId)
        else if (repository.dao.branch(branchId) == null && repository.dao.record(recordId) == null)
            error("BRANCH_ATTACHMENT_WAITING_FOR_DOWNLOAD")
        if (directId != null) require(expectedHash?.matches(Regex("[a-f0-9]{64}")) == true) { "ATTACHMENT_HASH_REQUIRED" }
        if (branchId != null) {
            require(directId != null && target == null && expectedHash != null) { "BRANCH_ATTACHMENT_CONTEXT_REQUIRED" }
            val branch = repository.dao.branch(branchId)
            branch?.let { check(it.recordId == recordId) { "ATTACHMENT_CONTEXT_MISMATCH" } }
            val branchAttachment = repository.dao.branchAttachment(branchId, directId)
            val recordAttachment = repository.dao.attachments(recordId).firstOrNull { it.id == directId }
            val selected = when {
                branchAttachment != null && branch != null -> {
                    check(branchAttachment.hash.equals(expectedHash, ignoreCase = true)) { "ATTACHMENT_HASH_MISMATCH" }
                    check(branchAttachment.downloaded) { "BRANCH_ATTACHMENT_WAITING_FOR_DOWNLOAD" }
                    null
                }
                branchAttachment != null -> error("BRANCH_ATTACHMENT_WAITING_FOR_DOWNLOAD")
                recordAttachment != null && recordAttachment.hash.equals(expectedHash, ignoreCase = true) -> {
                    check(recordAttachment.downloaded) { "ATTACHMENT_NOT_AVAILABLE" }
                    recordAttachment
                }
                else -> error("BRANCH_ATTACHMENT_WAITING_FOR_DOWNLOAD")
            }
            val bytes = if (selected == null) repository.branchAttachmentBytes(branchId, directId)
                else repository.attachmentBytes(directId)
            check(bytes.size.toLong() == (branchAttachment?.byteLength ?: selected?.byteLength) &&
                io.github.wyf929597870.shiwen.library.LibraryAttachmentDraftStore.sha256(bytes) == expectedHash) {
                "ATTACHMENT_HASH_MISMATCH"
            }
            check(bytes.size in 1..8 * 1024 * 1024) { "IMAGE_TOO_LARGE" }
            val mimeType = imageMime(bytes)
            JSObject().put("mimeType", mimeType).put("byteLength", bytes.size).put("sha256", expectedHash)
                .put("dataBase64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
        } else {
        val mappedId = if (directId == null && !target.isNullOrBlank()) {
            require(target.length <= 2048 && !target.startsWith("/") && !Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(target)) { "INVALID_IMAGE_TARGET" }
            val provenance = repository.dao.provenance(recordId)?.json?.let(::JSONObject)
            val imported = provenance?.optJSONObject("import")
            val links = imported?.optJSONArray("links") ?: org.json.JSONArray()
            val original = android.net.Uri.decode(target).substringBefore('#').replace('\\', '/')
            val base = imported?.optString("sourceName", "")?.substringBeforeLast('/', "") ?: ""
            val normalized = java.nio.file.Paths.get(base, original).normalize().toString().replace('\\', '/')
            require(!normalized.startsWith("../") && normalized != ".." && !normalized.startsWith("/")) { "INVALID_IMAGE_TARGET" }
            val matches = (0 until links.length()).map { links.getJSONObject(it) }.filter {
                it.optString("relativePath") == normalized || it.optString("relativePath") == original
            }.mapNotNull { it.optString("targetAttachmentId").takeIf { value -> value.isNotBlank() && value != "null" } }.distinct()
            matches.singleOrNull()
        } else null
        val attachmentId = directId ?: mappedId ?: error("ATTACHMENT_ID_REQUIRED")
        val attachment = (if (mappedId != null) repository.dao.allAttachments() else repository.dao.attachments(recordId)).firstOrNull { it.id == attachmentId }
            ?: error("ATTACHMENT_NOT_FOUND")
        check(attachment.downloaded) { "ATTACHMENT_NOT_AVAILABLE" }
        check(attachment.byteLength in 1..8L * 1024 * 1024) { "IMAGE_TOO_LARGE" }
        if (expectedHash != null) check(attachment.hash.equals(expectedHash, ignoreCase = true)) { "ATTACHMENT_HASH_MISMATCH" }
        val bytes = repository.attachmentBytes(attachmentId)
        check(bytes.size.toLong() == attachment.byteLength && io.github.wyf929597870.shiwen.library.LibraryAttachmentDraftStore.sha256(bytes) == attachment.hash.lowercase()) {
            "ATTACHMENT_HASH_MISMATCH"
        }
        JSObject().put("mimeType", imageMime(bytes)).put("byteLength", bytes.size).put("sha256", attachment.hash.lowercase())
            .put("dataBase64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
        }
    }
    private fun imageMime(bytes: ByteArray): String = when {
        bytes.size >= 8 && bytes.copyOfRange(0, 8).contentEquals(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)) -> "image/png"
        bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() && bytes[2] == 0xff.toByte() -> "image/jpeg"
        bytes.size >= 6 && String(bytes, 0, 6, Charsets.US_ASCII) in setOf("GIF87a", "GIF89a") -> "image/gif"
        bytes.size >= 12 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" &&
            String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
        else -> error("IMAGE_FORMAT_UNSUPPORTED")
    }
    private fun shareFile(call: PluginCall, attachment: Boolean, share: Boolean) = trusted({
        val admitted = generation.get()
        libraryExecutor.execute {
            try {
                val bound = currentRepository ?: libraryManager.active().also { currentRepository = it }
                check(call.getString("libraryId") == bound.libraryId && call.getLong("pageGeneration") == admitted &&
                    generation.get() == admitted) { "STALE_CONTEXT" }
                val files = io.github.wyf929597870.shiwen.library.LibraryFileTransfer(context)
                val english = context.getSharedPreferences("shiwen-appearance", 0).getString("language", "zh-CN") == "en"
                val intent = if (!attachment) io.github.wyf929597870.shiwen.library.LibraryImportExport(files)
                    .shareRecordIntent(bound, call.getString("id") ?: error("RECORD_ID_REQUIRED"), if (english) "Share Markdown" else "分享 Markdown")
                else {
                    val row = bound.read(call.getString("recordId") ?: error("RECORD_ID_REQUIRED"))
                    val id = call.getString("attachmentId") ?: error("ATTACHMENT_ID_REQUIRED")
                    val descriptors = org.json.JSONArray(row.attachmentDescriptorsJson)
                    val descriptor = (0 until descriptors.length()).map { descriptors.getJSONObject(it) }
                        .firstOrNull { it.optString("id") == id } ?: error("ATTACHMENT_NOT_FOUND")
                    files.attachmentIntent(descriptor.optString("name", "attachment"), descriptor.optString("mimeType"),
                        bound.attachmentBytes(id), share, if (english) "Open attachment" else "打开附件")
                }
                activity.runOnUiThread {
                    try {
                        check(generation.get() == admitted && currentRepository === bound) { "STALE_CONTEXT" }
                        activity.startActivity(intent)
                        call.resolve(JSObject().put(if (share) "shared" else "opened", true))
                    } catch (_: android.content.ActivityNotFoundException) { call.reject("NO_COMPATIBLE_APP") }
                    catch (error: Exception) { call.reject(error.message ?: "FILE_TRANSFER_FAILED") }
                }
            } catch (error: Exception) { call.reject(error.message ?: "FILE_TRANSFER_FAILED") }
        }
    }, call)
    private val generation = AtomicLong(System.currentTimeMillis())
    private val libraryManager by lazy { LibraryManager(context) }
    private val syncCoordinator by lazy { LibrarySyncCoordinator(context, libraryManager, nodeSettings) }
    private val recoveryCoordinatorDelegate = lazy { io.github.wyf929597870.shiwen.library.LibraryRecoveryCoordinator(context, libraryManager, nodeSettings, syncCoordinator) }
    private val recoveryCoordinator by recoveryCoordinatorDelegate
    @Volatile private var currentRepository: LibraryRepository? = null
    private val scopedRepository = ThreadLocal<LibraryRepository>()
    private val libraryExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val networkExecutor = java.util.concurrent.Executors.newCachedThreadPool()
    private val recordEditorDrafts by lazy { RecordEditorDraftStore(context) }
    private val repository: LibraryRepository get() = scopedRepository.get() ?: currentRepository ?: error("LIBRARY_NOT_READY")
    private val modelDialogOpen = AtomicBoolean(false)
    private val nodeSettings by lazy { NodeSettingsStore(context) }
    private val nodeAgentActions by lazy { NodeAgentActions(nodeSettings) }
    private val nodeManagementActions by lazy { NodeManagementActions(NodeConnection(nodeSettings)) }
    private val nodeSessionDrafts by lazy { io.github.wyf929597870.shiwen.network.NodeSessionDraftStore(context) }
    private val externalDialogOpen = AtomicBoolean(false)
    private val refreshingNodes = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    override fun handleOnResume() {
        super.handleOnResume()
        networkExecutor.execute {
            runCatching {
                libraryManager.all().filter { it.role == "coordinated" && it.autoSync }.forEach { row ->
                    if (LibrarySyncWorkPolicy.wifiGate(row.syncConditionsJson, LibrarySyncScheduler.onWifi(context)) == LibrarySyncWorkPolicy.WifiGate.READY)
                        runCatching { syncCoordinator.syncNow(row.libraryId, "auto") }
                }
            }
        }
    }
    private fun refreshSelectedProfile() {
        val id = runCatching { nodeSettings.list().optString("activeId") }.getOrNull()
            ?.takeUnless { it.isBlank() || it == "null" } ?: return
        if (!refreshingNodes.add(id)) return
        val reservation = NodeConnection.reserveRefresh(id)
        java.util.concurrent.CompletableFuture.runAsync {
            try {
                NodeConnection(nodeSettings).refresh(id)
            } catch (_: Exception) {
                // Offline keeps the last verified snapshot; settings reports cached/not-synced.
            } finally { reservation.close(); refreshingNodes.remove(id) }
        }
    }
    private val agent get() = PhoneAgent.get(context, repository)
    private fun trusted(block: () -> Unit, call: PluginCall) {
        activity.runOnUiThread {
            val origin = Uri.parse(bridge.webView.url ?: "")
            if (bridge.serverUrl != null || origin.scheme != "https" || origin.host != "localhost"
                || origin.port !in listOf(-1, 443)) call.reject("UNTRUSTED_PAGE") else block()
        }
    }
    @PluginMethod fun leaveApp(call: PluginCall) = trusted({
        activity.moveTaskToBack(true)
        call.resolve()
    }, call)
    private fun run(call: PluginCall, checkContext: Boolean = true, network: Boolean = false, action: () -> JSObject) {
        trusted({
            val admitted = generation.get()
            libraryExecutor.execute {
                val boundRepository = currentRepository ?: runCatching { libraryManager.active() }.getOrElse {
                    call.reject("LIBRARY_UNAVAILABLE"); return@execute
                }.also { currentRepository = it }
                if (checkContext && (call.getString("libraryId") != boundRepository.libraryId
                        || call.getLong("pageGeneration") != admitted)) { call.reject("STALE_CONTEXT"); return@execute }
                val work = Runnable {
                    scopedRepository.set(boundRepository)
                    try {
                        // Recheck at execution as bootstrap may have advanced while queued.
                        if (checkContext) check(generation.get() == admitted) { "STALE_CONTEXT" }
                        val result = action()
                        call.resolve(result)
                    } catch (error: Exception) { call.reject(error.message ?: "SAVE_FAILED") }
                    finally { scopedRepository.remove() }
                }
                if (network) networkExecutor.execute(work) else work.run()
            }
        }, call)
    }
    @PluginMethod fun bootstrap(call: PluginCall) = run(call, false) {
        io.github.wyf929597870.shiwen.library.LibraryClientArchive(context).restoreDrafts(repository)
        recoveryCoordinator // Resume unfinished recovery tasks once when the app opens.
        val next = generation.incrementAndGet()
        val context = repository.context()
        refreshSelectedProfile()
        JSObject().put("libraryId", context.libraryId).put("pageGeneration", next)
            .put("role", context.role).put("integrity", context.integrity).put("probe", false)
    }
    @PluginMethod fun libraryList(call: PluginCall) = run(call, false) {
        val activeId = repository.libraryId
        val rows = libraryManager.all().map { row -> JSObject().put("libraryId", row.libraryId).put("name", row.name)
            .put("role", row.role).put("integrity", row.integrity).put("serverId", row.serverId ?: JSONObject.NULL)
            .put("epoch", row.epoch ?: JSONObject.NULL).put("lastSyncedAt", row.lastSyncedAt ?: JSONObject.NULL)
            .put("pendingCount", libraryManager.openLibrary(row.libraryId).dao.pendingOutbox(100_000).size)
            .put("activeId", activeId == row.libraryId) }
        JSObject().put("items", JSArray(rows)).put("activeId", activeId)
    }
    @PluginMethod fun librarySelect(call: PluginCall) = run(call, false) {
        check(call.getString("expectedLibraryId") == repository.libraryId &&
            call.getLong("expectedPageGeneration") == generation.get()) { "STALE_CONTEXT" }
        val targetId = call.getString("libraryId") ?: error("LIBRARY_ID_REQUIRED")
        io.github.wyf929597870.shiwen.library.LibraryClientArchive(context).restoreDrafts(libraryManager.openLibrary(targetId))
        val selected = libraryManager.select(targetId)
        currentRepository = selected
        val next = generation.incrementAndGet()
        val context = selected.context()
        JSObject().put("libraryId", context.libraryId).put("pageGeneration", next).put("role", context.role).put("integrity", context.integrity)
    }
    @PluginMethod fun libraryCreate(call: PluginCall) = run(call, false) {
        check(call.getString("expectedLibraryId") == repository.libraryId &&
            call.getLong("expectedPageGeneration") == generation.get()) { "STALE_CONTEXT" }
        val created = libraryManager.create(call.getString("name") ?: error("LIBRARY_NAME_REQUIRED"))
        currentRepository = created
        val next = generation.incrementAndGet()
        val context = created.context()
        JSObject().put("libraryId", context.libraryId).put("pageGeneration", next).put("role", context.role).put("integrity", context.integrity)
    }
    @PluginMethod fun libraryConnect(call: PluginCall) = run(call, network = true) {
        JSObject(syncCoordinator.connect(call.getString("nodeId") ?: error("NODE_ID_REQUIRED")).toString())
    }
    @PluginMethod fun syncNow(call: PluginCall) = run(call, network = true) {
        JSObject(syncCoordinator.syncNow(repository.libraryId, call.getString("mode") ?: "manual").toString())
    }
    @PluginMethod fun syncProgress(call: PluginCall) = run(call, checkContext = false) {
        check(call.getString("boundLibraryId") == repository.libraryId &&
            call.getLong("pageGeneration") == generation.get()) { "STALE_CONTEXT" }
        val target = call.getString("targetLibraryId") ?: repository.libraryId
        JSObject(syncCoordinator.progress(target, call.getString("operationId") ?: error("OPERATION_ID_REQUIRED")).toString())
    }
    @PluginMethod fun syncStatus(call: PluginCall) = run(call) {
        JSObject(syncCoordinator.status(repository.libraryId).toString())
    }
    @PluginMethod fun librarySettingsGet(call: PluginCall) = run(call) {
        val row = libraryManager.row(repository.libraryId)
        check(LibrarySyncWorkPolicy.wifiOnlySetting(row.syncConditionsJson) != null) { "INVALID_SYNC_SETTINGS" }
        val conditions = JSONObject(row.syncConditionsJson)
        JSObject().put("libraryId", row.libraryId).put("autoSync", row.autoSync).put("backgroundSync", row.backgroundSync)
            .put("conditions", conditions)
    }
    @PluginMethod fun librarySettingsUpdate(call: PluginCall) = run(call) {
        val old = libraryManager.row(repository.libraryId)
        val auto = call.getBoolean("autoSync") ?: old.autoSync
        val background = call.getBoolean("backgroundSync") ?: old.backgroundSync
        val incomingConditions = call.getObject("conditions")
        val wifiOnly = if (incomingConditions?.has("wifiOnly") == true)
            incomingConditions.opt("wifiOnly") as? Boolean ?: error("INVALID_SYNC_SETTINGS")
        else LibrarySyncWorkPolicy.wifiOnlySetting(old.syncConditionsJson) ?: error("INVALID_SYNC_SETTINGS")
        require(!background || auto) { "BACKGROUND_SYNC_REQUIRES_AUTO_SYNC" }
        val conditions = JSONObject(old.syncConditionsJson).put("wifiOnly", wifiOnly)
        libraryManager.update(old.copy(autoSync = auto, backgroundSync = background, syncConditionsJson = conditions.toString()))
        LibrarySyncScheduler.refresh(context, LibrarySyncWorkPolicy.shouldSchedule(libraryManager.all()))
        JSObject().put("libraryId", old.libraryId).put("autoSync", auto).put("backgroundSync", background)
            .put("conditions", conditions)
    }
    @PluginMethod fun syncConflicts(call: PluginCall) = run(call) {
        val offset = call.getString("cursor")?.toIntOrNull() ?: 0
        val limit = call.getInt("limit") ?: 30
        require(offset >= 0 && limit in 1..100) { "INVALID_CONFLICT_PAGE" }
        val rows = repository.dao.conflicts(limit + 1, offset)
        val hasMore = rows.size > limit
        val items = rows.take(limit).map { conflict ->
            JSObject().put("id", conflict.id).put("recordId", conflict.recordId).put("operationId", conflict.operationId)
                .put("remoteRevision", conflict.remoteRevision ?: JSONObject.NULL).put("state", conflict.state)
                .put("createdAt", conflict.createdAt)
        }
        JSObject().put("items", JSArray(items)).put("nextCursor", if (hasMore) (offset + limit).toString() else JSONObject.NULL)
    }
    @PluginMethod fun syncConflictRead(call: PluginCall) = run(call) {
        val conflict = checkNotNull(repository.dao.conflict(call.getString("conflictId") ?: error("SYNC_CONFLICT_ID_REQUIRED"))) {
            "SYNC_CONFLICT_NOT_FOUND"
        }
        val localSnapshot = JSONObject(conflict.localJson)
        val remoteSnapshot = JSONObject(conflict.remoteJson)
        val localRecord = localSnapshot.optJSONObject("record") ?: localSnapshot.optJSONObject("payload") ?: localSnapshot
        val remoteRecord = remoteSnapshot.optJSONObject("record") ?: remoteSnapshot.optJSONObject("currentRecord") ?: remoteSnapshot
        val dto = JSObject().put("id", conflict.id).put("recordId", conflict.recordId).put("operationId", conflict.operationId)
            .put("base", JSONObject(conflict.baseJson)).put("local", localRecord).put("remote", remoteRecord)
            .put("localVersion", localSnapshot.optJSONObject("version") ?: JSONObject.NULL)
            .put("localOperation", localSnapshot.optJSONObject("operation") ?: JSONObject.NULL)
            .put("remoteVersion", remoteSnapshot.optJSONObject("currentVersion") ?: JSONObject.NULL)
            .put("remoteRevision", conflict.remoteRevision ?: JSONObject.NULL).put("state", conflict.state).put("createdAt", conflict.createdAt)
        JSObject().put("conflict", dto)
    }
    @PluginMethod fun syncConflictResolve(call: PluginCall) = run(call) {
        val conflictId = call.getString("conflictId") ?: error("SYNC_CONFLICT_ID_REQUIRED")
        val requestId = call.getString("requestId") ?: error("MISSING_REQUEST")
        val expectedRemoteRevision = call.getLong("expectedRemoteRevision") ?: error("SYNC_REMOTE_REVISION_REQUIRED")
        val conflict = checkNotNull(repository.dao.conflict(conflictId)) { "SYNC_CONFLICT_NOT_FOUND" }
        check(conflict.state == "open") { "SYNC_CONFLICT_NOT_OPEN" }
        check(conflict.remoteRevision == expectedRemoteRevision) { "CONFLICT_HEAD_CHANGED" }
        val resolution = call.getObject("resolution") ?: error("SYNC_RESOLUTION_REQUIRED")
        val kind = resolution.optString("kind")
        val remote = repository.dao.remoteHead(conflict.recordId)
        if (kind != "keep-remote") {
            check(remote?.revision == expectedRemoteRevision) { "CONFLICT_HEAD_CHANGED" }
            val storedRemote = JSONObject(conflict.remoteJson)
            val expectedHead = storedRemote.optJSONObject("currentHead") ?: storedRemote
            val expectedVersion = expectedHead.optString("versionId").takeIf { it.isNotBlank() && it != "null" }
            val expectedChange = expectedHead.optString("changeId").takeIf { it.isNotBlank() && it != "null" }
            if (expectedVersion != null) check(remote?.versionId == expectedVersion) { "CONFLICT_HEAD_CHANGED" }
            if (expectedChange != null) check(remote?.changeId == expectedChange) { "CONFLICT_HEAD_CHANGED" }
        }
        val record = when (kind) {
            "keep-remote" -> repository.resolveConflictRemote(conflictId, expectedRemoteRevision, requestId)
            "keep-local" -> {
                val currentRemote = checkNotNull(remote) { "SYNC_REMOTE_HEAD_MISSING" }
                val current = repository.read(conflict.recordId)
                val patch = JSONObject().put("title", current.title).put("markdown", current.markdown).put("kind", current.kind)
                    .put("origin", current.origin).put("processing", current.processing)
                    .put("contentDay", current.contentDay ?: JSONObject.NULL).put("dateBasis", current.dateBasis)
                    .put("url", current.url ?: JSONObject.NULL).put("annotation", current.annotation ?: JSONObject.NULL)
                    .put("stage", current.stage ?: "draft").put("sourceIds", JSArray(current.sourceIdsJson)).put("sources", JSArray(current.sourcesJson))
                    .put("attachmentDescriptors", JSArray(current.attachmentDescriptorsJson)).put("deleted", current.deleted)
                repository.update(current.id, current.revision, requestId, patch, currentRemote, "resolve", conflictId)
            }
            "merge" -> {
                val currentRemote = checkNotNull(remote) { "SYNC_REMOTE_HEAD_MISSING" }
                val incoming = resolution.optJSONObject("record") ?: error("SYNC_MERGE_RECORD_REQUIRED")
                check(incoming.optString("id") == conflict.recordId) { "SYNC_MERGE_RECORD_MISMATCH" }
                val allowed = setOf("title", "kind", "markdown", "contentDay", "dateBasis", "url", "annotation", "stage", "processing")
                val patch = JSONObject(); val keys = incoming.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    if (key in allowed) patch.put(key, incoming.get(key))
                    else if (key !in setOf("id", "origin", "sources", "sourceIds", "attachmentDescriptors", "createdAt", "updatedAt", "deleted"))
                        error("INVALID_RECORD_FIELD")
                }
                val current = repository.read(conflict.recordId)
                repository.update(current.id, current.revision, requestId, patch, currentRemote, "resolve", conflictId)
            }
            else -> error("SYNC_RESOLUTION_INVALID")
        }
        JSObject().put("record", json(record, true)).put("syncState", record.syncState)
            .put("receipt", JSObject().put("status", "applied").put("recordId", record.id))
    }
    @PluginMethod fun settingsGet(call: PluginCall) = run(call) {
        val preferences = context.getSharedPreferences("shiwen-appearance", android.content.Context.MODE_PRIVATE)
        JSObject().put("language", preferences.getString("language", "zh-CN"))
            .put("theme", preferences.getString("theme", "system"))
            .put("systemDark", (context.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES)
    }
    @PluginMethod fun settingsUpdate(call: PluginCall) = run(call) {
        val preferences = context.getSharedPreferences("shiwen-appearance", android.content.Context.MODE_PRIVATE)
        val language = call.getString("language") ?: preferences.getString("language", "zh-CN")!!
        val theme = call.getString("theme") ?: preferences.getString("theme", "system")!!
        require(language in setOf("zh-CN", "en") && theme in setOf("system", "light", "dark")) { "INVALID_APPEARANCE" }
        check(preferences.edit().putString("language", language).putString("theme", theme).commit()) { "SETTINGS_SAVE_FAILED" }
        activity.runOnUiThread { (activity as? io.github.wyf929597870.shiwen.MainActivity)?.applySystemBars() }
        JSObject().put("language", language).put("theme", theme)
            .put("systemDark", (context.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES)
    }
    @PluginMethod fun review(call: PluginCall) = run(call) {
        JSObject(io.github.wyf929597870.shiwen.library.LibraryReview(repository)
            .read(call.getString("period") ?: "7", call.getString("month")).toString())
    }
    @PluginMethod fun recordList(call: PluginCall) = run(call) {
        val offset = call.getString("cursor")?.toIntOrNull() ?: call.getInt("offset") ?: 0
        require(offset >= 0)
        val rows = repository.list(call.getString("query") ?: "", call.getString("kind"), call.getBoolean("deleted") == true,
            call.getInt("limit") ?: 30, offset, call.getString("excludeKind"))
        JSObject().put("items", JSArray(rows.map { json(it, false) }))
            .put("nextCursor", if (rows.size == (call.getInt("limit") ?: 30)) (offset + rows.size).toString() else JSONObject.NULL)
    }
    @PluginMethod fun recordRead(call: PluginCall) = run(call) { json(repository.read(call.getString("id") ?: ""), true) }
    @PluginMethod fun recordCreate(call: PluginCall) = run(call) {
        val input = call.getObject("record") ?: error("RECORD_REQUIRED")
        val generation = call.data.opt("localGeneration") as? Number ?: error("INVALID_GENERATION")
        val staged = stagedAttachments(call, input)
        val record = repository.create(call.getString("requestId") ?: error("MISSING_REQUEST"), input,
            generation.toLong(), stagedAttachments = staged)
        JSObject().put("record", json(record, true)).put("syncState", record.syncState)
            .put("receipt", JSObject().put("status", "applied").put("recordId", record.id))
    }
    @PluginMethod fun recordUpdate(call: PluginCall) = run(call) {
        val expected = call.data.opt("expectedRevision") as? Number ?: error("INVALID_REVISION")
        val patch = call.getObject("patch") ?: error("RECORD_PATCH_REQUIRED")
        val staged = stagedAttachments(call, patch)
        val record = repository.update(call.getString("id") ?: "", expected.toLong(), call.getString("requestId") ?: error("MISSING_REQUEST"),
            patch, stagedAttachments = staged)
        JSObject().put("record", json(record, true)).put("syncState", record.syncState)
    }
    @PluginMethod fun recordDelete(call: PluginCall) = run(call) {
        val expected = call.data.opt("expectedRevision") as? Number ?: error("INVALID_REVISION")
        val record = repository.remove(call.getString("id") ?: "", expected.toLong(), call.getString("requestId") ?: error("MISSING_REQUEST"))
        JSObject().put("record", json(record, true)).put("syncState", record.syncState)
    }
    @PluginMethod fun recordRestore(call: PluginCall) = run(call) {
        val expected = call.data.opt("expectedRevision") as? Number ?: error("INVALID_REVISION")
        val record = repository.update(call.getString("id") ?: "", expected.toLong(), call.getString("requestId") ?: error("MISSING_REQUEST"),
            JSONObject().put("deleted", false))
        JSObject().put("record", json(record, true)).put("syncState", record.syncState)
    }
    @PluginMethod fun recordVersions(call: PluginCall) = run(call) {
        val rows = repository.versions(call.getString("id") ?: "").map { row -> JSObject().put("id", row.id)
            .put("recordId", row.recordId).put("revision", row.revision).put("markdown", row.markdown)
            .put("title", row.title).put("createdAt", row.createdAt).put("reason", row.reason)
            .put("doc", row.docJson?.let { JSONObject(it) } ?: JSONObject.NULL) }
        JSObject().put("items", JSArray(rows))
    }
    @PluginMethod fun recordDraftRead(call: PluginCall) = run(call) {
        JSObject(recordEditorDrafts.read(repository.libraryId,
            call.getString("slot") ?: error("RECORD_DRAFT_SLOT_REQUIRED")).toString())
    }
    @PluginMethod fun recordDraftSave(call: PluginCall) = run(call) {
        val pending = call.getObject("pendingMutation")
        JSObject(recordEditorDrafts.save(repository.libraryId, call.getString("slot") ?: error("RECORD_DRAFT_SLOT_REQUIRED"),
            call.getString("requestId") ?: error("MISSING_REQUEST"), generationArg(call),
            call.getObject("content") ?: error("RECORD_DRAFT_CONTENT_REQUIRED"), pending).toString())
    }
    @PluginMethod fun recordDraftAcknowledge(call: PluginCall) = run(call) {
        JSObject(recordEditorDrafts.acknowledge(repository.libraryId, call.getString("slot") ?: error("RECORD_DRAFT_SLOT_REQUIRED"),
            call.getString("requestId") ?: error("MISSING_REQUEST"), generationArg(call)).toString())
    }
    @PluginMethod fun list(call: PluginCall) = run(call) {
        val offset = call.getInt("offset") ?: 0
        require(offset >= 0)
        val rows = repository.list(limit = 30, offset = offset)
        JSObject().put("items", JSArray(rows.map { json(it, false) })).put("nextOffset", if (rows.size == 30) offset + 30 else null)
    }
    @PluginMethod fun read(call: PluginCall) = run(call) {
        json(repository.read(call.getString("id") ?: ""), true)
    }
    private fun draft(call: PluginCall): ProbeDraft = ProbeDraft(requestId = call.getString("requestId") ?: error("MISSING_REQUEST"),
        title = call.getString("title") ?: "", markdown = call.getString("markdown") ?: "",
        kind = call.getString("kind") ?: "journal", generation = generationArg(call))
    private fun generationArg(call: PluginCall): Long {
        val value = call.data.opt("localGeneration") as? Number ?: error("INVALID_GENERATION")
        val exact = value.toDouble()
        require(exact.isFinite() && exact >= 0 && exact <= 9007199254740991.0 && exact == value.toLong().toDouble())
        return value.toLong()
    }
    @PluginMethod fun save(call: PluginCall) = run(call) {
        val draft = draft(call)
        json(repository.saveLegacyDraft(draft), false)
    }
    @PluginMethod fun receipt(call: PluginCall) = run(call) {
        val row = repository.receipt(call.getString("requestId") ?: "")
        if (row == null) JSObject().put("status", "unknown") else JSObject().put("status", row.status).put("recordId", row.recordId)
    }
    @PluginMethod fun saveDraft(call: PluginCall) = run(call) {
        val draft = draft(call); UUID.fromString(draft.requestId)
        require(draft.markdown.length <= 1_000_000 && draft.title.length <= 200 && draft.generation >= 0)
        repository.saveDraft(draft.requestId, draft.title, draft.markdown, draft.kind, draft.generation)
        JSObject().put("saved", true)
    }
    @PluginMethod fun readDraft(call: PluginCall) = run(call) {
        val d = repository.readDraft()
        if (d == null) JSObject().put("draft", null) else JSObject().put("draft", JSObject()
            .put("requestId", d.requestId).put("title", d.title).put("markdown", d.markdown)
            .put("kind", d.kind).put("localGeneration", d.generation))
    }
    @PluginMethod fun modelConfig(call: PluginCall) = run(call) {
        agent.configs.read()?.let { JSObject(it.publicJson().toString()) } ?: JSObject().put("configured", false)
    }
    @PluginMethod fun configureModel(call: PluginCall) = trusted({
        val admitted = generation.get()
        val activeRepo = currentRepository
        if (activeRepo == null || call.getString("libraryId") != activeRepo.libraryId || call.getLong("pageGeneration") != admitted) {
            call.reject("STALE_CONTEXT")
        } else if (!modelDialogOpen.compareAndSet(false, true)) call.reject("MODEL_DIALOG_OPEN")
        else libraryExecutor.execute {
            try {
                check(generation.get() == admitted) { "STALE_CONTEXT" }
                ModelConfigDialog.show(activity, PhoneAgent.get(context, activeRepo).configs, libraryExecutor) {
                    modelDialogOpen.set(false)
                    libraryExecutor.execute {
                        if (generation.get() != admitted) call.reject("STALE_CONTEXT")
                        else call.resolve(JSObject().put("closed", true))
                    }
                }
            } catch (_: Exception) {
                modelDialogOpen.set(false); call.reject("MODEL_CONFIG_UNAVAILABLE")
            }
        }
    }, call)
    @PluginMethod fun nodeList(call: PluginCall) = run(call) { JSObject(nodeSettings.list().toString()) }
    @PluginMethod fun nodeSelect(call: PluginCall) = run(call) {
        nodeSettings.select(call.getString("id")); refreshSelectedProfile(); JSObject(nodeSettings.list().toString())
    }
    @PluginMethod fun nodeRemove(call: PluginCall) = run(call) {
        nodeSettings.remove(call.getString("id") ?: ""); JSObject(nodeSettings.list().toString())
    }
    @PluginMethod fun nodeCheck(call: PluginCall) = run(call, network = true) {
        val nodeId = call.getString("id") ?: error("NODE_ID_REQUIRED")
        NodeConnection(nodeSettings).refresh(nodeId)
        val result = nodeSettings.list().put("connected", true)
        try { result.put("sync", syncCoordinator.connect(nodeId)) }
        catch (error: Exception) { result.put("syncError", error.message?.takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{0,63}")) } ?: "SYNC_START_FAILED") }
        JSObject(result.toString())
    }
    @PluginMethod fun nodeAgentState(call: PluginCall) = run(call, network = true) {
        JSObject(nodeAgentActions.state(call.getString("id") ?: error("NODE_ID_REQUIRED")).toString())
    }
    @PluginMethod fun nodeAgentDocumentSave(call: PluginCall) = run(call, network = true) {
        JSObject(nodeAgentActions.saveDocument(call.getString("id") ?: error("NODE_ID_REQUIRED"),
            call.getString("name") ?: "", call.getString("body") ?: "", call.getInt("revision") ?: -1).toString())
    }
    @PluginMethod fun nodeMemorySave(call: PluginCall) = run(call, network = true) {
        JSObject(nodeAgentActions.saveMemory(call.getString("id") ?: error("NODE_ID_REQUIRED"),
            call.getString("memoryId"), call.getString("body") ?: "", call.getString("category") ?: "",
            call.getInt("revision")).toString())
    }
    @PluginMethod fun nodeMemoryDecide(call: PluginCall) = run(call, network = true) {
        JSObject(nodeAgentActions.decideMemory(call.getString("id") ?: error("NODE_ID_REQUIRED"),
            call.getString("memoryId") ?: "", call.getInt("revision") ?: -1,
            call.getBoolean("accept") ?: error("INVALID_MEMORY_DECISION")).toString())
    }
    @PluginMethod fun nodeMemoryDelete(call: PluginCall) = run(call, network = true) {
        JSObject(nodeAgentActions.deleteMemory(call.getString("id") ?: error("NODE_ID_REQUIRED"),
            call.getString("memoryId") ?: "", call.getInt("revision") ?: -1).toString())
    }
    @PluginMethod fun agentRecordProposals(call: PluginCall) = run(call) {
        JSObject().put("items",AgentRecordActions(repository).list(call.getString("conversationId") ?: error("CONVERSATION_REQUIRED")))
    }
    @PluginMethod fun agentRecordDecide(call: PluginCall) = run(call) {
        JSObject(AgentRecordActions(repository).decide(call.getString("id") ?: error("PROPOSAL_REQUIRED"),
            call.getString("conversationId") ?: error("CONVERSATION_REQUIRED"),
            call.getBoolean("accept") ?: error("DECISION_REQUIRED")).toString())
    }
    @PluginMethod fun localProfileRead(call: PluginCall) = run(call) {
        JSObject(LocalAgentProfileStore(repository).read().toString())
    }
    @PluginMethod fun localProfileSave(call: PluginCall) = run(call) {
        JSObject(LocalAgentProfileStore(repository).save(call.getLong("expectedRevision") ?: error("REVISION_REQUIRED"),
            call.getString("identity") ?: "",call.getString("soul") ?: "",call.getString("user") ?: "").toString())
    }
    @PluginMethod fun localMemoryDecide(call: PluginCall) = run(call) {
        JSObject(LocalAgentProfileStore(repository).memory(call.getLong("expectedRevision") ?: error("REVISION_REQUIRED"),
            call.getString("id"),call.getString("body"),call.getString("action") ?: error("ACTION_REQUIRED")).toString())
    }
    @PluginMethod fun configureServerSecret(call: PluginCall) = trusted({
        if (!externalDialogOpen.compareAndSet(false, true)) call.reject("SECRET_DIALOG_OPEN")
        else try {
            val id = call.getString("id") ?: error("NODE_ID_REQUIRED")
            val configRevision = call.getString("configRevision") ?: error("NODE_REVISION_REQUIRED")
            val namespace = call.getString("ns") ?: error("INVALID_SECRET_FIELD")
            val path = call.getArray("path") ?: error("INVALID_SECRET_FIELD")
            val revision = call.getLong("expectedRevision") ?: error("INVALID_REVISION")
            io.github.wyf929597870.shiwen.network.ServerSecretDialog.show(activity,
                io.github.wyf929597870.shiwen.network.ServerSecretSettings(nodeSettings), networkExecutor,
                id, configRevision, namespace, path, revision, call.getString("language") == "en") { result ->
                externalDialogOpen.set(false); call.resolve(JSObject(result.toString()))
            }
        } catch (_: Exception) { externalDialogOpen.set(false); call.reject("SECRET_DIALOG_UNAVAILABLE") }
    }, call)
    @PluginMethod fun nodeManagement(call: PluginCall) = run(call, network = true) {
        JSObject(nodeManagementActions.manage(call.getString("id") ?: error("NODE_ID_REQUIRED"),
            call.getString("action") ?: error("NODE_MANAGEMENT_ACTION_REQUIRED"),
            call.getObject("args") ?: JSObject(), call.getString("configRevision") ?: error("NODE_CONFIG_REVISION_REQUIRED")).toString())
    }
    @PluginMethod fun nodeSessions(call: PluginCall) = run(call, network = true) {
        val nodeId = call.getString("id") ?: error("NODE_ID_REQUIRED")
        val action = call.getString("action") ?: error("NODE_SESSION_ACTION_REQUIRED")
        val args = call.getObject("args") ?: JSObject()
        JSObject(NodeConnection(nodeSettings).mobileSessions(nodeId, action, args,
            call.getString("configRevision") ?: error("NODE_CONFIG_REVISION_REQUIRED")).toString())
    }
    @PluginMethod fun nodeSessionDraftRead(call: PluginCall) = run(call) {
        val nodeId = call.getString("id") ?: error("NODE_ID_REQUIRED")
        val revision = call.getString("configRevision") ?: error("NODE_CONFIG_REVISION_REQUIRED")
        check(nodeSettings.get(nodeId).getString("configRevision") == revision) { "NODE_CHANGED" }
        nodeSessionDrafts.read(nodeId, revision, call.getString("sessionId") ?: error("NODE_SESSION_ID_REQUIRED"))
            .let { JSObject(it.toString()) }
    }
    @PluginMethod fun nodeSessionDraftSave(call: PluginCall) = run(call) {
        val nodeId = call.getString("id") ?: error("NODE_ID_REQUIRED")
        val revision = call.getString("configRevision") ?: error("NODE_CONFIG_REVISION_REQUIRED")
        check(nodeSettings.get(nodeId).getString("configRevision") == revision) { "NODE_CHANGED" }
        val draft = call.getObject("draft") ?: error("NODE_DRAFT_REQUIRED")
        nodeSessionDrafts.save(nodeId, revision, call.getString("sessionId") ?: error("NODE_SESSION_ID_REQUIRED"), draft)
            .let { JSObject(it.toString()) }
    }
    @PluginMethod fun nodeExternalStatus(call: PluginCall) = run(call, network = true) {
        JSObject(nodeManagementActions.externalStatus(call.getString("id") ?: error("NODE_ID_REQUIRED")).toString())
    }
    @PluginMethod fun nodeExternalRevoke(call: PluginCall) = run(call, network = true) {
        JSObject(nodeManagementActions.revokeExternalClient(call.getString("id") ?: error("NODE_ID_REQUIRED"),
            call.getString("clientId") ?: error("INVALID_EXTERNAL_CLIENT_ID")).toString())
    }
    @PluginMethod fun configureExternalClient(call: PluginCall) = trusted({
        val admitted = generation.get()
        val activeRepo = currentRepository
        if (activeRepo == null || call.getString("libraryId") != activeRepo.libraryId || call.getLong("pageGeneration") != admitted) {
            call.reject("STALE_CONTEXT")
        } else if (!externalDialogOpen.compareAndSet(false, true)) call.reject("EXTERNAL_DIALOG_OPEN")
        else java.util.concurrent.ForkJoinPool.commonPool().execute {
            try {
                check(generation.get() == admitted) { "STALE_CONTEXT" }
                val id = call.getString("id")?.takeIf { it.isNotBlank() } ?: error("NODE_ID_REQUIRED")
                val name = call.getString("name") ?: error("INVALID_EXTERNAL_CLIENT_NAME")
                val values = call.getArray("scopes") ?: error("INVALID_EXTERNAL_SCOPES")
                val scopes = (0 until values.length()).map { index -> values.getString(index) }
                val issued = nodeManagementActions.createExternalClientForNativeDialog(id, name, scopes)
                activity.runOnUiThread {
                    try {
                        ExternalClientTokenDialog.show(activity, issued) { displayed ->
                            externalDialogOpen.set(false)
                            val safe = nodeManagementActions.externalClientMetadata(issued)
                                .put("credentialDisplayed", displayed)
                            call.resolve(JSObject(safe.toString()))
                        }
                    } catch (_: Exception) {
                        externalDialogOpen.set(false)
                        // The server confirmed creation, so never reject in a way that invites a duplicate POST.
                        val safe = nodeManagementActions.externalClientMetadata(issued)
                            .put("credentialDisplayed", false)
                        call.resolve(JSObject(safe.toString()))
                    }
                }
            } catch (error: Exception) {
                externalDialogOpen.set(false)
                call.reject(error.message?.takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{0,63}")) } ?: "NODE_MANAGEMENT_FAILED")
            }
        }
    }, call)
    @PluginMethod fun configureNode(call: PluginCall) = trusted({
        val admitted = generation.get()
        val activeRepo = currentRepository
        if (activeRepo == null || call.getString("libraryId") != activeRepo.libraryId || call.getLong("pageGeneration") != admitted) call.reject("STALE_CONTEXT")
        else if (!modelDialogOpen.compareAndSet(false, true)) call.reject("SETTINGS_DIALOG_OPEN")
        else java.util.concurrent.ForkJoinPool.commonPool().execute {
            try {
                check(generation.get() == admitted) { "STALE_CONTEXT" }
                NodeSettingsDialog.show(activity, nodeSettings, call.getString("id"), java.util.concurrent.ForkJoinPool.commonPool()) { connectedNodeId ->
                    modelDialogOpen.set(false)
                    if (connectedNodeId == null) {
                        if (generation.get() == admitted && currentRepository === activeRepo) call.resolve(JSObject().put("closed", true))
                        else call.reject("STALE_CONTEXT")
                    } else networkExecutor.execute {
                        try {
                            check(generation.get() == admitted && currentRepository === activeRepo) { "STALE_CONTEXT" }
                            val sync = syncCoordinator.connect(connectedNodeId)
                            activity.runOnUiThread {
                                if (generation.get() == admitted && currentRepository === activeRepo)
                                    call.resolve(JSObject().put("closed", true).put("connected", true).put("sync", JSObject(sync.toString())))
                                else call.reject("STALE_CONTEXT")
                            }
                        } catch (error: Exception) {
                            val code = error.message?.takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{0,63}")) } ?: "SYNC_START_FAILED"
                            activity.runOnUiThread {
                                if (generation.get() == admitted && currentRepository === activeRepo)
                                    call.resolve(JSObject().put("closed", true).put("connected", true).put("syncError", code))
                                else call.reject("STALE_CONTEXT")
                            }
                        }
                    }
                }
            } catch (_: Exception) { modelDialogOpen.set(false); call.reject("NODE_SETTINGS_UNAVAILABLE") }
        }
    }, call)
    private fun conversation(call: PluginCall): String =
        call.getString("conversationId")?.takeIf { it.isNotBlank() && it.length <= 128 } ?: error("MISSING_CONVERSATION")
    @PluginMethod fun agentConversations(call: PluginCall) = run(call) { agent.conversations() }
    @PluginMethod fun agentCreateConversation(call: PluginCall) = run(call) {
        agent.createConversation(call.getString("id") ?: "")
    }
    @PluginMethod fun agentSelectConversation(call: PluginCall) = run(call) {
        agent.selectConversation(call.getString("id") ?: "")
    }
    @PluginMethod fun agentRecent(call: PluginCall) = run(call) {
        val offset = call.getInt("offset") ?: 0
        require(offset >= 0)
        agent.recent(conversation(call), offset)
    }
    @PluginMethod fun agentStatus(call: PluginCall) = run(call) { agent.status(call.getString("id") ?: "", conversation(call)) }
    @PluginMethod fun agentSend(call: PluginCall) = run(call) {
        agent.send(call.getString("id") ?: "", call.getString("input") ?: "",
            call.getBoolean("saveOriginal") == true, call.getString("kind") ?: "idea", call.getString("revision") ?: "", conversation(call))
    }
    @PluginMethod fun agentReadDraft(call: PluginCall) = run(call) { agent.readDraft(conversation(call)) }
    @PluginMethod fun agentSaveDraft(call: PluginCall) = run(call) {
        agent.saveDraft(call.getString("id") ?: "", call.getString("input") ?: "",
            call.getBoolean("saveOriginal") == true, call.getString("kind") ?: "idea", generationArg(call), conversation(call))
    }
    @PluginMethod fun agentAcknowledge(call: PluginCall) = run(call) {
        agent.acknowledge(call.getString("id") ?: "", generationArg(call), conversation(call))
    }
    @PluginMethod fun agentCancel(call: PluginCall) = run(call) { agent.cancel(call.getString("id") ?: "", conversation(call)) }

    // Recovery is deliberately exposed as fixed operations. The web page never chooses a
    // server method or supplies arbitrary RPC data; the coordinator enforces the node fence.
    private fun recoveryConfigRevision(call: PluginCall): String = call.data.opt("configRevision")
        ?.toString()?.takeIf { it.isNotBlank() && it != "null" } ?: error("NODE_CONFIG_REVISION_REQUIRED")
    @PluginMethod fun recoveryInspect(call: PluginCall) = run(call, network = true) {
        JSObject(recoveryCoordinator.inspect(repository.libraryId,
            call.getString("nodeId") ?: error("NODE_ID_REQUIRED"),
            recoveryConfigRevision(call)).toString())
    }
    @PluginMethod fun recoveryStart(call: PluginCall) = run(call, network = true) {
        JSObject(recoveryCoordinator.start(repository.libraryId,
            call.getString("nodeId") ?: error("NODE_ID_REQUIRED"),
            recoveryConfigRevision(call),
            call.getString("mode") ?: error("RECOVERY_MODE_REQUIRED"),
            call.getObject("expectedTarget") ?: error("RECOVERY_TARGET_REQUIRED")).toString())
    }
    @PluginMethod fun recoveryProgress(call: PluginCall) = run(call, network = true) {
        JSObject(recoveryCoordinator.progress(repository.libraryId,
            call.getString("nodeId") ?: error("NODE_ID_REQUIRED"),
            recoveryConfigRevision(call),
            call.getString("taskId") ?: error("RECOVERY_TASK_REQUIRED")).toString())
    }
    @PluginMethod fun recoveryCandidates(call: PluginCall) = run(call, network = true) {
        val cursor = call.getString("cursor")?.toIntOrNull() ?: call.getInt("cursor") ?: 0
        val limit = call.getInt("limit") ?: 20
        JSObject(recoveryCoordinator.candidates(repository.libraryId,
            call.getString("nodeId") ?: error("NODE_ID_REQUIRED"),
            recoveryConfigRevision(call),
            call.getString("taskId") ?: error("RECOVERY_TASK_REQUIRED"), cursor, limit).toString())
    }
    @PluginMethod fun recoveryBranchRead(call: PluginCall) = run(call, network = true) {
        JSObject(recoveryCoordinator.branchRead(repository.libraryId,
            call.getString("nodeId") ?: error("NODE_ID_REQUIRED"),
            recoveryConfigRevision(call),
            call.getString("taskId") ?: error("RECOVERY_TASK_REQUIRED"),
            call.getString("branchId") ?: error("RECOVERY_BRANCH_REQUIRED")).toString())
    }
    @PluginMethod fun recoveryDecide(call: PluginCall) = run(call, network = true) {
        val rawHead = call.data.opt("expectedTargetHead")
        val expectedHead = if (rawHead == null || rawHead == JSONObject.NULL) null
            else call.getObject("expectedTargetHead") ?: error("RECOVERY_TARGET_HEAD_INVALID")
        JSObject(recoveryCoordinator.decide(repository.libraryId,
            call.getString("nodeId") ?: error("NODE_ID_REQUIRED"),
            recoveryConfigRevision(call),
            call.getString("taskId") ?: error("RECOVERY_TASK_REQUIRED"),
            call.getString("branchId") ?: error("RECOVERY_BRANCH_REQUIRED"),
            call.getString("resolution") ?: error("RECOVERY_RESOLUTION_REQUIRED"),
            expectedHead).toString())
    }
    @PluginMethod fun recoveryComplete(call: PluginCall) = run(call, network = true) {
        JSObject(recoveryCoordinator.complete(repository.libraryId,
            call.getString("nodeId") ?: error("NODE_ID_REQUIRED"),
            recoveryConfigRevision(call),
            call.getString("taskId") ?: error("RECOVERY_TASK_REQUIRED")).toString())
    }

    private fun json(row: LibraryRecord, full: Boolean): JSObject = JSObject().put("id", row.id)
        .put("title", row.title).put("kind", row.kind).put("createdAt", row.createdAt)
        .put("origin", row.origin).put("contentDay", row.contentDay ?: JSONObject.NULL)
        .put("processing", row.processing).put("revision", row.revision).put("syncState", row.syncState)
        .put("state", row.syncState).put("updatedAt", row.updatedAt).put("deleted", row.deleted)
        .put("stage", row.stage ?: JSONObject.NULL).put("dateBasis", row.dateBasis)
        .apply { if (full) {
            put("markdown", row.markdown).put("url", row.url ?: JSONObject.NULL).put("annotation", row.annotation ?: JSONObject.NULL)
            put("sourceIds", JSArray(row.sourceIdsJson)).put("sources", JSArray(row.sourcesJson))
            put("attachmentDescriptors", attachmentDescriptors(row))
            put("versionId", row.versionId).put("changeId", row.changeId).put("serverRevision", row.serverRevision ?: JSONObject.NULL)
        } }
    private fun attachmentDescriptors(row: LibraryRecord): JSArray {
        val rows = repository.dao.allAttachments().associateBy { it.id }
        val source = org.json.JSONArray(row.attachmentDescriptorsJson)
        return JSArray((0 until source.length()).map { index ->
            val descriptor = JSONObject(source.getJSONObject(index).toString())
            val local = rows[descriptor.optString("id")]
            descriptor.put("available", local?.downloaded == true).put("synced", local?.uploaded == true)
        })
    }
    private fun stagedAttachments(call: PluginCall, record: JSONObject): List<io.github.wyf929597870.shiwen.library.StagedLibraryAttachment> {
        val ids = call.data.optJSONArray("stagedAttachmentIds") ?: org.json.JSONArray()
        require(ids.length() <= 10) { "TOO_MANY_IMAGES_SELECTED" }
        val descriptors = record.optJSONArray("attachmentDescriptors") ?: org.json.JSONArray()
        val byId = (0 until descriptors.length()).associate { index ->
            val descriptor = descriptors.getJSONObject(index)
            descriptor.getString("id") to descriptor.getString("name")
        }
        require(byId.size == descriptors.length()) { "ATTACHMENT_DESCRIPTOR_DUPLICATE" }
        val store = io.github.wyf929597870.shiwen.library.LibraryAttachmentDraftStore(context, repository.libraryId)
        val seen = mutableSetOf<String>()
        return (0 until ids.length()).map { index ->
            val id = ids.getString(index)
            require(seen.add(id)) { "ATTACHMENT_STAGE_DUPLICATE" }
            val name = byId[id] ?: error("ATTACHMENT_DESCRIPTOR_MISSING")
            store.read(id, name)
        }
    }
}
