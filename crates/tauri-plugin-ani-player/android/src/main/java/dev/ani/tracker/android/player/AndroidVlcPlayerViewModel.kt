package dev.ani.tracker.android.player

import android.app.Application
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.interfaces.IMedia
import org.videolan.libvlc.util.VLCVideoLayout

/** 在配置变更期间保留同一个 LibVLC 会话，并向 Compose 暴露稳定快照。 */
class AndroidVlcPlayerViewModel(application: Application) : AndroidViewModel(application) {
    private val stateFlow = MutableStateFlow(PlayerUiState())
    private val mainHandler = Handler(Looper.getMainLooper())
    private val checkpointStore = PlaybackCheckpointStore(application)
    private val audioManager = application.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).run {
        setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                .build()
        )
        setAcceptsDelayedFocusGain(false)
        setWillPauseWhenDucked(false)
        setOnAudioFocusChangeListener(::handleAudioFocusChange, mainHandler)
        build()
    }

    private var libVlc: LibVLC? = null
    private var mediaPlayer: MediaPlayer? = null
    private var attachedLayout: VLCVideoLayout? = null
    private var pendingStartPositionMillis = 0L
    private var pendingPlayUntilVideoAttached = false
    private var autoplay = true
    private var resumeAfterHostStop = false
    private var resumeAfterFocusGain = false
    private var released = false
    private var autoNextRunnable: Runnable? = null
    private val checkpointRunnable = object : Runnable {
        override fun run() {
            persistCheckpoint(
                completed = stateFlow.value.status == PlayerStatus.ENDED,
                reason = "interval"
            )
            if (!released) mainHandler.postDelayed(this, CHECKPOINT_INTERVAL_MILLIS)
        }
    }

    val state: StateFlow<PlayerUiState> = stateFlow.asStateFlow()

    init {
        initializeVlc()
        mainHandler.postDelayed(checkpointRunnable, CHECKPOINT_INTERVAL_MILLIS)
    }

    /** 初始化或替换当前业务播放会话。 */
    fun initialize(request: PlayerLaunchRequest) {
        if (
            stateFlow.value.sessionId == request.sessionId
            && stateFlow.value.episodes == request.episodes
            && stateFlow.value.status != PlayerStatus.IDLE
        ) {
            return
        }
        autoplay = request.autoplay
        persistCheckpoint(completed = stateFlow.value.status == PlayerStatus.ENDED, reason = "replace-session")
        val watchedEpisodeIds = request.episodes
            .filter(checkpointStore::isWatched)
            .mapTo(mutableSetOf(), PlayerEpisode::id)
        stateFlow.value = PlayerUiState(
            sessionId = request.sessionId,
            animeTitle = request.animeTitle,
            description = request.description,
            artworkUri = request.artworkUri,
            episodes = request.episodes,
            activeIndex = request.activeIndex,
            volume = stateFlow.value.volume,
            watchedEpisodeIds = watchedEpisodeIds
        )
        val activeEpisode = request.episodes.getOrNull(request.activeIndex)
        val startPosition = request.startPositionMillis.takeIf { it > 0L }
            ?: activeEpisode?.let(checkpointStore::resumePositionMillis)
            ?: 0L
        loadEpisode(request.activeIndex, startPosition)
    }

    /** 把当前 VLC 视频输出绑定到新建的原生 Surface。 */
    fun attachVideoLayout(layout: VLCVideoLayout) {
        if (attachedLayout === layout) return
        val player = mediaPlayer ?: return
        try {
            if (attachedLayout != null) player.detachViews()
            player.attachViews(layout, null, true, false)
            attachedLayout = layout
            Log.i(TAG, "Android libVLC 视频表面已绑定")
            if (pendingPlayUntilVideoAttached) {
                pendingPlayUntilVideoAttached = false
                play()
            }
        } catch (error: Throwable) {
            fail("视频表面初始化失败", error)
        }
    }

    /** 仅解绑仍由当前 Compose 节点持有的视频 Surface。 */
    fun detachVideoLayout(layout: VLCVideoLayout) {
        if (attachedLayout !== layout) return
        try {
            mediaPlayer?.detachViews()
        } catch (error: Throwable) {
            Log.w(TAG, "Android libVLC 视频表面解绑失败", error)
        } finally {
            attachedLayout = null
        }
    }

    /** 在宿主进入后台时暂停，旋转重建时保持播放会话。 */
    fun onHostStop(changingConfigurations: Boolean) {
        if (changingConfigurations) return
        persistCheckpoint(completed = stateFlow.value.status == PlayerStatus.ENDED, reason = "host-stop")
        resumeAfterHostStop = mediaPlayer?.isPlaying == true
        if (resumeAfterHostStop) pauseInternal(abandonFocus = true)
    }

    /** 返回前台后仅恢复由生命周期自动暂停的媒体。 */
    fun onHostStart() {
        if (!resumeAfterHostStop) return
        resumeAfterHostStop = false
        play()
    }

    /** 在播放与暂停之间切换。 */
    fun togglePlayback() {
        if (mediaPlayer?.isPlaying == true || pendingPlayUntilVideoAttached) pause() else play()
    }

    /** 获取音频焦点并开始或继续播放。 */
    fun play() {
        val player = mediaPlayer ?: return
        if (attachedLayout == null) {
            pendingPlayUntilVideoAttached = true
            patch(status = PlayerStatus.READY, errorMessage = null)
            Log.i(TAG, "Android libVLC 等待视频表面后开始播放")
            return
        }
        if (audioManager.requestAudioFocus(audioFocusRequest) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            stateFlow.value = stateFlow.value.copy(
                status = PlayerStatus.PAUSED,
                errorMessage = "暂时无法获取媒体音频焦点"
            )
            return
        }
        try {
            player.play()
            stateFlow.value = stateFlow.value.copy(errorMessage = null)
        } catch (error: Throwable) {
            fail("无法开始播放当前媒体", error)
        }
    }

    /** 暂停当前媒体并释放音频焦点。 */
    fun pause() {
        pendingPlayUntilVideoAttached = false
        resumeAfterHostStop = false
        resumeAfterFocusGain = false
        pauseInternal(abandonFocus = true)
        persistCheckpoint(completed = false, reason = "pause")
    }

    /** 跳转到当前媒体中的合法毫秒位置。 */
    fun seekTo(positionMillis: Long) {
        val duration = stateFlow.value.durationMillis
        val target = positionMillis.coerceIn(0L, duration.takeIf { it > 0L } ?: Long.MAX_VALUE)
        try {
            mediaPlayer?.setTime(target, true)
            stateFlow.value = stateFlow.value.copy(positionMillis = target)
        } catch (error: Throwable) {
            fail("播放进度跳转失败", error)
        }
    }

    /** 相对当前进度快进或快退。 */
    fun skipBy(deltaMillis: Long) {
        seekTo(stateFlow.value.positionMillis + deltaMillis)
    }

    /** 设置 0 到 100 的 VLC 音量，调节时自动取消静音。 */
    fun setVolume(volume: Int) {
        val normalized = volume.coerceIn(0, 100)
        mediaPlayer?.setVolume(normalized)
        stateFlow.value = stateFlow.value.copy(volume = normalized, muted = false)
    }

    /** 切换静音并保留用户原音量。 */
    fun toggleMuted() {
        setMuted(!stateFlow.value.muted)
    }

    /** 显式设置静音状态，供 Tauri 统一命令调用。 */
    fun setMuted(muted: Boolean) {
        mediaPlayer?.setVolume(if (muted) 0 else stateFlow.value.volume)
        stateFlow.value = stateFlow.value.copy(muted = muted)
    }

    /** 设置播放器支持的离散倍速。 */
    fun setPlaybackRate(rate: Float) {
        val normalized = SUPPORTED_RATES.minByOrNull { kotlin.math.abs(it - rate) } ?: 1f
        mediaPlayer?.setRate(normalized)
        stateFlow.value = stateFlow.value.copy(playbackRate = normalized)
    }

    /** 在默认、16:9 与 4:3 画面比例之间循环。 */
    fun cycleAspectRatio() {
        val next = when (stateFlow.value.aspectRatio) {
            null -> "16:9"
            "16:9" -> "4:3"
            else -> null
        }
        setAspectRatio(next)
    }

    /** 应用统一播放器契约中的画面比例。 */
    fun setAspectRatio(aspectRatio: String?) {
        val next = aspectRatio?.takeUnless { it == "default" || it == "fit" }
        mediaPlayer?.setScale(0f)
        mediaPlayer?.setAspectRatio(next)
        stateFlow.value = stateFlow.value.copy(aspectRatio = next)
    }

    /** 切换 VLC 音轨。 */
    fun selectAudioTrack(trackId: Int) {
        if (mediaPlayer?.setAudioTrack(trackId) == true) refreshTracks()
    }

    /** 切换 VLC 字幕轨，空值表示关闭字幕。 */
    fun selectSubtitleTrack(trackId: Int?) {
        if (mediaPlayer?.setSpuTrack(trackId ?: -1) == true) refreshTracks()
    }

    /** 切换到播放列表中的指定单集。 */
    fun selectEpisode(index: Int) {
        loadEpisode(index, null)
    }

    /** 播放上一集，列表首项保持不变。 */
    fun previousEpisode() {
        val target = stateFlow.value.activeIndex - 1
        if (target >= 0) loadEpisode(target, null)
    }

    /** 播放下一集，列表末项保持结束状态。 */
    fun nextEpisode() {
        val target = stateFlow.value.activeIndex + 1
        if (target < stateFlow.value.episodes.size) loadEpisode(target, null)
    }

    /** 取消片尾自动下一集并保留结束画面。 */
    fun cancelAutoNext() {
        cancelAutoNextCountdown()
        Log.i(TAG, "Android 自动下一集已取消")
    }

    /** 使用当前单集和位置重建媒体对象。 */
    fun retry() {
        loadEpisode(stateFlow.value.activeIndex, stateFlow.value.positionMillis)
    }

    /** 停止当前媒体，供宿主主动关闭前调用。 */
    fun closePlayback() {
        pendingPlayUntilVideoAttached = false
        resumeAfterHostStop = false
        resumeAfterFocusGain = false
        persistCheckpoint(completed = stateFlow.value.status == PlayerStatus.ENDED, reason = "close")
        cancelAutoNextCountdown()
        try {
            mediaPlayer?.stop()
        } catch (error: Throwable) {
            Log.w(TAG, "Android libVLC 停止失败", error)
        }
        audioManager.abandonAudioFocusRequest(audioFocusRequest)
    }

    /** 释放原生播放器、视频表面和 libVLC 运行时。 */
    override fun onCleared() {
        persistCheckpoint(completed = stateFlow.value.status == PlayerStatus.ENDED, reason = "release")
        released = true
        mainHandler.removeCallbacksAndMessages(null)
        audioManager.abandonAudioFocusRequest(audioFocusRequest)
        try {
            mediaPlayer?.setEventListener(null)
            mediaPlayer?.stop()
            mediaPlayer?.detachViews()
            mediaPlayer?.release()
            libVlc?.release()
            Log.i(TAG, "Android libVLC 播放会话已释放")
        } catch (error: Throwable) {
            Log.w(TAG, "Android libVLC 释放失败", error)
        } finally {
            pendingPlayUntilVideoAttached = false
            attachedLayout = null
            mediaPlayer = null
            libVlc = null
        }
        super.onCleared()
    }

    /** 创建固定版本的 libVLC 运行时和媒体实例。 */
    private fun initializeVlc() {
        try {
            val runtime = LibVLC(
                getApplication(),
                mutableListOf(
                    "--audio-time-stretch",
                    "--network-caching=1500",
                    "--file-caching=500"
                )
            )
            libVlc = runtime
            mediaPlayer = MediaPlayer(runtime).also { player ->
                player.setEventListener(::handleVlcEvent)
                player.setVolume(stateFlow.value.volume)
            }
            Log.i(TAG, "Android libVLC 运行时初始化完成")
        } catch (error: Throwable) {
            fail("libVLC 原生运行时不可用", error)
        }
    }

    /** 创建新的 VLC Media，并在同一 ViewModel 内保持播放列表会话。 */
    private fun loadEpisode(index: Int, startPositionMillis: Long?) {
        val episode = stateFlow.value.episodes.getOrNull(index) ?: return
        val runtime = libVlc
        val player = mediaPlayer
        if (runtime == null || player == null) {
            fail("libVLC 原生运行时尚未就绪")
            return
        }
        persistCheckpoint(completed = stateFlow.value.status == PlayerStatus.ENDED, reason = "switch-item")
        cancelAutoNextCountdown()
        pendingStartPositionMillis = (startPositionMillis
            ?: checkpointStore.resumePositionMillis(episode)).coerceAtLeast(0L)
        stateFlow.value = stateFlow.value.copy(
            activeIndex = index,
            status = PlayerStatus.LOADING,
            positionMillis = pendingStartPositionMillis,
            durationMillis = episode.durationMillis,
            bufferPercent = 0f,
            audioTracks = emptyList(),
            subtitleTracks = emptyList(),
            errorMessage = null
        )

        try {
            player.stop()
            val media = Media(runtime, Uri.parse(episode.uri)).apply {
                setHWDecoderEnabled(true, false)
                addOption(":network-caching=1500")
                episode.subtitles.forEach { subtitle ->
                    addSlave(IMedia.Slave(IMedia.Slave.Type.Subtitle, 4, subtitle.uri))
                }
            }
            player.setMedia(media)
            media.release()
            if (autoplay) play() else stateFlow.value = stateFlow.value.copy(status = PlayerStatus.READY)
            Log.i(TAG, "Android libVLC 已加载媒体: session=${stateFlow.value.sessionId}, index=$index")
        } catch (error: Throwable) {
            fail("当前媒体无法加载", error)
        }
    }

    /** 将 libVLC 原生事件归一为 UI 快照。 */
    private fun handleVlcEvent(event: MediaPlayer.Event) {
        if (released) return
        when (event.type) {
            MediaPlayer.Event.Opening -> patch(status = PlayerStatus.LOADING)
            MediaPlayer.Event.Buffering -> {
                val percent = event.buffering.coerceIn(0f, 100f)
                patch(
                    status = if (mediaPlayer?.isPlaying == true) {
                        PlayerStatus.PLAYING
                    } else if (percent < 100f) {
                        PlayerStatus.BUFFERING
                    } else {
                        stateFlow.value.status
                    },
                    bufferPercent = percent
                )
            }
            MediaPlayer.Event.Playing -> {
                applyPendingStartPosition()
                patch(status = PlayerStatus.PLAYING, errorMessage = null)
                refreshTracks()
                Log.i(TAG, "Android libVLC 播放状态已确认")
            }
            MediaPlayer.Event.Paused -> patch(status = PlayerStatus.PAUSED)
            MediaPlayer.Event.TimeChanged -> {
                val wasPlaying = stateFlow.value.status == PlayerStatus.PLAYING
                patch(
                    status = if (mediaPlayer?.isPlaying == true) {
                        PlayerStatus.PLAYING
                    } else {
                        stateFlow.value.status
                    },
                    positionMillis = event.timeChanged.coerceAtLeast(0L)
                )
                if (!wasPlaying && stateFlow.value.status == PlayerStatus.PLAYING) {
                    Log.i(TAG, "Android libVLC 时间推进已同步播放状态")
                }
                persistWatchedThresholdIfNeeded()
            }
            MediaPlayer.Event.LengthChanged -> patch(durationMillis = event.lengthChanged.coerceAtLeast(0L))
            MediaPlayer.Event.ESAdded,
            MediaPlayer.Event.ESDeleted,
            MediaPlayer.Event.ESSelected -> refreshTracks()
            MediaPlayer.Event.EndReached -> {
                audioManager.abandonAudioFocusRequest(audioFocusRequest)
                patch(
                    status = PlayerStatus.ENDED,
                    positionMillis = stateFlow.value.durationMillis
                )
                persistCheckpoint(completed = true, reason = "ended")
                startAutoNextCountdown()
            }
            MediaPlayer.Event.EncounteredError -> fail("libVLC 无法解码或读取当前媒体")
        }
    }

    /** 在媒体真正开始播放后应用续播位置。 */
    private fun applyPendingStartPosition() {
        val target = pendingStartPositionMillis
        if (target <= 0L) return
        pendingStartPositionMillis = 0L
        mediaPlayer?.setTime(target, true)
        patch(positionMillis = target)
    }

    /** 每十秒及关键生命周期节点保存当前单集，并同步 90% 已看集合。 */
    private fun persistCheckpoint(completed: Boolean, reason: String) {
        val state = stateFlow.value
        val episode = state.activeEpisode ?: return
        if (state.durationMillis <= 0L) return
        val checkpoint = checkpointStore.save(
            episode = episode,
            positionMillis = state.positionMillis,
            durationMillis = state.durationMillis,
            completed = completed
        )
        if (checkpoint.watched && episode.id !in state.watchedEpisodeIds) {
            stateFlow.value = stateFlow.value.copy(
                watchedEpisodeIds = stateFlow.value.watchedEpisodeIds + episode.id
            )
            Log.i(TAG, "Android 单集首次达到 90%: episode=${episode.id}")
        }
        Log.d(TAG, "Android 续播位置已保存: reason=$reason, position=${checkpoint.positionMillis}")
    }

    /** 首次达到 90% 时立即持久化，避免在下一次定时保存前回退而漏标。 */
    private fun persistWatchedThresholdIfNeeded() {
        val state = stateFlow.value
        val episode = state.activeEpisode ?: return
        if (episode.id in state.watchedEpisodeIds || state.durationMillis <= 0L) return
        if (PlaybackCheckpointStore.playbackPercent(state.positionMillis, state.durationMillis) >= 90.0) {
            persistCheckpoint(completed = false, reason = "watched-threshold")
        }
    }

    /** 在片尾启动五秒倒计时，到期后加载下一集。 */
    private fun startAutoNextCountdown() {
        val target = stateFlow.value.activeIndex + 1
        if (target !in stateFlow.value.episodes.indices) return
        cancelAutoNextCountdown()
        var remaining = AUTO_NEXT_COUNTDOWN_SECONDS
        stateFlow.value = stateFlow.value.copy(autoNextSecondsRemaining = remaining)
        val runnable = object : Runnable {
            override fun run() {
                remaining -= 1
                if (remaining <= 0) {
                    autoNextRunnable = null
                    stateFlow.value = stateFlow.value.copy(autoNextSecondsRemaining = null)
                    loadEpisode(target, null)
                    return
                }
                stateFlow.value = stateFlow.value.copy(autoNextSecondsRemaining = remaining)
                mainHandler.postDelayed(this, 1_000L)
            }
        }
        autoNextRunnable = runnable
        mainHandler.postDelayed(runnable, 1_000L)
    }

    /** 停止仍在运行的自动切集倒计时。 */
    private fun cancelAutoNextCountdown() {
        autoNextRunnable?.let(mainHandler::removeCallbacks)
        autoNextRunnable = null
        if (stateFlow.value.autoNextSecondsRemaining != null) {
            stateFlow.value = stateFlow.value.copy(autoNextSecondsRemaining = null)
        }
    }

    /** 从 libVLC 读取最新音轨与字幕轨选择。 */
    private fun refreshTracks() {
        val player = mediaPlayer ?: return
        try {
            val selectedAudioTrack = player.audioTrack
            val selectedSubtitleTrack = player.spuTrack
            stateFlow.value = stateFlow.value.copy(
                audioTracks = player.audioTracks.orEmpty().map { track ->
                    PlayerTrack(track.id, track.name, track.id == selectedAudioTrack)
                },
                subtitleTracks = player.spuTracks.orEmpty().map { track ->
                    PlayerTrack(track.id, track.name, track.id == selectedSubtitleTrack)
                }
            )
        } catch (error: Throwable) {
            Log.w(TAG, "Android libVLC 轨道读取失败", error)
        }
    }

    /** 处理系统音频焦点抢占、暂失和降低音量。 */
    private fun handleAudioFocusChange(focusChange: Int) {
        when (focusChange) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                mediaPlayer?.setVolume(if (stateFlow.value.muted) 0 else stateFlow.value.volume)
                if (resumeAfterFocusGain) {
                    resumeAfterFocusGain = false
                    play()
                }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                resumeAfterFocusGain = mediaPlayer?.isPlaying == true
                pauseInternal(abandonFocus = false)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                mediaPlayer?.setVolume((stateFlow.value.volume * 0.2f).toInt())
            }
            AudioManager.AUDIOFOCUS_LOSS -> {
                resumeAfterFocusGain = false
                pauseInternal(abandonFocus = true)
            }
        }
    }

    /** 执行不改变用户恢复意图的底层暂停。 */
    private fun pauseInternal(abandonFocus: Boolean) {
        try {
            if (mediaPlayer?.isPlaying == true) mediaPlayer?.pause()
            patch(status = PlayerStatus.PAUSED)
        } catch (error: Throwable) {
            fail("暂停播放失败", error)
        }
        if (abandonFocus) audioManager.abandonAudioFocusRequest(audioFocusRequest)
    }

    /** 原子更新常用播放字段，避免原生回调覆盖其他状态。 */
    private fun patch(
        status: PlayerStatus = stateFlow.value.status,
        positionMillis: Long = stateFlow.value.positionMillis,
        durationMillis: Long = stateFlow.value.durationMillis,
        bufferPercent: Float = stateFlow.value.bufferPercent,
        errorMessage: String? = stateFlow.value.errorMessage
    ) {
        stateFlow.value = stateFlow.value.copy(
            status = status,
            positionMillis = positionMillis,
            durationMillis = durationMillis,
            bufferPercent = bufferPercent,
            errorMessage = errorMessage
        )
    }

    /** 记录脱敏错误并切换到可恢复错误状态。 */
    private fun fail(message: String, error: Throwable? = null) {
        if (error == null) Log.e(TAG, message) else Log.e(TAG, message, error)
        stateFlow.value = stateFlow.value.copy(
            status = PlayerStatus.ERROR,
            errorMessage = message
        )
    }

    companion object {
        private const val TAG = "AniVlcPlayer"
        private const val CHECKPOINT_INTERVAL_MILLIS = 10_000L
        private const val AUTO_NEXT_COUNTDOWN_SECONDS = 5
        val SUPPORTED_RATES = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)
    }
}
