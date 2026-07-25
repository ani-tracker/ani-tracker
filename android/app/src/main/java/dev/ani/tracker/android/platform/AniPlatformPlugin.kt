package dev.ani.tracker.android.platform

import android.os.Environment
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 提供目录、安全存储和受控应用调用，不向 WebView 暴露任意系统能力。 */
@CapacitorPlugin(name = "AniPlatform")
class AniPlatformPlugin : Plugin() {
    /** 记录插件完成加载，不输出路径或凭据。 */
    override fun load() {
        super.load()
        Log.i(TAG, "Android platform plugin loaded")
    }

    /** 创建并返回应用私有目录，供共享数据层生成移动端设置。 */
    @PluginMethod
    fun getDirectories(call: PluginCall) {
        try {
            val context = context
            val filesDir = context.filesDir
            val cacheDir = context.cacheDir
            val userDataDir = context.noBackupFilesDir
            val downloadDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                ?: File(filesDir, "downloads")
            val imageCacheDir = File(cacheDir, "images")
            val logDir = File(filesDir, "logs")
            val backupDir = File(filesDir, "backups")
            listOf(downloadDir, imageCacheDir, logDir, backupDir).forEach(::ensureDirectory)

            call.resolve(JSObject().apply {
                put("userDataDir", userDataDir.absolutePath)
                put("databasePath", context.getDatabasePath(DATABASE_FILE_NAME).absolutePath)
                put("filesDir", filesDir.absolutePath)
                put("downloadDir", downloadDir.absolutePath)
                put("cacheDir", cacheDir.absolutePath)
                put("imageCacheDir", imageCacheDir.absolutePath)
                put("logDir", logDir.absolutePath)
                put("backupDir", backupDir.absolutePath)
            })
            Log.i(TAG, "Android application directories prepared")
        } catch (error: Exception) {
            Log.e(TAG, "Failed to prepare application directories", error)
            call.reject("无法准备 Android 应用目录", error)
        }
    }

    /** 使用 Android Keystore 加密并保存单个敏感值。 */
    @PluginMethod
    fun secureSet(call: PluginCall) {
        val key = requireStorageKey(call) ?: return
        val value = call.getString("value")
        if (value == null) {
            call.reject("安全存储缺少 value")
            return
        }

        try {
            val encrypted = encrypt(value)
            val committed = preferences().edit().putString(key, encrypted).commit()
            if (!committed) {
                call.reject("安全存储写入失败")
                return
            }
            Log.i(TAG, "Secure value stored: $key")
            call.resolve()
        } catch (error: Exception) {
            Log.e(TAG, "Failed to store secure value: $key", error)
            call.reject("安全存储写入失败", error)
        }
    }

    /** 读取并解密单个敏感值。 */
    @PluginMethod
    fun secureGet(call: PluginCall) {
        val key = requireStorageKey(call) ?: return
        try {
            val encrypted = preferences().getString(key, null)
            call.resolve(JSObject().apply {
                if (encrypted != null) put("value", decrypt(encrypted))
            })
        } catch (error: Exception) {
            Log.e(TAG, "Failed to read secure value: $key", error)
            call.reject("安全存储读取失败", error)
        }
    }

    /** 删除一个安全存储值。 */
    @PluginMethod
    fun secureDelete(call: PluginCall) {
        val key = requireStorageKey(call) ?: return
        val committed = preferences().edit().remove(key).commit()
        if (!committed) {
            call.reject("安全存储删除失败")
            return
        }
        Log.i(TAG, "Secure value deleted: $key")
        call.resolve()
    }

    /** 执行 AppClient 白名单方法，后续阶段在此扩展业务端口。 */
    @PluginMethod
    fun invoke(call: PluginCall) {
        when (call.getString("method")) {
            "getAndroidBootstrapStatus" -> call.resolve(JSObject().put("value", "ready"))
            else -> call.reject("当前 Android 阶段尚未实现该业务方法")
        }
    }

    /** 校验键名，防止页面构造不可控的偏好项。 */
    private fun requireStorageKey(call: PluginCall): String? {
        val key = call.getString("key")
        if (key == null || !STORAGE_KEY_PATTERN.matches(key)) {
            call.reject("安全存储 key 无效")
            return null
        }
        return key
    }

    /** 获取应用私有凭据偏好。 */
    private fun preferences() = context.getSharedPreferences(PREFERENCES_NAME, android.content.Context.MODE_PRIVATE)

    /** 使用 AES-GCM 加密并将随机 IV 与密文共同编码。 */
    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
        val encrypted = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        return listOf(cipher.iv, encrypted).joinToString(ENCODED_SEPARATOR) {
            Base64.encodeToString(it, Base64.NO_WRAP)
        }
    }

    /** 解码 AES-GCM 数据，认证失败时拒绝返回内容。 */
    private fun decrypt(encoded: String): String {
        val parts = encoded.split(ENCODED_SEPARATOR, limit = 2)
        require(parts.size == 2) { "安全存储数据格式无效" }
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
        val plaintext = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP))
        return String(plaintext, StandardCharsets.UTF_8)
    }

    /** 从 Android Keystore 读取或首次创建不可导出的 AES 密钥。 */
    private fun getOrCreateSecretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        keyGenerator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return keyGenerator.generateKey()
    }

    /** 确保目录存在且不是同名普通文件。 */
    private fun ensureDirectory(directory: File) {
        check((directory.isDirectory || directory.mkdirs()) && directory.isDirectory) {
            "无法创建目录 ${directory.name}"
        }
    }

    companion object {
        private const val TAG = "AniPlatformPlugin"
        private const val DATABASE_FILE_NAME = "ani_trackerSQLite.db"
        private const val PREFERENCES_NAME = "ani_secure_store"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "ani_tracker_secure_store_v1"
        private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val ENCODED_SEPARATOR = "."
        private val STORAGE_KEY_PATTERN = Regex("^[A-Za-z0-9._-]{1,128}$")
    }
}
