package dev.ani.tracker.android.player

import android.content.Context
import org.json.JSONObject
import java.security.MessageDigest

/** Android 原生播放器的一条本地续播记录。 */
data class MobilePlaybackCheckpoint(
    val positionMillis: Long,
    val durationMillis: Long,
    val completed: Boolean,
    val watched: Boolean,
    val updatedAtMillis: Long
)

/** 使用脱敏媒体键在 SharedPreferences 中保存原生播放进度。 */
class PlaybackCheckpointStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    /** 读取指定单集的续播记录，损坏内容按不存在处理。 */
    fun read(episode: PlayerEpisode): MobilePlaybackCheckpoint? {
        val serialized = preferences.getString(checkpointKey(episode), null) ?: return null
        return runCatching {
            val value = JSONObject(serialized)
            MobilePlaybackCheckpoint(
                positionMillis = value.optLong("positionMillis", 0L).coerceAtLeast(0L),
                durationMillis = value.optLong("durationMillis", 0L).coerceAtLeast(0L),
                completed = value.optBoolean("completed", false),
                watched = value.optBoolean("watched", false),
                updatedAtMillis = value.optLong("updatedAtMillis", 0L).coerceAtLeast(0L)
            )
        }.getOrNull()
    }

    /** 保存当前位置，并让 90% 已看状态跨重启保持单调。 */
    fun save(
        episode: PlayerEpisode,
        positionMillis: Long,
        durationMillis: Long,
        completed: Boolean
    ): MobilePlaybackCheckpoint {
        val normalizedDuration = durationMillis.coerceAtLeast(0L)
        val normalizedPosition = positionMillis.coerceIn(
            0L,
            normalizedDuration.takeIf { it > 0L } ?: Long.MAX_VALUE
        )
        val previous = read(episode)
        val checkpoint = MobilePlaybackCheckpoint(
            positionMillis = normalizedPosition,
            durationMillis = normalizedDuration,
            completed = completed,
            watched = previous?.watched == true || playbackPercent(normalizedPosition, normalizedDuration) >= 90.0,
            updatedAtMillis = System.currentTimeMillis()
        )
        preferences.edit()
            .putString(
                checkpointKey(episode),
                JSONObject().apply {
                    put("positionMillis", checkpoint.positionMillis)
                    put("durationMillis", checkpoint.durationMillis)
                    put("completed", checkpoint.completed)
                    put("watched", checkpoint.watched)
                    put("updatedAtMillis", checkpoint.updatedAtMillis)
                }.toString()
            )
            .apply()
        return checkpoint
    }

    /** 返回适合继续播放的位置，已播完或接近片尾时从头开始。 */
    fun resumePositionMillis(episode: PlayerEpisode): Long {
        val checkpoint = read(episode) ?: return 0L
        if (checkpoint.completed || checkpoint.positionMillis < MIN_RESUME_MILLIS) return 0L
        if (
            checkpoint.durationMillis > 0L
            && checkpoint.durationMillis - checkpoint.positionMillis <= END_RESUME_GUARD_MILLIS
        ) return 0L
        return checkpoint.positionMillis
    }

    /** 返回单集是否已跨过一次 90% 阈值。 */
    fun isWatched(episode: PlayerEpisode): Boolean = read(episode)?.watched == true

    /** 对稳定单集标识和媒体 URI 求摘要，避免把真实地址写入偏好键。 */
    private fun checkpointKey(episode: PlayerEpisode): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("${episode.id}|${episode.uri}".toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }
        return "checkpoint.$digest"
    }

    companion object {
        private const val PREFERENCES_NAME = "ani-player-checkpoints"
        private const val MIN_RESUME_MILLIS = 5_000L
        private const val END_RESUME_GUARD_MILLIS = 30_000L

        /** 将毫秒位置换算为受限百分比。 */
        fun playbackPercent(positionMillis: Long, durationMillis: Long): Double {
            if (durationMillis <= 0L) return 0.0
            return (positionMillis.toDouble() / durationMillis.toDouble() * 100.0).coerceIn(0.0, 100.0)
        }
    }
}
