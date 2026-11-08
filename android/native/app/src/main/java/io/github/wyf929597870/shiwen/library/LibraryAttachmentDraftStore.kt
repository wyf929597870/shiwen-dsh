package io.github.wyf929597870.shiwen.library

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

data class StagedLibraryAttachment(
    val id: String, val name: String, val hash: String, val byteLength: Long,
    val bytes: ByteArray, val mimeType: String
)

/** Durable, library-scoped image staging. Staged bytes are never stored in the WebView draft. */
internal class LibraryAttachmentDraftStore(context: Context, private val libraryId: String) {
    private val root = File(context.applicationContext.filesDir, "libraries/$libraryId/attachment-drafts")

    fun stage(name: String, bytes: ByteArray): JSONObject {
        require(bytes.size in 1..MAX_IMAGE_BYTES) { "IMAGE_SIZE_INVALID" }
        val mime = imageMime(bytes) ?: error("IMAGE_FORMAT_UNSUPPORTED")
        val id = UUID.randomUUID().toString()
        check(root.exists() || root.mkdirs()) { "ATTACHMENT_STAGE_UNAVAILABLE" }
        val temp = File(root, ".$id.part")
        val target = File(root, id)
        try {
            temp.writeBytes(bytes)
            check(temp.renameTo(target)) { "ATTACHMENT_STAGE_FAILED" }
        } finally { if (temp.exists()) temp.delete() }
        return JSONObject().put("id", id).put("name", safeName(name)).put("hash", sha256(bytes))
            .put("byteLength", bytes.size).put("mimeType", mime)
    }

    fun read(id: String, name: String): StagedLibraryAttachment {
        UUID.fromString(id)
        val file = File(root, id)
        check(file.canonicalFile.parentFile == root.canonicalFile && file.isFile) { "ATTACHMENT_STAGE_MISSING" }
        check(file.length() in 1..MAX_IMAGE_BYTES.toLong()) { "IMAGE_SIZE_INVALID" }
        val bytes = file.readBytes()
        val mime = imageMime(bytes) ?: error("IMAGE_FORMAT_UNSUPPORTED")
        return StagedLibraryAttachment(id, safeName(name), sha256(bytes), bytes.size.toLong(), bytes, mime)
    }

    fun archiveFile(id: String): LibraryArchiveFile {
        UUID.fromString(id)
        val file = File(root, id)
        check(file.canonicalFile.parentFile == root.canonicalFile && file.isFile) { "ATTACHMENT_STAGE_MISSING" }
        val info = archiveFileInfo(file, MAX_IMAGE_BYTES.toLong())
        check(imageMime(file) != null) { "IMAGE_FORMAT_UNSUPPORTED" }
        return info
    }

    /** Restores a token without replacing an existing token, even when the destination is occupied. */
    fun restore(id: String, name: String, hash: String, byteLength: Long, mimeType: String, bytes: ByteArray): Boolean {
        UUID.fromString(id)
        require(hash.matches(Regex("[a-f0-9]{64}")) && byteLength in 1..MAX_IMAGE_BYTES.toLong() &&
            bytes.size.toLong() == byteLength && sha256(bytes) == hash) { "ATTACHMENT_STAGE_HASH_MISMATCH" }
        val safe = safeName(name)
        require(safe == name) { "ATTACHMENT_STAGE_NAME_INVALID" }
        val mime = imageMime(bytes) ?: error("IMAGE_FORMAT_UNSUPPORTED")
        require(mime == mimeType) { "ATTACHMENT_STAGE_MIME_MISMATCH" }
        check(root.exists() || root.mkdirs()) { "ATTACHMENT_STAGE_UNAVAILABLE" }
        val target = File(root, id)
        check(target.canonicalFile.parentFile == root.canonicalFile) { "ATTACHMENT_STAGE_PATH_INVALID" }
        if (target.exists()) {
            check(target.isFile && target.length() == byteLength && sha256(target.readBytes()) == hash) {
                "ATTACHMENT_STAGE_TARGET_MISMATCH"
            }
            return false
        }
        val temp = File(root, ".$id.restore-${UUID.randomUUID()}.part")
        try {
            temp.writeBytes(bytes)
            try {
                Files.move(temp.toPath(), target.toPath())
                return true
            } catch (_: FileAlreadyExistsException) {
                check(target.isFile && target.length() == byteLength && sha256(target.readBytes()) == hash) {
                    "ATTACHMENT_STAGE_TARGET_MISMATCH"
                }
                return false
            }
        } finally { if (temp.exists()) temp.delete() }
    }

    fun restoreFromFile(id: String, name: String, hash: String, byteLength: Long, mimeType: String,
        source: LibraryArchiveFile): Boolean {
        UUID.fromString(id)
        require(hash.matches(Regex("[a-f0-9]{64}")) && byteLength in 1..MAX_IMAGE_BYTES.toLong() &&
            source.byteLength == byteLength && source.sha256 == hash) { "ATTACHMENT_STAGE_HASH_MISMATCH" }
        require(safeName(name) == name) { "ATTACHMENT_STAGE_NAME_INVALID" }
        require(imageMime(source.file) == mimeType) { "ATTACHMENT_STAGE_MIME_MISMATCH" }
        check(root.exists() || root.mkdirs()) { "ATTACHMENT_STAGE_UNAVAILABLE" }
        val target = File(root, id)
        check(target.canonicalFile.parentFile == root.canonicalFile) { "ATTACHMENT_STAGE_PATH_INVALID" }
        if (target.exists()) {
            val existing = archiveFileInfo(target, MAX_IMAGE_BYTES.toLong())
            check(existing.byteLength == byteLength && existing.sha256 == hash && imageMime(target) == mimeType) {
                "ATTACHMENT_STAGE_TARGET_MISMATCH"
            }
            return false
        }
        val temp = File(root, ".$id.restore-${UUID.randomUUID()}.part")
        try {
            val copied = copyArchiveFile(source, temp, MAX_IMAGE_BYTES.toLong())
            check(copied.byteLength == byteLength && copied.sha256 == hash && imageMime(temp) == mimeType) {
                "ATTACHMENT_STAGE_HASH_MISMATCH"
            }
            try {
                java.nio.file.Files.move(temp.toPath(), target.toPath())
                return true
            } catch (_: java.nio.file.FileAlreadyExistsException) {
                val existing = archiveFileInfo(target, MAX_IMAGE_BYTES.toLong())
                check(existing.byteLength == byteLength && existing.sha256 == hash && imageMime(target) == mimeType) {
                    "ATTACHMENT_STAGE_TARGET_MISMATCH"
                }
                return false
            }
        } finally { if (temp.exists()) temp.delete() }
    }

    fun deleteRestored(id: String, expectedHash: String) {
        UUID.fromString(id)
        val file = File(root, id)
        check(file.canonicalFile.parentFile == root.canonicalFile) { "ATTACHMENT_STAGE_PATH_INVALID" }
        if (file.exists()) {
            check(file.isFile && sha256(file.readBytes()) == expectedHash) { "ATTACHMENT_STAGE_TARGET_MISMATCH" }
            check(file.delete()) { "ATTACHMENT_STAGE_CLEANUP_FAILED" }
        }
    }

    fun delete(id: String) {
        UUID.fromString(id)
        val file = File(root, id)
        check(file.canonicalFile.parentFile == root.canonicalFile) { "ATTACHMENT_STAGE_PATH_INVALID" }
        if (file.exists()) check(file.delete()) { "ATTACHMENT_STAGE_CLEANUP_FAILED" }
    }

    companion object {
        const val MAX_IMAGE_BYTES = 8 * 1024 * 1024
        fun imageMime(bytes: ByteArray): String? = when {
            bytes.size >= 8 && bytes.copyOfRange(0, 8).contentEquals(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)) -> "image/png"
            bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() && bytes[2] == 0xff.toByte() -> "image/jpeg"
            bytes.size >= 6 && String(bytes, 0, 6, Charsets.US_ASCII) in setOf("GIF87a", "GIF89a") -> "image/gif"
            bytes.size >= 12 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" && String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
            else -> null
        }
        fun imageMime(file: File): String? {
            if (!file.isFile || file.length() < 3) return null
            val header = ByteArray(minOf(12L, file.length()).toInt())
            FileInputStream(file).use { input ->
                var offset = 0
                while (offset < header.size) {
                    val count = input.read(header, offset, header.size - offset)
                    if (count < 0) return null
                    offset += count
                }
            }
            return when {
                header.size >= 8 && header.copyOfRange(0, 8).contentEquals(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)) -> "image/png"
                header.size >= 3 && header[0] == 0xff.toByte() && header[1] == 0xd8.toByte() && header[2] == 0xff.toByte() -> "image/jpeg"
                header.size >= 6 && String(header, 0, 6, Charsets.US_ASCII) in setOf("GIF87a", "GIF89a") -> "image/gif"
                header.size >= 12 && String(header, 0, 4, Charsets.US_ASCII) == "RIFF" &&
                    String(header, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
                else -> null
            }
        }
        fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        fun safeName(name: String): String = name.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[^\\p{L}\\p{N}._() -]"), "_").trim().trim('.').take(180)
            .ifBlank { "image" }
    }
}
