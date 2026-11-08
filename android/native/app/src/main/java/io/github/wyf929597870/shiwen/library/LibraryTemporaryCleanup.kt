package io.github.wyf929597870.shiwen.library

import android.content.Context

/** Remove only abandoned app-owned transfer staging from earlier process runs. */
object LibraryTemporaryCleanup {
    @JvmStatic fun clean(context: Context) {
        val cutoff = System.currentTimeMillis() - 48L * 60 * 60 * 1000
        val prefixes = listOf("shiwen-archive-stage-", "shiwen-backup-", "shiwen-import-", "shiwen-export-")
        context.applicationContext.cacheDir.listFiles()?.forEach { file ->
            if (prefixes.any(file.name::startsWith) && file.lastModified() in 1 until cutoff) runCatching { file.deleteRecursively() }
        }
    }
}
