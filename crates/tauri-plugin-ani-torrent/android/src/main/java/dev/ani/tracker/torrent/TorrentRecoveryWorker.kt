package dev.ani.tracker.torrent

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** 在系统回收应用进程后尽力恢复仍有任务的前台下载服务。 */
class TorrentRecoveryWorker(
    appContext: Context,
    parameters: WorkerParameters
) : Worker(appContext, parameters) {
    /** 仅在持久化任务存在时恢复服务，系统限制时交由 WorkManager 重试。 */
    override fun doWork(): Result {
        if (!TorrentDownloadService.hasActiveTasks(applicationContext)) return Result.success()
        return try {
            TorrentDownloadService.start(applicationContext)
            Log.i(LOG_TAG, "torrent foreground service recovery requested")
            Result.success()
        } catch (error: Exception) {
            Log.w(LOG_TAG, "torrent foreground service recovery deferred", error)
            Result.retry()
        }
    }

    companion object {
        private const val LOG_TAG = "AniTorrentRecovery"
        private const val UNIQUE_WORK_NAME = "ani-torrent-recovery-v1"

        /** 注册唯一周期恢复任务，避免 Activity 重建产生重复调度。 */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(
                    if (TorrentDownloadService.allowsMeteredDownloads(context)) {
                        NetworkType.CONNECTED
                    } else {
                        NetworkType.UNMETERED
                    }
                )
                .setRequiresStorageNotLow(true)
                .build()
            val request = PeriodicWorkRequestBuilder<TorrentRecoveryWorker>(
                15,
                TimeUnit.MINUTES
            )
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                request
            )
        }
    }
}
