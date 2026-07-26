package dev.ani.tracker.torrent

import org.json.JSONObject

/** Android 下载核心的保守默认值，与 TypeScript 平台设置保持一致。 */
internal object AndroidTorrentDefaults {
    /** 生成首次启动时发送给原生核心的 configure 请求。 */
    fun configureRequest(): String {
        val seedingLimits = JSONObject()
            .put("enabled", false)
            .put("ratioEnabled", false)
            .put("ratioLimit", 1.0)
            .put("timeEnabled", false)
            .put("timeLimitMinutes", 120)
        val params = JSONObject()
            .put("listenPort", 51413)
            .put("dhtEnabled", true)
            .put("upnpEnabled", false)
            .put("maxActiveDownloads", 1)
            .put("maxDownloadSpeed", 0)
            .put("maxUploadSpeed", 0)
            .put("seedingLimits", seedingLimits)
        return JSONObject()
            .put("id", "android-defaults")
            .put("method", "configure")
            .put("params", params)
            .toString()
    }
}
