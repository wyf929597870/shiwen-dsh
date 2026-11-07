package io.github.wyf929597870.shiwen.library

import android.content.Context
import android.os.StatFs
import org.json.JSONObject
import java.io.File

internal class LibraryStorageInfo(context: Context) {
    private val app = context.applicationContext
    fun read(repo: LibraryRepository): JSONObject {
        val db = app.getDatabasePath(repo.registryItem().dbFile)
        val data = File(app.filesDir, "libraries/${repo.libraryId}")
        val attachments = treeBytes(data)
        val space = StatFs(app.filesDir.absolutePath)
        return JSONObject().put("availableBytes", space.availableBytes).put("totalBytes", space.totalBytes)
            .put("libraryBytes", attachments + db.length() + File(db.path + "-wal").length() + File(db.path + "-shm").length())
            .put("attachmentBytes", attachments).put("recordCount", repo.dao.recordCount())
            .put("versionCount", repo.db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM versions").use { cursor ->
                cursor.moveToFirst(); cursor.getLong(0)
            }).put("expiredShareBytes", expired().sumOf { it.length() })
    }
    fun clearExpired(): JSONObject {
        var bytes = 0L; var files = 0
        for (file in expired()) { val size = file.length(); if (file.delete()) { bytes += size; files++ } }
        return JSONObject().put("removedBytes", bytes).put("removedFiles", files)
    }
    private fun expired() = File(app.cacheDir, "shiwen-transfers").listFiles()?.filter {
        it.isFile && it.canonicalFile.parentFile == it.parentFile?.canonicalFile &&
            it.lastModified() < System.currentTimeMillis() - 24 * 60 * 60 * 1000L
    }.orEmpty()
    private fun treeBytes(root: File): Long {
        if (!root.exists()) return 0
        val path = root.canonicalFile.toPath()
        return root.walkTopDown().onEnter { it.canonicalFile == it.absoluteFile && it.canonicalFile.toPath().startsWith(path) }
            .filter { it.isFile && it.canonicalFile.toPath().startsWith(path) }.sumOf { it.length() }
    }
}
