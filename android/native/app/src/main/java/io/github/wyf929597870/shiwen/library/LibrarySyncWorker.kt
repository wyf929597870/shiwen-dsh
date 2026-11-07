package io.github.wyf929597870.shiwen.library

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.content.Context
import androidx.work.Constraints
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import kotlinx.coroutines.delay
import java.util.concurrent.TimeUnit

/** Runs background sync only for libraries where both auto and background sync are enabled. */
class LibrarySyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val manager = LibraryManager(applicationContext)
        val coordinator = LibrarySyncCoordinator(applicationContext, manager, NodeSettingsStore(applicationContext))
        return try {
            val targets = manager.all().filter {
                LibrarySyncWorkPolicy.eligible(it.role, it.autoSync, it.backgroundSync)
            }
            val batch = LibrarySyncWorkPolicy.runEach(targets, { isStopped }) { row ->
                when (LibrarySyncWorkPolicy.wifiGate(row.syncConditionsJson, LibrarySyncScheduler.onWifi(applicationContext))) {
                    LibrarySyncWorkPolicy.WifiGate.SKIP_UNTIL_NEXT_PERIOD -> return@runEach null
                    LibrarySyncWorkPolicy.WifiGate.INVALID_SETTINGS -> return@runEach false
                    LibrarySyncWorkPolicy.WifiGate.READY -> Unit
                }
                val operationResult = runCatching { coordinator.syncNow(row.libraryId, "auto") }
                if (operationResult.isFailure) return@runEach false
                val operation = operationResult.getOrThrow()
                val operationId = operation.optString("operationId")
                val deadline = System.currentTimeMillis() + TimeUnit.MINUTES.toMillis(8)
                var terminal: String? = null
                while (!isStopped && System.currentTimeMillis() < deadline) {
                    val progress = coordinator.progress(row.libraryId, operationId)
                    val state = progress.optString("state")
                    if (state == "completed" || state == "failed" || state == "unknown") {
                        terminal = state
                        break
                    }
                    delay(500)
                }
                !LibrarySyncWorkPolicy.shouldRetry(terminal)
            }
            if (batch.retry || batch.stopped || isStopped) Result.retry() else Result.success()
        } finally {
            coordinator.shutdown()
            manager.close()
        }
    }

}

object LibrarySyncScheduler {
    private const val UNIQUE_WORK = "shiwen-library-background-sync"

    fun refresh(context: Context, enabled: Boolean) {
        val workManager = WorkManager.getInstance(context.applicationContext)
        if (!enabled) {
            workManager.cancelUniqueWork(UNIQUE_WORK)
            return
        }
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        val request = PeriodicWorkRequestBuilder<LibrarySyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        workManager.enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    fun onWifi(context: Context): Boolean {
        val connectivity = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val network = connectivity.activeNetwork ?: return false
        val caps = connectivity.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }
}
