package dev.ani.tracker.torrent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
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

/** 在 Android 前台服务中托管 libtorrent，并通过应用内 Binder 暴露 NDJSON 契约。 */
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

    /** Android 15 前台服务超时时同步刷盘并停止，避免恢复数据损坏。 */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(LOG_TAG, "torrent foreground service reached system timeout: type=$fgsType")
        executor.execute {
            stopCore()
            stopSelf(startId)
        }
    }

    /** 串行执行核心请求，并持久化最近一次配置供服务重建恢复。 */
    private fun executeRequest(requestJson: String): String {
        return executor.submit(Callable {
            val response = NativeTorrentCore.nativeExecute(ensureCoreStarted(), requestJson)
            if (requestMethod(requestJson) == "configure" && isSuccessfulResponse(response)) {
                check(preferences().edit().putString(CONFIGURE_REQUEST_KEY, requestJson).commit()) {
                    "无法持久化 Android 下载配置"
                }
            }
            if (isSuccessfulResponse(response)) {
                runCatching(::refreshRecoveryState).onFailure { error ->
                    Log.w(LOG_TAG, "torrent recovery state refresh failed", error)
                }
            }
            response
        }).get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    /** 惰性创建核心，并重放上一次成功配置。 */
    private fun ensureCoreStarted(): Long {
        if (nativeHandle == 0L) {
            val directory = dataDirectory()
            check(directory.exists() || directory.mkdirs()) {
                "无法创建下载核心数据目录：${directory.absolutePath}"
            }
            val handle = NativeTorrentCore.nativeStart(directory.absolutePath)
            try {
                preferences().getString(CONFIGURE_REQUEST_KEY, null)?.let { request ->
                    val response = NativeTorrentCore.nativeExecute(handle, request)
                    check(isSuccessfulResponse(response)) { "恢复 Android 下载配置失败：$response" }
                }
                nativeHandle = handle
            } catch (error: Exception) {
                NativeTorrentCore.nativeStop(handle)
                throw error
            }
            Log.i(LOG_TAG, "torrent core started")
        }
        return nativeHandle
    }

    /** 停止当前 Session；重复调用不会再次销毁句柄。 */
    private fun stopCore() {
        if (nativeHandle == 0L) return
        NativeTorrentCore.nativeStop(nativeHandle)
        nativeHandle = 0L
        Log.i(LOG_TAG, "torrent core stopped")
    }

    private fun dataDirectory() = File(noBackupFilesDir, DATA_DIRECTORY_NAME)

    private fun preferences() = getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    private fun requestMethod(requestJson: String): String? =
        runCatching { JSONObject(requestJson).optString("method") }.getOrNull()

    /** 兼容 property_tree 的字符串布尔值与标准 JSON 布尔值。 */
    private fun isSuccessfulResponse(response: String): Boolean {
        return when (val value = JSONObject(response).opt("ok")) {
            is Boolean -> value
            is String -> value.toBooleanStrictOrNull() == true
            else -> false
        }
    }

    /** 查询核心任务数并保存 WorkManager 是否需要恢复前台服务。 */
    private fun refreshRecoveryState() {
        val statusRequest = JSONObject().apply {
            put("id", "android-recovery-status")
            put("method", "status")
            put("params", JSONObject())
        }.toString()
        val status = JSONObject(NativeTorrentCore.nativeExecute(nativeHandle, statusRequest))
        val result = status.optJSONObject("result")
        val rawCount = result?.opt("taskCount")
        val taskCount = when (rawCount) {
            is Number -> rawCount.toInt()
            is String -> rawCount.toIntOrNull() ?: 0
            else -> 0
        }
        check(preferences().edit().putBoolean(ACTIVE_TASKS_KEY, taskCount > 0).commit()) {
            "无法持久化 Android 下载恢复状态"
        }
    }

    /** 创建低打扰下载通知渠道。 */
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                getString(R.string.ani_torrent_notification_channel),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.ani_torrent_notification_channel_description)
                setShowBadge(false)
            }
        )
    }

    /** 启动 dataSync 类型前台通知。 */
    private fun startCoreForeground() {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            action = ACTION_OPEN_DOWNLOADS
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                NOTIFICATION_ID,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        val notification = Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(getString(R.string.ani_torrent_notification_title))
            .setContentText(getString(R.string.ani_torrent_notification_text))
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setContentIntent(contentIntent)
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

    /** 提供给 Tauri 插件的本地核心调用入口。 */
    inner class LocalBinder : Binder() {
        /** 执行 NDJSON 请求并同步返回响应。 */
        fun execute(requestJson: String): String = executeRequest(requestJson)

        /** 保存恢复数据并停止当前核心实例。 */
        fun shutdownCore() {
            executor.submit { stopCore() }.get(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            check(preferences().edit().putBoolean(ACTIVE_TASKS_KEY, false).commit()) {
                "无法清除 Android 下载恢复状态"
            }
        }

        /** 查询当前核心，不为状态查询隐式启动。 */
        fun isCoreRunning(): Boolean = executor.submit(Callable { nativeHandle != 0L })
            .get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)

        /** 返回不进入系统备份的核心数据目录。 */
        fun dataDirectoryPath(): String = dataDirectory().absolutePath
    }

    companion object {
        private const val LOG_TAG = "AniTorrentService"
        private const val DATA_DIRECTORY_NAME = "torrent-core"
        private const val PREFERENCES_NAME = "ani_torrent_core"
        private const val CONFIGURE_REQUEST_KEY = "configure_request_v1"
        private const val ACTIVE_TASKS_KEY = "has_active_tasks_v1"
        private const val ACTION_OPEN_DOWNLOADS = "com.ani.tracker.OPEN_DOWNLOADS"
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

        /** 判断进程重建后是否仍需恢复包含任务的下载核心。 */
        fun hasActiveTasks(context: Context): Boolean = context
            .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            .getBoolean(ACTIVE_TASKS_KEY, false)
    }
}
