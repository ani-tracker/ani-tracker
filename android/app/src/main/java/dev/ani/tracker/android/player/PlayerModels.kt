package dev.ani.tracker.android.player

/** VLC 会话当前所处的稳定播放阶段。 */
enum class PlayerStatus {
    IDLE,
    LOADING,
    READY,
    PLAYING,
    PAUSED,
    BUFFERING,
    ENDED,
    ERROR
}

/** 内置播放器可加载的一条外部字幕。 */
data class PlayerSubtitle(
    val id: String,
    val label: String,
    val uri: String,
    val language: String? = null,
    val isDefault: Boolean = false
)

/** 移动端播放列表中的单集媒体。 */
data class PlayerEpisode(
    val id: String,
    val title: String,
    val episodeLabel: String,
    val uri: String,
    val durationMillis: Long = 0L,
    val subtitles: List<PlayerSubtitle> = emptyList()
)

/** 业务层交给原生播放器的完整启动参数。 */
data class PlayerLaunchRequest(
    val sessionId: String,
    val animeTitle: String,
    val description: String,
    val artworkUri: String?,
    val episodes: List<PlayerEpisode>,
    val activeIndex: Int,
    val startPositionMillis: Long,
    val autoplay: Boolean
)

/** VLC 暴露给 UI 的音轨或字幕轨。 */
data class PlayerTrack(
    val id: Int,
    val label: String,
    val selected: Boolean
)

/** 移动端播放器的单一状态源。 */
data class PlayerUiState(
    val sessionId: String = "",
    val animeTitle: String = "Ani Tracker",
    val description: String = "",
    val artworkUri: String? = null,
    val episodes: List<PlayerEpisode> = emptyList(),
    val activeIndex: Int = 0,
    val status: PlayerStatus = PlayerStatus.IDLE,
    val positionMillis: Long = 0L,
    val durationMillis: Long = 0L,
    val bufferPercent: Float = 0f,
    val volume: Int = 70,
    val muted: Boolean = false,
    val playbackRate: Float = 1f,
    val audioTracks: List<PlayerTrack> = emptyList(),
    val subtitleTracks: List<PlayerTrack> = emptyList(),
    val aspectRatio: String? = null,
    val errorMessage: String? = null
) {
    val activeEpisode: PlayerEpisode?
        get() = episodes.getOrNull(activeIndex)
}
