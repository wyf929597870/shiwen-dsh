package io.github.wyf929597870.shiwen.library

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.UUID

/** SAF and FileProvider primitives for library transfer. It never exposes filesystem paths to JS. */
internal class LibraryFileTransfer(context: Context) {
    private val app = context.applicationContext
    internal val appContext: Context get() = app

    fun markdownImportIntent(): Intent = openDocumentIntent(
        mimeTypes = arrayOf("text/markdown", "text/plain", "text/x-markdown")
    )

    fun imageImportIntent(): Intent = openDocumentIntent(
        mimeTypes = arrayOf("image/png", "image/jpeg", "image/webp", "image/gif")
    )

    fun backupImportIntent(): Intent = openDocumentIntent(
        mimeTypes = arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream")
    )

    fun createDocumentIntent(fileName: String, mimeType: String): Intent {
        require(mimeType in EXPORT_MIME_TYPES) { "TRANSFER_MIME_NOT_ALLOWED" }
        return Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, safeFileName(fileName))
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    fun selectedUris(result: Intent?): List<Uri> {
        if (result == null) return emptyList()
        val found = LinkedHashSet<Uri>()
        result.data?.let(found::add)
        result.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(found::add)
        }
        require(found.size <= MAX_SELECTED_FILES) { "TOO_MANY_FILES_SELECTED" }
        require(found.all { it.scheme == "content" }) { "INVALID_DOCUMENT_URI" }
        return found.toList()
    }

    fun displayName(uri: Uri): String {
        require(uri.scheme == "content") { "INVALID_DOCUMENT_URI" }
        val name = app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        } ?: uri.lastPathSegment.orEmpty()
        return safeFileName(name)
    }

    @Throws(IOException::class)
    fun readUri(uri: Uri, maxBytes: Long): ByteArray {
        require(uri.scheme == "content") { "INVALID_DOCUMENT_URI" }
        require(maxBytes in 1..MAX_TRANSFER_BYTES) { "INVALID_TRANSFER_LIMIT" }
        val input = app.contentResolver.openInputStream(uri) ?: error("DOCUMENT_UNAVAILABLE")
        input.use { source ->
            val sink = ByteArrayOutputStream(minOf(maxBytes, 64 * 1024L).toInt())
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var total = 0L
            while (true) {
                val count = source.read(buffer)
                if (count < 0) break
                total += count
                require(total <= maxBytes) { "TRANSFER_TOO_LARGE" }
                sink.write(buffer, 0, count)
            }
            return sink.toByteArray()
        }
    }

    @Throws(IOException::class)
    fun writeUri(uri: Uri, bytes: ByteArray) {
        require(uri.scheme == "content") { "INVALID_DOCUMENT_URI" }
        require(bytes.size.toLong() <= MAX_TRANSFER_BYTES) { "TRANSFER_TOO_LARGE" }
        val output = app.contentResolver.openOutputStream(uri, "wt") ?: error("DOCUMENT_UNAVAILABLE")
        output.use { stream ->
            stream.write(bytes)
            stream.flush()
        }
    }

    /** Returns a chooser intent; the content URI stays native and is never returned to the WebView. */
    fun shareIntent(fileName: String, mimeType: String, bytes: ByteArray, chooserTitle: String): Intent {
        require(mimeType in EXPORT_MIME_TYPES) { "TRANSFER_MIME_NOT_ALLOWED" }
        require(bytes.size.toLong() <= MAX_TRANSFER_BYTES) { "TRANSFER_TOO_LARGE" }
        val dir = File(app.cacheDir, SHARE_CACHE_DIR).apply {
            if (!exists() && !mkdirs()) error("SHARE_CACHE_UNAVAILABLE")
        }
        val target = writeShareCacheFile(dir, fileName, bytes)
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", target)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newUri(app.contentResolver, target.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return Intent.createChooser(send, chooserTitle).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    /** Safe native-only open/share for an attachment. Only a read-only FileProvider URI is granted. */
    fun attachmentIntent(fileName: String, mimeType: String, bytes: ByteArray, share: Boolean, title: String): Intent {
        require(bytes.size.toLong() <= MAX_TRANSFER_BYTES) { "TRANSFER_TOO_LARGE" }
        val safeMime = safeAttachmentMime(mimeType)
        val dir = File(app.cacheDir, SHARE_CACHE_DIR).apply {
            if (!exists() && !mkdirs()) error("SHARE_CACHE_UNAVAILABLE")
        }
        val target = writeShareCacheFile(dir, fileName, bytes)
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", target)
        val action = if (share) Intent(Intent.ACTION_SEND) else Intent(Intent.ACTION_VIEW)
        val intent = Intent(action).apply {
            type = safeMime
            if (share) putExtra(Intent.EXTRA_STREAM, uri) else setDataAndType(uri, safeMime)
            clipData = ClipData.newUri(app.contentResolver, target.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return Intent.createChooser(intent, title).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    private fun writeShareCacheFile(dir: File, fileName: String, bytes: ByteArray): File {
        cleanupExpiredShareCache(dir)
        val safeName = safeFileName(fileName)
        val target = File(dir, "${UUID.randomUUID()}-$safeName")
        target.outputStream().buffered().use { it.write(bytes) }
        return target
    }

    internal fun cleanupExpiredShareCache(dir: File = File(app.cacheDir, SHARE_CACHE_DIR), nowMillis: Long = System.currentTimeMillis()): Long {
        if (!dir.isDirectory) return 0L
        var removedBytes = 0L
        dir.listFiles()?.forEach { file ->
            if (file.isFile && nowMillis - file.lastModified() >= SHARE_CACHE_TTL_MILLIS) {
                val length = file.length()
                if (runCatching { file.delete() }.getOrDefault(false)) removedBytes += length
            }
        }
        return removedBytes
    }

    private fun openDocumentIntent(mimeTypes: Array<String>): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes)
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    private fun safeFileName(value: String): String {
        val leaf = value.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[^\\p{L}\\p{N}._() -]"), "_")
            .trim().trim('.')
        require(leaf.isNotBlank() && leaf.length <= MAX_FILE_NAME_LENGTH) { "INVALID_FILE_NAME" }
        return leaf
    }

    private fun safeAttachmentMime(value: String): String {
        val mime = value.substringBefore(';').trim().lowercase()
        return when {
            mime in setOf("text/plain", "text/markdown", "application/pdf") -> mime
            mime.startsWith("image/") && mime in ALLOWED_IMAGES -> mime
            mime.startsWith("audio/") && mime in ALLOWED_AUDIO -> mime
            mime.startsWith("video/") && mime in ALLOWED_VIDEO -> mime
            else -> "application/octet-stream"
        }
    }

    companion object {
        const val MAX_MARKDOWN_BYTES = 16L * 1024 * 1024
        // Current repository transfer APIs materialize archive bytes in memory. Refuse larger
        // archives explicitly until the streaming repository path is available.
        const val MAX_BACKUP_BYTES = 64L * 1024 * 1024
        const val MAX_TRANSFER_BYTES = MAX_BACKUP_BYTES + 64
        internal const val SHARE_CACHE_TTL_MILLIS = 24L * 60 * 60 * 1000
        private const val MAX_SELECTED_FILES = 100
        private const val MAX_FILE_NAME_LENGTH = 180
        private const val SHARE_CACHE_DIR = "shiwen-transfers"
        private val EXPORT_MIME_TYPES = setOf("text/markdown", "application/zip", "application/octet-stream")
        private val ALLOWED_IMAGES = setOf("image/png","image/jpeg","image/gif","image/webp","image/heic","image/heif","image/avif")
        private val ALLOWED_AUDIO = setOf("audio/mpeg","audio/mp4","audio/aac","audio/ogg","audio/wav","audio/webm","audio/flac")
        private val ALLOWED_VIDEO = setOf("video/mp4","video/webm","video/quicktime","video/ogg","video/mpeg")
    }
}
