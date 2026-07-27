package dev.ani.tracker.mobile

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

/** 验证 Android 应用目录始终落在应用专属外部空间。 */
class AndroidAppDirectoryPolicyTest {
    /** 持久化数据进入 files，缓存和临时下载进入 cache。 */
    @Test
    fun resolvesExternalApplicationLayout() {
        val root = Files.createTempDirectory("ani-android-directories").toFile()
        try {
            val files = File(root, "Android/data/com.ani.tracker/files")
            val cache = File(root, "Android/data/com.ani.tracker/cache")
            val layout = AndroidAppDirectoryPolicy.resolve(files, cache)

            assertEquals(files, layout.userDataDir)
            assertEquals(File(files, "database/ani-tracker.sqlite"), layout.databasePath)
            assertEquals(cache, layout.cacheDir)
            assertEquals(File(files, "logs"), layout.logDir)
            assertEquals(File(files, "backups"), layout.backupDir)
            assertEquals(File(cache, "downloads"), layout.incompleteDir)
            assertEquals(File(files, "downloads"), layout.downloadDir)
        } finally {
            root.deleteRecursively()
        }
    }

    /** 外部缓存不可用时仍回退到 Android/data 的 files/cache。 */
    @Test
    fun keepsCacheInsideExternalFilesWhenExternalCacheIsUnavailable() {
        val files = File("/storage/emulated/0/Android/data/com.ani.tracker/files")
        val layout = AndroidAppDirectoryPolicy.resolve(files, null)

        assertEquals(File(files, "cache"), layout.cacheDir)
        assertEquals(File(files, "cache/downloads"), layout.incompleteDir)
    }
}
