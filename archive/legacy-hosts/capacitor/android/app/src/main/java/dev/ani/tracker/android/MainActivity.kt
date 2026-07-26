package dev.ani.tracker.android

import android.os.Bundle
import android.util.Log
import com.getcapacitor.BridgeActivity
import dev.ani.tracker.android.platform.AniPlatformPlugin

/** 承载共享 React UI，并注册 Android 独立平台插件。 */
class MainActivity : BridgeActivity() {
    /** 在 Capacitor 创建 Bridge 前注册应用自有插件。 */
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(AniPlatformPlugin::class.java)
        super.onCreate(savedInstanceState)
        Log.i(TAG, "Capacitor application host created")
    }

    companion object {
        private const val TAG = "AniMainActivity"
    }
}
