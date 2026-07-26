package dev.ani.tracker.torrent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** 在 Android 前台服务中托管 libtorrent，并通过本地 Binder 暴露统一 NDJSON 契约。 */
class TorrentDownloadService : Service() {
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "ani-torrent-service")
    }
    private val binder = LocalBinder()
    private var nativeHandle = 0L

    /** 建立通知后异步恢复下载核心，满足前台服务启动时限。 */
    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startCoreForeground()
        executor.execute { ensureCoreStarted() }
        Log.i(LOG_TAG, "torrent foreground service created")
    }

    /** 保持服务可重建，并确保重复启动不会创建第二个 Session。 */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        executor.execute { ensureCoreStarted() }
        return START_STICKY
    }

    /** 返回仅限应用进程使用的 Binder。 */
    override fun onBind(intent: Intent?): IBinder = binder

    /** 在系统销毁服务前等待原生状态落盘。 */
    override fun onDestroy() {
        try {
            executor.submit { stopCore() }.get(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        } catch (error: Exception) {
            Log.e(LOG_TAG, "torrent core shutdown failed", error)
        } finally {
            executor.shutdownNow()
            Log.i(LOG_TAG, "torrent foreground service destroyed")
            super.onDestroy()
        }
    }

    /** 串行执行核心请求，调用方不直接接触 JNI 句柄。 */
    private fun executeRequest(requestJson: String): String {
        return executor.submit(Callable {
            NativeTorrentCore.nativeExecute(ensureCoreStarted(), requestJson)
        }).get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    /** 惰性创建核心，确保整个服务生命周期只有一个 Session。 */
    private fun ensureCoreStarted(): Long {
        if (nativeHandle == 0L) {
            val dataDirectory = File(noBackupFilesDir, DATA_DIRECTORY_NAME)
            check(dataDirectory.exists() || dataDirectory.mkdirs()) {
                "无法创建下载核心数据目录：${dataDirectory.absolutePath}"
            }
            val handle = NativeTorrentCore.nativeStart(dataDirectory.absolutePath)
            try {
                val response = NativeTorrentCore.nativeExecute(handle, AndroidTorrentDefaults.configureRequest())
                check(isSuccessfulResponse(response)) { "Android 默认设置应用失败：$response" }
                nativeHandle = handle
            } catch (error: Exception) {
                NativeTorrentCore.nativeStop(handle)
                throw error
            }
            Log.i(LOG_TAG, "torrent core started: ${dataDirectory.absolutePath}")
        }
        return nativeHandle
    }

    /** 兼容 property_tree 的字符串布尔值与标准 JSON 布尔值。 */
    private fun isSuccessfulResponse(response: String): Boolean {
        return when (val value = JSONObject(response).opt("ok")) {
            is Boolean -> value
            is String -> value.toBooleanStrictOrNull() == true
            else -> false
        }
    }

    /** 停止当前 Session；重复调用不会再次销毁句柄。 */
    private fun stopCore() {
        if (nativeHandle == 0L) return
        NativeTorrentCore.nativeStop(nativeHandle)
        nativeHandle = 0L
    }

    /** 创建低打扰下载通知渠道。 */
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                getString(R.string.torrent_notification_channel),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.torrent_notification_channel_description)
                setShowBadge(false)
            }
        )
    }

    /** 启动 dataSync 类型前台通知。 */
    private fun startCoreForeground() {
        val notification = Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(getString(R.string.torrent_notification_title))
            .setContentText(getString(R.string.torrent_notification_text))
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /** 提供给宿主应用的本地核心调用入口。 */
    inner class LocalBinder : Binder() {
        /** 执行 NDJSON 请求并同步返回响应。 */
        fun execute(requestJson: String): String = executeRequest(requestJson)
    }

    companion object {
        private const val LOG_TAG = "AniTorrentService"
        private const val DATA_DIRECTORY_NAME = "torrent-core"
        private const val NOTIFICATION_CHANNEL_ID = "ani_torrent_downloads"
        private const val NOTIFICATION_ID = 20021
        private const val REQUEST_TIMEOUT_SECONDS = 30L
        private const val SHUTDOWN_TIMEOUT_SECONDS = 12L

        /** 启动下载前台服务；Android 8 及以上使用专用入口。 */
        fun start(context: Context) {
            val intent = Intent(context, TorrentDownloadService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** 请求服务保存状态后停止。 */
        fun stop(context: Context) {
            context.stopService(Intent(context, TorrentDownloadService::class.java))
        }
    }
}
