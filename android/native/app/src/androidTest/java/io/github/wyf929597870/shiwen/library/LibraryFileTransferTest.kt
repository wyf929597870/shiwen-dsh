package io.github.wyf929597870.shiwen.library

import android.content.Intent
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class LibraryFileTransferTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val transfer = LibraryFileTransfer(context)

    @Test fun opensOnlyDocumentPickerIntentsWithExplicitMimeFilters() {
        val markdown = transfer.markdownImportIntent()
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, markdown.action)
        assertEquals("*/*", markdown.type)
        assertEquals(true, markdown.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
        assertEquals(listOf("text/markdown", "text/plain", "text/x-markdown"),
            markdown.getStringArrayExtra(Intent.EXTRA_MIME_TYPES)?.toList())
        assertEquals(arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream").toList(),
            transfer.backupImportIntent().getStringArrayExtra(Intent.EXTRA_MIME_TYPES)?.toList())
    }

    @Test fun exportUsesSafeNameAndAllowedMime() {
        val intent = transfer.createDocumentIntent("../../个人记录.md", "text/markdown")
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.action)
        assertEquals("个人记录.md", intent.getStringExtra(Intent.EXTRA_TITLE))
        assertThrows(IllegalArgumentException::class.java) {
            transfer.createDocumentIntent("bad.png", "image/png")
        }
    }

    @Test fun readsAndWritesOnlyContentUrisThroughResolver() {
        val dir = File(context.cacheDir, "shiwen-transfers").apply { mkdirs() }
        val file = File(dir, "roundtrip.md")
        file.delete()
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val expected = "# Offline export\n\nBody".toByteArray()
        transfer.writeUri(uri, expected)
        assertArrayEquals(expected, transfer.readUri(uri, 1024))
        assertThrows(IllegalArgumentException::class.java) { transfer.readUri(android.net.Uri.fromFile(file), 1024) }
        file.delete()
    }

    @Test fun chooserContainsNativeReadGrantAndContentUri() {
        val dir = File(context.cacheDir, "shiwen-transfers").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val chooser = transfer.shareIntent("record.md", "text/markdown", "# Hello".toByteArray(), "Share record")
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        val send = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        assertEquals(Intent.ACTION_SEND, send?.action)
        assertEquals("text/markdown", send?.type)
        assertEquals(true, send?.flags?.and(Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0)
        val uri = send?.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM)
        assertEquals("content", uri?.scheme)
        val first = dir.listFiles()?.singleOrNull() ?: error("share cache file missing")
        assertEquals(true, first.name.endsWith("-record.md"))
        val firstBytes = first.readBytes()
        transfer.shareIntent("record.md", "text/markdown", "# Second".toByteArray(), "Share record")
        assertEquals(2, dir.listFiles()?.size)
        assertArrayEquals(firstBytes, first.readBytes())
        dir.listFiles()?.forEach { it.delete() }
    }

    @Test fun attachmentIntentUsesUniqueReadOnlyProviderFiles() {
        val dir = File(context.cacheDir, "shiwen-transfers").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val first = transfer.attachmentIntent("photo.png", "image/png", byteArrayOf(1, 2), share = false, title = "Open")
        val second = transfer.attachmentIntent("photo.png", "image/png", byteArrayOf(3, 4), share = true, title = "Share")
        assertEquals(Intent.ACTION_CHOOSER, first.action)
        assertEquals(Intent.ACTION_CHOOSER, second.action)
        assertEquals(2, dir.listFiles()?.size)
        assertEquals(true, dir.listFiles()?.all { it.name.endsWith("-photo.png") })
        dir.listFiles()?.forEach { it.delete() }
    }

    @Test fun shareCacheCleanupRemovesOnlyFilesAtLeast24HoursOld() {
        val dir = File(context.cacheDir, "shiwen-transfers").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val old = File(dir, "old-record.md").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val recent = File(dir, "recent-record.md").apply { writeBytes(byteArrayOf(4, 5)) }
        val now = System.currentTimeMillis()
        old.setLastModified(now - LibraryFileTransfer.SHARE_CACHE_TTL_MILLIS - 1000)
        recent.setLastModified(now - 1000)
        assertEquals(3L, transfer.cleanupExpiredShareCache(dir, now))
        assertEquals(false, old.exists())
        assertEquals(true, recent.exists())
        recent.delete()
    }
}
