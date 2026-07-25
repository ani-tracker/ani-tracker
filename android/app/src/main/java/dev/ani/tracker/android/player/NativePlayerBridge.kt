package dev.ani.tracker.android.player

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** 在 Tauri 插件与当前原生播放器 Activity 之间转发受控命令。 */
object NativePlayerBridge {
    private const val COMMAND_TIMEOUT_SECONDS = 5L
    private val mainHandler = Handler(Looper.getMainLooper())
    private val activityReference = AtomicReference<WeakReference<PlayerActivity>?>()

    /** 注册当前可接收播放器命令的 Activity。 */
    fun register(activity: PlayerActivity) {
        activityReference.set(WeakReference(activity))
    }

    /** 仅在引用仍指向当前 Activity 时解除注册。 */
    fun unregister(activity: PlayerActivity) {
        val current = activityReference.get()?.get()
        if (current === activity) activityReference.set(null)
    }

    /** 在主线程执行一条已校验的播放器命令。 */
    fun dispatch(command: JSONObject): Result<Boolean> = onMainThread {
        requireActivity().dispatchNativeCommand(command)
    }

    /** 返回不包含任意文件访问能力的原生播放器状态。 */
    fun snapshot(): Result<JSONObject?> = onMainThread {
        activityReference.get()?.get()?.nativeSnapshot()
    }

    /** 幂等关闭当前播放器 Activity。 */
    fun shutdown(): Result<Unit> = onMainThread {
        activityReference.get()?.get()?.closeFromNativeBridge()
        Unit
    }

    private fun requireActivity(): PlayerActivity {
        return activityReference.get()?.get()
            ?: throw IllegalStateException("Android 原生播放器尚未就绪")
    }

    private fun <T> onMainThread(block: () -> T): Result<T> {
        if (Looper.myLooper() == Looper.getMainLooper()) return runCatching(block)
        val result = AtomicReference<Result<T>>()
        val completed = CountDownLatch(1)
        mainHandler.post {
            result.set(runCatching(block))
            completed.countDown()
        }
        if (!completed.await(COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            return Result.failure(IllegalStateException("等待 Android 播放器主线程超时"))
        }
        return result.get() ?: Result.failure(IllegalStateException("Android 播放器未返回结果"))
    }
}
