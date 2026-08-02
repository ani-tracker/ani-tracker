package dev.ani.tracker.android.player

import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONArray
import org.json.JSONObject

/** 承载移动端原生 VLC 播放器，并按方向切换竖屏与横屏布局。 */
class PlayerActivity : ComponentActivity() {
    private val playerViewModel by viewModels<AndroidVlcPlayerViewModel>()
    private var launchRequest: PlayerLaunchRequest? = null
    private var missingMedia by mutableStateOf(false)

    /** 解析播放参数并创建无系统操作栏的 Compose 播放页。 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        launchRequest = PlayerLaunchContract.parse(intent)
        missingMedia = launchRequest == null
        launchRequest?.let(playerViewModel::initialize)
        NativePlayerBridge.register(this)
        configureSystemBars()

        setContent {
            AniPlayerTheme {
                AniPlayerScreen(
                    viewModel = playerViewModel,
                    missingMedia = missingMedia,
                    onClose = ::closePlayer,
                    onToggleFullscreen = ::toggleFullscreen
                )
            }
        }
    }

    /** singleTop 收到新媒体时替换当前业务会话。 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val nextRequest = PlayerLaunchContract.parse(intent)
        if (nextRequest != null) {
            launchRequest = nextRequest
            missingMedia = false
            playerViewModel.initialize(nextRequest)
        } else if (launchRequest == null) {
            missingMedia = true
        }
    }

    /** 方向变化时复用当前 Activity，并同步对应方向的系统栏状态。 */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        configureSystemBars()
    }

    /** 返回前台时恢复视频表面，但保持后台切换产生的暂停状态。 */
    override fun onStart() {
        super.onStart()
        playerViewModel.onHostStart()
    }

    /** 真正进入后台时暂停，旋转重建不打断 VLC 会话。 */
    override fun onStop() {
        playerViewModel.onHostStop(isChangingConfigurations)
        super.onStop()
    }

    /** 销毁时清理 Tauri 插件持有的弱引用。 */
    override fun onDestroy() {
        NativePlayerBridge.unregister(this)
        super.onDestroy()
    }

    /** 每次恢复后依据当前方向同步沉浸式系统栏。 */
    override fun onPostResume() {
        super.onPostResume()
        configureSystemBars()
    }

    /** 停止原生媒体并关闭播放器 Activity。 */
    private fun closePlayer() {
        playerViewModel.closePlayback()
        finish()
    }

    /** 执行 Tauri Rust 层已经校验过的播放器命令。 */
    internal fun dispatchNativeCommand(command: JSONObject): Boolean {
        val sessionId = command.optString("sessionId")
        if (sessionId.isBlank() || sessionId != playerViewModel.state.value.sessionId) return false
        return when (command.optString("type")) {
            "play" -> true.also { playerViewModel.play() }
            "pause" -> true.also { playerViewModel.pause() }
            "seek" -> true.also {
                playerViewModel.seekTo((command.optDouble("positionSeconds", 0.0) * 1_000.0).toLong())
            }
            "set-volume" -> true.also {
                playerViewModel.setVolume((command.optDouble("volume", 0.0) * 100.0).toInt())
            }
            "set-muted" -> true.also { playerViewModel.setMuted(command.optBoolean("muted")) }
            "set-rate" -> true.also {
                playerViewModel.setPlaybackRate(command.optDouble("rate", 1.0).toFloat())
            }
            "select-audio-track" -> command.optString("trackId").toIntOrNull()?.let {
                playerViewModel.selectAudioTrack(it)
                true
            } ?: false
            "select-subtitle-track" -> {
                val trackId = command.optString("trackId").takeIf(String::isNotBlank)?.toIntOrNull()
                playerViewModel.selectSubtitleTrack(trackId)
                true
            }
            "set-subtitle-scale" -> true.also {
                playerViewModel.setSubtitleScale(command.optInt("subtitleScale", 100))
            }
            "set-aspect-ratio" -> true.also {
                val ratio = command.optString("aspectRatio", "default")
                val value = command.optString("value").takeIf(String::isNotBlank)
                playerViewModel.setAspectRatio(if (ratio == "custom") value else ratio)
            }
            "set-fullscreen" -> true.also { setFullscreen(command.optBoolean("fullscreen")) }
            "previous-item" -> true.also { playerViewModel.previousEpisode() }
            "next-item" -> true.also { playerViewModel.nextEpisode() }
            "retry" -> true.also { playerViewModel.retry() }
            "close" -> true.also { closeFromNativeBridge() }
            else -> false
        }
    }

    /** 生成供 Rust PlayerService 读取的完整原生状态片段。 */
    internal fun nativeSnapshot(): JSONObject {
        val state = playerViewModel.state.value
        return JSONObject().apply {
            put("sessionId", state.sessionId)
            put("status", state.status.name.lowercase())
            put("positionSeconds", state.positionMillis / 1_000.0)
            put("durationSeconds", state.durationMillis / 1_000.0)
            put("bufferPercent", state.bufferPercent.toDouble())
            put("volume", state.volume / 100.0)
            put("muted", state.muted)
            put("playbackRate", state.playbackRate.toDouble())
            put("subtitleScale", state.subtitleScale)
            put("aspectRatio", state.aspectRatio ?: JSONObject.NULL)
            put("fullscreen", resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE)
            put("activeItemId", state.activeEpisode?.id ?: JSONObject.NULL)
            put("audioTracks", JSONArray().apply {
                state.audioTracks.forEach { track ->
                    put(JSONObject().apply {
                        put("id", track.id.toString())
                        put("label", track.label)
                        put("selected", track.selected)
                    })
                }
            })
            put("subtitleTracks", JSONArray().apply {
                state.subtitleTracks.forEach { track ->
                    put(JSONObject().apply {
                        put("id", track.id.toString())
                        put("label", track.label)
                        put("selected", track.selected)
                    })
                }
            })
            put("errorMessage", state.errorMessage ?: JSONObject.NULL)
        }
    }

    /** 供 Tauri 插件幂等停止播放并关闭 Activity。 */
    internal fun closeFromNativeBridge() {
        if (isFinishing || isDestroyed) return
        closePlayer()
    }

    /** 竖屏进入传感器横屏，横屏退出后交还系统方向策略。 */
    private fun toggleFullscreen() {
        setFullscreen(resources.configuration.orientation != Configuration.ORIENTATION_LANDSCAPE)
    }

    /** 显式切换横屏全屏状态。 */
    private fun setFullscreen(fullscreen: Boolean) {
        requestedOrientation = if (fullscreen) {
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    /** 横屏隐藏系统栏，竖屏保留透明状态栏与导航栏。 */
    private fun configureSystemBars() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }
}
