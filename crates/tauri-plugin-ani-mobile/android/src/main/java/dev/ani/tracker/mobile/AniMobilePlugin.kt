package dev.ani.tracker.mobile

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.StatFs
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.nio.charset.StandardCharsets
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SecureKeyArgs {
    lateinit var key: String
}

@InvokeArg
class SecureValueArgs {
    lateinit var key: String
    lateinit var value: String
}

@InvokeArg
class ImportDocumentArgs {
    lateinit var uri: String
    lateinit var kind: String
}

@InvokeArg
class ExportDocumentArgs {
    lateinit var uri: String
    lateinit var sourcePath: String
}

/** 提供 Android 生命周期、运行约束和 Keystore 安全存储。 */
@TauriPlugin
class AniMobilePlugin(private val activity: Activity) : Plugin(activity) {
    private val lifecycle = AtomicReference("foreground")
    private val pendingNavigation = AtomicReference<String?>(null)

    /** 插件加载时恢复冷启动导航，并记录原生平台就绪。 */
    override fun load(webView: WebView) {
        captureNavigation(activity.intent)
        Log.i(LOG_TAG, "Android mobile platform plugin loaded")
    }

    /** 标记应用进入后台，供 Rust 核心决定恢复策略。 */
    override fun onPause() {
        lifecycle.set("background")
    }

    /** 标记应用返回前台，并接收当前 Activity 的启动导航。 */
    override fun onResume() {
        lifecycle.set("foreground")
        captureNavigation(activity.intent)
    }

    /** 捕获通知或系统入口传入的新导航意图。 */
    override fun onNewIntent(intent: Intent) {
        captureNavigation(intent)
    }

    /** 返回网络、存储、方向、通知权限和生命周期的确定状态。 */
    @Command
    fun status(invoke: Invoke) {
        try {
            val connectivity = connectivityStatus()
            val storage = storageStatus()
            invoke.resolve(JSObject().apply {
                put("lifecycle", lifecycle.get())
                put("network", connectivity.first)
                put("metered", connectivity.second)
                put("storage", storage.first)
                put("availableBytes", storage.second)
                put("orientation", orientationStatus())
                put("notificationPermission", notificationPermissionStatus())
            })
        } catch (error: Exception) {
            Log.e(LOG_TAG, "failed to read mobile platform status", error)
            invoke.reject("无法读取 Android 运行状态", "mobile_status_failed", error)
        }
    }

    /** 原子读取并清除最近一次原生导航意图。 */
    @Command
    fun consumeNavigation(invoke: Invoke) {
        val pageId = pendingNavigation.getAndSet(null)
        if (pageId == null) {
            invoke.resolve()
        } else {
            invoke.resolve(JSObject().put("pageId", pageId))
        }
    }

    /** Android 后台恢复由 WorkManager 直接处理，不要求 Renderer 补跑。 */
    @Command
    fun consumeBackgroundRefresh(invoke: Invoke) {
        invoke.resolve(JSObject().put("due", false))
    }

    /** 使用 Android Keystore 加密并保存一个敏感值。 */
    @Command
    fun secureSet(invoke: Invoke) {
        val args = parseSecureValue(invoke) ?: return
        try {
            val committed = preferences().edit().putString(args.key, encrypt(args.value)).commit()
            check(committed) { "安全存储写入未提交" }
            Log.i(LOG_TAG, "secure value stored: ${args.key}")
            invoke.resolve()
        } catch (error: Exception) {
            Log.e(LOG_TAG, "failed to store secure value", error)
            invoke.reject("Android 安全存储写入失败", "secure_store_failed", error)
        }
    }

    /** 读取并解密一个 Keystore 保护值。 */
    @Command
    fun secureGet(invoke: Invoke) {
        val key = parseSecureKey(invoke) ?: return
        try {
            val encrypted = preferences().getString(key, null)
            invoke.resolve(JSObject().apply {
                if (encrypted != null) put("value", decrypt(encrypted))
            })
        } catch (error: Exception) {
            Log.e(LOG_TAG, "failed to read secure value", error)
            invoke.reject("Android 安全存储读取失败", "secure_read_failed", error)
        }
    }

    /** 删除一个 Keystore 保护值。 */
    @Command
    fun secureDelete(invoke: Invoke) {
        val key = parseSecureKey(invoke) ?: return
        try {
            check(preferences().edit().remove(key).commit()) { "安全存储删除未提交" }
            Log.i(LOG_TAG, "secure value deleted: $key")
            invoke.resolve()
        } catch (error: Exception) {
            Log.e(LOG_TAG, "failed to delete secure value", error)
            invoke.reject("Android 安全存储删除失败", "secure_delete_failed", error)
        }
    }

    /** 将系统文档复制到应用私有缓存，供 Rust 安全校验和消费。 */
    @Command
    fun importDocument(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(ImportDocumentArgs::class.java)
        } catch (error: Exception) {
            invoke.reject("文档导入参数无效", "invalid_document_import", error)
            return
        }
        try {
            val uri = android.net.Uri.parse(args.uri)
            require(uri.scheme == "content") { "仅允许系统内容文档" }
            val (extension, limit) = when (args.kind) {
                "torrent" -> ".torrent" to MAX_TORRENT_BYTES
                "backup" -> ".sqlite" to MAX_BACKUP_BYTES
                else -> throw IllegalArgumentException("文档类型不受支持")
            }
            val directory = File(activity.cacheDir, "ani-document-imports").apply { mkdirs() }
            val target = File(directory, "${args.kind}-${UUID.randomUUID()}$extension")
            try {
                activity.contentResolver.openInputStream(uri).use { input ->
                    requireNotNull(input) { "无法打开所选文档" }
                    FileOutputStream(target).use { output -> copyWithLimit(input, output, limit) }
                }
            } catch (error: Exception) {
                target.delete()
                throw error
            }
            Log.i(LOG_TAG, "document imported kind=${args.kind} bytes=${target.length()}")
            invoke.resolve(JSObject().put("path", target.absolutePath))
        } catch (error: Exception) {
            Log.e(LOG_TAG, "failed to import document", error)
            invoke.reject("Android 文档导入失败", "document_import_failed", error)
        }
    }

    /** 将应用私有备份写入系统创建的文档，拒绝读取应用目录外文件。 */
    @Command
    fun exportDocument(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(ExportDocumentArgs::class.java)
        } catch (error: Exception) {
            invoke.reject("文档导出参数无效", "invalid_document_export", error)
            return
        }
        try {
            val uri = android.net.Uri.parse(args.uri)
            require(uri.scheme == "content") { "仅允许系统内容文档" }
            val source = File(args.sourcePath).canonicalFile
            require(source.isFile) { "待导出文件不存在" }
            require(isPrivateFile(source)) { "仅允许导出应用私有文件" }
            require(source.length() <= MAX_BACKUP_BYTES) { "待导出文件超过大小限制" }
            activity.contentResolver.openOutputStream(uri, "wt").use { output ->
                requireNotNull(output) { "无法写入所选文档" }
                source.inputStream().use { input -> copyWithLimit(input, output, MAX_BACKUP_BYTES) }
            }
            Log.i(LOG_TAG, "document exported bytes=${source.length()}")
            invoke.resolve()
        } catch (error: Exception) {
            Log.e(LOG_TAG, "failed to export document", error)
            invoke.reject("Android 文档导出失败", "document_export_failed", error)
        }
    }

    /** 解析并校验安全存储键值参数。 */
    private fun parseSecureValue(invoke: Invoke): SecureValueArgs? {
        val args = try {
            invoke.parseArgs(SecureValueArgs::class.java)
        } catch (error: Exception) {
            invoke.reject("安全存储参数无效", "invalid_secure_value", error)
            return null
        }
        if (!isValidKey(args.key)) {
            invoke.reject("安全存储 key 无效", "invalid_secure_key")
            return null
        }
        return args
    }

    /** 解析并校验安全存储键参数。 */
    private fun parseSecureKey(invoke: Invoke): String? {
        val args = try {
            invoke.parseArgs(SecureKeyArgs::class.java)
        } catch (error: Exception) {
            invoke.reject("安全存储参数无效", "invalid_secure_key", error)
            return null
        }
        if (!isValidKey(args.key)) {
            invoke.reject("安全存储 key 无效", "invalid_secure_key")
            return null
        }
        return args.key
    }

    /** 解析通知 PendingIntent 中的白名单页面。 */
    private fun captureNavigation(intent: Intent?) {
        val pageId = when (intent?.action) {
            ACTION_OPEN_DOWNLOADS -> "downloads"
            ACTION_OPEN_NOTIFICATIONS -> "notifications"
            else -> intent?.getStringExtra(EXTRA_PAGE_ID)
        }
        if (pageId in ALLOWED_PAGE_IDS) {
            pendingNavigation.set(pageId)
            intent?.action = null
            intent?.removeExtra(EXTRA_PAGE_ID)
            Log.i(LOG_TAG, "mobile navigation captured: $pageId")
        }
    }

    /** 将当前活动网络归一化为 online、limited 或 offline。 */
    private fun connectivityStatus(): Pair<String, Boolean> {
        val manager = activity.getSystemService(ConnectivityManager::class.java)
        val network = manager.activeNetwork ?: return "offline" to manager.isActiveNetworkMetered
        val capabilities = manager.getNetworkCapabilities(network)
            ?: return "offline" to manager.isActiveNetworkMetered
        val state = when {
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> "online"
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) -> "limited"
            else -> "offline"
        }
        return state to manager.isActiveNetworkMetered
    }

    /** 按应用私有分区剩余空间返回 ok、low 或 critical。 */
    private fun storageStatus(): Pair<String, Long> {
        val availableBytes = StatFs(activity.filesDir.absolutePath).availableBytes
        val state = when {
            availableBytes < CRITICAL_STORAGE_BYTES -> "critical"
            availableBytes < LOW_STORAGE_BYTES -> "low"
            else -> "ok"
        }
        return state to availableBytes
    }

    /** 返回当前横竖屏状态。 */
    private fun orientationStatus(): String = when (activity.resources.configuration.orientation) {
        Configuration.ORIENTATION_LANDSCAPE -> "landscape"
        Configuration.ORIENTATION_PORTRAIT -> "portrait"
        else -> "unknown"
    }

    /** 返回通知权限状态；旧系统无需运行时申请。 */
    private fun notificationPermissionStatus(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted"
        return if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            "granted"
        } else {
            "denied"
        }
    }

    /** 使用 AES-GCM 加密并编码随机 IV 与密文。 */
    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
        val encrypted = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        return listOf(cipher.iv, encrypted).joinToString(ENCODED_SEPARATOR) {
            Base64.encodeToString(it, Base64.NO_WRAP)
        }
    }

    /** 校验 AES-GCM 认证标签后返回明文。 */
    private fun decrypt(encoded: String): String {
        val parts = encoded.split(ENCODED_SEPARATOR, limit = 2)
        require(parts.size == 2) { "安全存储数据格式无效" }
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
        val plaintext = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP))
        return String(plaintext, StandardCharsets.UTF_8)
    }

    /** 从 Android Keystore 读取或创建不可导出的 AES 密钥。 */
    private fun getOrCreateSecretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    /** 返回仅当前应用可访问的密文偏好。 */
    private fun preferences() = activity.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    /** 限制键名字符和长度，避免构造任意偏好项。 */
    private fun isValidKey(key: String) = STORAGE_KEY_PATTERN.matches(key)

    /** 限制流复制大小，避免恶意文档耗尽应用存储。 */
    private fun copyWithLimit(input: java.io.InputStream, output: java.io.OutputStream, limit: Long) {
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            require(total <= limit) { "文档超过大小限制" }
            output.write(buffer, 0, count)
        }
        output.flush()
    }

    /** 判断文件是否位于当前应用拥有的目录中。 */
    private fun isPrivateFile(file: File): Boolean = listOf(
        activity.filesDir,
        activity.cacheDir,
        activity.noBackupFilesDir
    ).map(File::getCanonicalFile).any { root ->
        file == root || file.path.startsWith(root.path + File.separator)
    }

    companion object {
        const val ACTION_OPEN_DOWNLOADS = "com.ani.tracker.OPEN_DOWNLOADS"
        const val ACTION_OPEN_NOTIFICATIONS = "com.ani.tracker.OPEN_NOTIFICATIONS"
        const val EXTRA_PAGE_ID = "aniPageId"
        private const val LOG_TAG = "AniMobilePlugin"
        private const val PREFERENCES_NAME = "ani_secure_store"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "ani_tracker_secure_store_v1"
        private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val ENCODED_SEPARATOR = "."
        private const val CRITICAL_STORAGE_BYTES = 256L * 1024L * 1024L
        private const val LOW_STORAGE_BYTES = 1024L * 1024L * 1024L
        private const val MAX_TORRENT_BYTES = 32L * 1024L * 1024L
        private const val MAX_BACKUP_BYTES = 2L * 1024L * 1024L * 1024L
        private val STORAGE_KEY_PATTERN = Regex("^[A-Za-z0-9._-]{1,128}$")
        private val ALLOWED_PAGE_IDS = setOf("home", "downloads", "notifications")
    }
}
