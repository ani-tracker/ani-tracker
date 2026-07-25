package dev.ani.tracker.torrent

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@InvokeArg
class ExecuteArgs {
    lateinit var requestJson: String
}

/** 将 Tauri Rust transport 连接到 Android 前台下载服务。 */
@TauriPlugin
class AniTorrentPlugin(private val activity: Activity) : Plugin(activity) {
    private val stateLock = Object()
    private val commandExecutor = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "ani-torrent-plugin")
    }
    @Volatile private var binder: TorrentDownloadService.LocalBinder? = null
    private var bindRequested = false
    private var bindError: Exception? = null

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            synchronized(stateLock) {
                binder = service as? TorrentDownloadService.LocalBinder
                bindError = if (binder == null) IllegalStateException("下载服务 Binder 类型无效") else null
                stateLock.notifyAll()
            }
            Log.i(LOG_TAG, "torrent foreground service connected")
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            clearBinding(IllegalStateException("下载服务连接已断开"))
        }

        override fun onBindingDied(name: ComponentName?) {
            clearBinding(IllegalStateException("下载服务绑定已失效"))
        }

        override fun onNullBinding(name: ComponentName?) {
            clearBinding(IllegalStateException("下载服务拒绝绑定"))
        }
    }

    /** 插件加载后立即启动并绑定前台服务。 */
    override fun load(webView: WebView) {
        requestBinding()
        Log.i(LOG_TAG, "Tauri torrent plugin loaded")
    }

    /** 执行完整 NDJSON 请求；原生句柄不会暴露给 WebView。 */
    @Command
    fun execute(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(ExecuteArgs::class.java)
        } catch (error: Exception) {
            invoke.reject("下载核心请求参数无效", "invalid_request", error)
            return
        }
        commandExecutor.execute {
            try {
                val response = requireBinder().execute(args.requestJson)
                invoke.resolve(JSObject().put("responseJson", response))
            } catch (error: Exception) {
                Log.e(LOG_TAG, "torrent request failed", error)
                invoke.reject("Android 下载核心请求失败", "torrent_request_failed", error)
            }
        }
    }

    /** 查询前台服务和原生核心状态，不隐式创建新实例。 */
    @Command
    fun status(invoke: Invoke) {
        commandExecutor.execute {
            try {
                val current = binder
                invoke.resolve(JSObject().apply {
                    put("running", current?.isCoreRunning() == true)
                    current?.dataDirectoryPath()?.let { put("dataDirectory", it) }
                    put("foregroundService", current != null)
                })
            } catch (error: Exception) {
                Log.e(LOG_TAG, "torrent status failed", error)
                invoke.reject("Android 下载核心状态读取失败", "torrent_status_failed", error)
            }
        }
    }

    /** 保存恢复数据、解除绑定并停止前台服务。 */
    @Command
    fun shutdown(invoke: Invoke) {
        commandExecutor.execute {
            try {
                binder?.shutdownCore()
                releaseBinding(stopService = true)
                invoke.resolve(JSObject().put("stopped", true))
            } catch (error: Exception) {
                Log.e(LOG_TAG, "torrent shutdown failed", error)
                invoke.reject("Android 下载核心停止失败", "torrent_shutdown_failed", error)
            }
        }
    }

    /** Activity 重建只解除 Binder，前台下载服务继续运行。 */
    override fun onDestroy() {
        releaseBinding(stopService = false)
        commandExecutor.shutdownNow()
    }

    /** 在主线程启动并绑定 Service。 */
    private fun requestBinding() {
        activity.runOnUiThread {
            synchronized(stateLock) {
                if (binder != null || bindRequested) return@runOnUiThread
                try {
                    TorrentDownloadService.start(activity)
                    bindRequested = activity.bindService(
                        Intent(activity, TorrentDownloadService::class.java),
                        serviceConnection,
                        Context.BIND_AUTO_CREATE
                    )
                    check(bindRequested) { "系统拒绝绑定下载服务" }
                    bindError = null
                } catch (error: Exception) {
                    bindRequested = false
                    bindError = error
                    stateLock.notifyAll()
                    Log.e(LOG_TAG, "torrent foreground service bind failed", error)
                }
            }
        }
    }

    /** 等待异步 ServiceConnection，超时后返回稳定错误。 */
    private fun requireBinder(): TorrentDownloadService.LocalBinder {
        binder?.let { return it }
        requestBinding()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(BIND_TIMEOUT_SECONDS)
        synchronized(stateLock) {
            while (binder == null && bindError == null) {
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0) break
                TimeUnit.NANOSECONDS.timedWait(stateLock, remaining)
            }
            binder?.let { return it }
            throw bindError ?: IllegalStateException("等待 Android 下载服务连接超时")
        }
    }

    /** 在主线程解除绑定，可选择同时终止前台服务。 */
    private fun releaseBinding(stopService: Boolean) {
        val completed = CountDownLatch(1)
        activity.runOnUiThread {
            synchronized(stateLock) {
                if (bindRequested) {
                    runCatching { activity.unbindService(serviceConnection) }
                }
                binder = null
                bindRequested = false
                bindError = null
                stateLock.notifyAll()
            }
            if (stopService) TorrentDownloadService.stop(activity)
            completed.countDown()
        }
        check(completed.await(BIND_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            "等待 Android 下载服务释放超时"
        }
    }

    private fun clearBinding(error: Exception) {
        synchronized(stateLock) {
            binder = null
            bindRequested = false
            bindError = error
            stateLock.notifyAll()
        }
        Log.w(LOG_TAG, error.message, error)
    }

    companion object {
        private const val LOG_TAG = "AniTorrentPlugin"
        private const val BIND_TIMEOUT_SECONDS = 15L
    }
}
