package dev.ani.tracker.torrent

/** 加载 JNI 库并隐藏原生运行时句柄。 */
internal object NativeTorrentCore {
    init {
        System.loadLibrary("ani_torrent_core")
    }

    /** 创建原生运行时并恢复应用私有目录中的任务。 */
    external fun nativeStart(dataDirectory: String): Long

    /** 执行一条与桌面端一致的 NDJSON 请求。 */
    external fun nativeExecute(handle: Long, requestJson: String): String

    /** 保存恢复数据并销毁原生运行时。 */
    external fun nativeStop(handle: Long)
}
