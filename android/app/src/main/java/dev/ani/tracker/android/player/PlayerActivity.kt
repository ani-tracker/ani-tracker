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

    /** 返回前台时恢复生命周期暂停的媒体。 */
    override fun onStart() {
        super.onStart()
        playerViewModel.onHostStart()
    }

    /** 真正进入后台时暂停，旋转重建不打断 VLC 会话。 */
    override fun onStop() {
        playerViewModel.onHostStop(isChangingConfigurations)
        super.onStop()
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

    /** 竖屏进入传感器横屏，横屏退出后交还系统方向策略。 */
    private fun toggleFullscreen() {
        requestedOrientation = if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        } else {
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
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
