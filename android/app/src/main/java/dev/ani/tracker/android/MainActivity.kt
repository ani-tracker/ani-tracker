package dev.ani.tracker.android

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.widget.Button
import android.widget.TextView
import dev.ani.tracker.torrent.TorrentDownloadService
import java.util.concurrent.Executors

/** 用于安装验证与移动宿主接入的下载核心控制页。 */
class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var statusText: TextView
    private var torrentBinder: TorrentDownloadService.LocalBinder? = null
    private var bound = false

    private val serviceConnection = object : ServiceConnection {
        /** 保存本地 Binder 并立即读取核心状态。 */
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            torrentBinder = service as? TorrentDownloadService.LocalBinder
            bound = torrentBinder != null
            refreshStatus()
        }

        /** 清理失效 Binder，等待用户重新启动服务。 */
        override fun onServiceDisconnected(name: ComponentName?) {
            torrentBinder = null
            bound = false
            showStatus(getString(R.string.status_disconnected))
        }
    }

    /** 初始化控制按钮并申请 Android 13 通知权限。 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        statusText = findViewById(R.id.status_text)
        findViewById<Button>(R.id.start_button).setOnClickListener { startTorrentCore() }
        findViewById<Button>(R.id.refresh_button).setOnClickListener { refreshStatus() }
        findViewById<Button>(R.id.stop_button).setOnClickListener { stopTorrentCore() }
        requestNotificationPermission()
    }

    /** 解除绑定并停止页面工作线程。 */
    override fun onDestroy() {
        if (bound) unbindService(serviceConnection)
        worker.shutdownNow()
        super.onDestroy()
    }

    /** 启动前台核心并建立本地 Binder 连接。 */
    private fun startTorrentCore() {
        TorrentDownloadService.start(this)
        if (!bound) {
            bindService(
                Intent(this, TorrentDownloadService::class.java),
                serviceConnection,
                Context.BIND_AUTO_CREATE
            )
        }
        showStatus(getString(R.string.status_starting))
    }

    /** 查询与桌面端相同的 status 命令，并避免阻塞主线程。 */
    private fun refreshStatus() {
        val binder = torrentBinder
        if (binder == null) {
            showStatus(getString(R.string.status_not_connected))
            return
        }
        worker.execute {
            try {
                val response = binder.execute(
                    "{\"id\":\"android-ui-status\",\"method\":\"status\",\"params\":{}}"
                )
                showStatus(response)
            } catch (error: Exception) {
                showStatus(getString(R.string.status_error, error.message ?: error.javaClass.simpleName))
            }
        }
    }

    /** 解除连接并请求服务持久化状态后停止。 */
    private fun stopTorrentCore() {
        if (bound) {
            unbindService(serviceConnection)
            bound = false
            torrentBinder = null
        }
        TorrentDownloadService.stop(this)
        showStatus(getString(R.string.status_stopped))
    }

    /** 安全地在主线程更新状态区域。 */
    private fun showStatus(message: String) {
        runOnUiThread { statusText.text = message }
    }

    /** Android 13 及以上首次启动时申请前台通知权限。 */
    private fun requestNotificationPermission() {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
        }
    }

    companion object {
        private const val NOTIFICATION_PERMISSION_REQUEST = 20021
    }
}
