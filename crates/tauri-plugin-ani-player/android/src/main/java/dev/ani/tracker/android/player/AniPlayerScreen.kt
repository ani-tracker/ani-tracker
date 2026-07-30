package dev.ani.tracker.android.player

import android.content.res.Configuration
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.AspectRatio
import androidx.compose.material.icons.rounded.CheckCircleOutline
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ClosedCaption
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.FastForward
import androidx.compose.material.icons.rounded.FastRewind
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.Headphones
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.NavigateBefore
import androidx.compose.material.icons.rounded.NavigateNext
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.PlaylistPlay
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.VolumeOff
import androidx.compose.material.icons.rounded.VolumeUp
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import org.videolan.libvlc.util.VLCVideoLayout

private val PlayerBlack = Color(0xFF050505)
private val PlayerWhite = Color(0xFFF8F8F7)
private val PlayerInk = Color(0xFF1D1B1B)
private val PlayerMuted = Color(0xFF756E6E)
private val PlayerAccent = Color(0xFFB5262D)
private val PlayerAccentSoft = Color(0xFFFFE7E7)

/** 提供播放器专用的高对比深色控件主题。 */
@Composable
fun AniPlayerTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = PlayerAccent,
            onPrimary = Color.White,
            surface = PlayerBlack,
            onSurface = Color.White
        ),
        content = content
    )
}

/** 根据设备方向渲染 Stitch 对应的移动播放器，并连接 VLC ViewModel。 */
@Composable
fun AniPlayerScreen(
    viewModel: AndroidVlcPlayerViewModel,
    missingMedia: Boolean,
    onClose: () -> Unit,
    onToggleFullscreen: () -> Unit
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    var controlsVisible by rememberSaveable { mutableStateOf(true) }
    var activitySequence by remember { mutableLongStateOf(0L) }

    /** 重新显示控件并重置三秒隐藏计时。 */
    fun revealControls() {
        controlsVisible = true
        activitySequence += 1
    }

    LaunchedEffect(state.status, activitySequence, controlsVisible) {
        if (state.status == PlayerStatus.PLAYING && controlsVisible && state.errorMessage == null) {
            delay(3_000)
            controlsVisible = false
        }
    }

    AdaptivePlayer(
        state = state,
        viewModel = viewModel,
        landscape = landscape,
        controlsVisible = controlsVisible,
        missingMedia = missingMedia,
        onClose = onClose,
        onActivity = ::revealControls,
        onToggleControls = { controlsVisible = !controlsVisible },
        onToggleFullscreen = onToggleFullscreen
    )
}

/** 在同一组合节点内切换竖横屏布局，避免重建 VLC 视频表面。 */
@Composable
private fun AdaptivePlayer(
    state: PlayerUiState,
    viewModel: AndroidVlcPlayerViewModel,
    landscape: Boolean,
    controlsVisible: Boolean,
    missingMedia: Boolean,
    onClose: () -> Unit,
    onActivity: () -> Unit,
    onToggleControls: () -> Unit,
    onToggleFullscreen: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(if (landscape) PlayerBlack else PlayerWhite)
    ) {
        Spacer(
            modifier = Modifier
                .fillMaxWidth()
                .then(
                    if (landscape) Modifier.height(0.dp)
                    else Modifier.windowInsetsTopHeight(WindowInsets.statusBars)
                )
                .background(PlayerBlack)
        )
        PlayerVideoStage(
            state = state,
            viewModel = viewModel,
            controlsVisible = controlsVisible,
            compact = !landscape,
            missingMedia = missingMedia,
            onClose = onClose,
            onActivity = onActivity,
            onToggleControls = onToggleControls,
            onToggleFullscreen = onToggleFullscreen,
            modifier = if (landscape) {
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
            } else {
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(16f / 9f)
            }
        )
        if (!landscape) {
            PlayerDetails(state)
            HorizontalDivider(color = Color(0xFFE7E1E1))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("播放列表", color = PlayerInk, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(8.dp))
                Text(
                    "(${state.activeIndex + 1}/${state.episodes.size})",
                    color = PlayerMuted,
                    fontSize = 12.sp
                )
            }
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .navigationBarsPadding(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 4.dp)
            ) {
                itemsIndexed(state.episodes, key = { _, episode -> episode.id }) { index, episode ->
                    EpisodeRow(
                        episode = episode,
                        index = index,
                        active = index == state.activeIndex,
                        completed = episode.id in state.watchedEpisodeIds,
                        onClick = { viewModel.selectEpisode(index) }
                    )
                }
            }
        }
    }
}

/** 组合 VLC Surface、手势、加载状态、错误提示和控制层。 */
@Composable
private fun PlayerVideoStage(
    state: PlayerUiState,
    viewModel: AndroidVlcPlayerViewModel,
    controlsVisible: Boolean,
    compact: Boolean,
    missingMedia: Boolean,
    onClose: () -> Unit,
    onActivity: () -> Unit,
    onToggleControls: () -> Unit,
    onToggleFullscreen: () -> Unit,
    modifier: Modifier
) {
    Box(
        modifier = modifier
            .background(PlayerBlack)
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = {
                        onToggleControls()
                    },
                    onDoubleTap = { offset ->
                        when {
                            offset.x < size.width / 3f -> viewModel.skipBy(-10_000L)
                            offset.x > size.width * 2f / 3f -> viewModel.skipBy(10_000L)
                            else -> viewModel.togglePlayback()
                        }
                        onActivity()
                    }
                )
            }
    ) {
        VlcVideoSurface(viewModel)
        AnimatedVisibility(
            visible = controlsVisible && !missingMedia && state.errorMessage == null,
            enter = fadeIn(),
            exit = fadeOut()
        ) {
            PlayerControls(
                state = state,
                viewModel = viewModel,
                compact = compact,
                onClose = onClose,
                onActivity = onActivity,
                onToggleFullscreen = onToggleFullscreen
            )
        }
        if (state.status == PlayerStatus.LOADING || state.status == PlayerStatus.BUFFERING) {
            CircularProgressIndicator(
                modifier = Modifier
                    .size(36.dp)
                    .align(Alignment.Center),
                color = Color.White,
                strokeWidth = 2.dp
            )
        }
        if (missingMedia || state.errorMessage != null || state.status == PlayerStatus.ERROR) {
            PlayerErrorOverlay(
                message = if (missingMedia) "缺少可播放的媒体地址" else state.errorMessage ?: "播放器发生未知错误",
                canRetry = !missingMedia,
                onRetry = viewModel::retry,
                onClose = onClose
            )
        }
        state.autoNextSecondsRemaining?.let { seconds ->
            AutoNextOverlay(
                episodeLabel = state.episodes.getOrNull(state.activeIndex + 1)?.episodeLabel ?: "下一集",
                seconds = seconds,
                compact = compact,
                onCancel = viewModel::cancelAutoNext,
                onPlayNow = viewModel::nextEpisode
            )
        }
    }
}

/** 在视频内显示可取消的自动下一集提示。 */
@Composable
private fun BoxScope.AutoNextOverlay(
    episodeLabel: String,
    seconds: Int,
    compact: Boolean,
    onCancel: () -> Unit,
    onPlayNow: () -> Unit
) {
    Surface(
        modifier = Modifier
            .align(Alignment.BottomEnd)
            .padding(end = 12.dp, bottom = if (compact) 68.dp else 84.dp),
        color = Color(0xF20E0E0E),
        contentColor = Color.White,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.18f))
    ) {
        Row(
            modifier = Modifier.padding(10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.width(116.dp)) {
                Text("${seconds} 秒后播放", color = Color.White.copy(alpha = 0.68f), fontSize = 11.sp)
                Text(
                    episodeLabel,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
            IconButton(onClick = onPlayNow, modifier = Modifier.size(44.dp)) {
                Icon(Icons.Rounded.NavigateNext, "立即播放下一集")
            }
            IconButton(onClick = onCancel, modifier = Modifier.size(44.dp)) {
                Icon(Icons.Rounded.Close, "取消自动下一集")
            }
        }
    }
}

/** 创建并按 Compose 生命周期绑定 VLCVideoLayout。 */
@Composable
private fun VlcVideoSurface(viewModel: AndroidVlcPlayerViewModel) {
    val context = LocalContext.current
    val videoLayout = remember { VLCVideoLayout(context) }
    DisposableEffect(videoLayout) {
        viewModel.attachVideoLayout(videoLayout)
        onDispose { viewModel.detachVideoLayout(videoLayout) }
    }
    AndroidView(
        factory = { videoLayout },
        modifier = Modifier.fillMaxSize()
    )
}

/** 渲染播放器顶部、中央与底部控制区。 */
@Composable
private fun PlayerControls(
    state: PlayerUiState,
    viewModel: AndroidVlcPlayerViewModel,
    compact: Boolean,
    onClose: () -> Unit,
    onActivity: () -> Unit,
    onToggleFullscreen: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.30f))
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.TopCenter)
                .background(Color.Black.copy(alpha = 0.36f))
                .then(if (compact) Modifier else Modifier.windowInsetsPadding(WindowInsets.safeDrawing))
                .padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            PlayerIconButton(Icons.Rounded.ArrowBack, "关闭播放器", onClose)
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    state.animeTitle,
                    color = Color.White,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = if (compact) 12.sp else 15.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (!compact) {
                    Text(
                        state.activeEpisode?.episodeLabel.orEmpty(),
                        color = Color.White.copy(alpha = 0.72f),
                        fontSize = 11.sp,
                        maxLines = 1
                    )
                }
            }
            if (!compact) {
                PlayerIconButton(
                    Icons.Rounded.NavigateBefore,
                    "上一集",
                    viewModel::previousEpisode,
                    enabled = state.activeIndex > 0
                )
                PlayerIconButton(
                    Icons.Rounded.NavigateNext,
                    "下一集",
                    viewModel::nextEpisode,
                    enabled = state.activeIndex < state.episodes.lastIndex
                )
                PlayerPlaylistMenu(state, viewModel, onActivity)
            }
            PlayerSettingsMenu(state, viewModel, onActivity)
        }

        Row(
            modifier = Modifier.align(Alignment.Center),
            horizontalArrangement = Arrangement.spacedBy(if (compact) 20.dp else 32.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            PlayerRoundAction(Icons.Rounded.FastRewind, "快退 10 秒") { viewModel.skipBy(-10_000L) }
            Surface(
                modifier = Modifier.size(if (compact) 54.dp else 68.dp),
                color = Color.Black.copy(alpha = 0.58f),
                contentColor = Color.White,
                shape = RoundedCornerShape(8.dp),
                border = BorderStroke(1.dp, Color.White.copy(alpha = 0.22f))
            ) {
                IconButton(onClick = viewModel::togglePlayback) {
                    Icon(
                        if (state.status == PlayerStatus.PLAYING) Icons.Rounded.Pause else Icons.Rounded.PlayArrow,
                        if (state.status == PlayerStatus.PLAYING) "暂停" else "播放"
                    )
                }
            }
            PlayerRoundAction(Icons.Rounded.FastForward, "快进 10 秒") { viewModel.skipBy(10_000L) }
        }

        PlaybackBottomBar(
            state = state,
            viewModel = viewModel,
            compact = compact,
            onActivity = onActivity,
            onToggleFullscreen = onToggleFullscreen,
            modifier = Modifier.align(Alignment.BottomCenter)
        )
    }
}

/** 渲染时间轴、音量、字幕、倍速和全屏操作。 */
@Composable
private fun PlaybackBottomBar(
    state: PlayerUiState,
    viewModel: AndroidVlcPlayerViewModel,
    compact: Boolean,
    onActivity: () -> Unit,
    onToggleFullscreen: () -> Unit,
    modifier: Modifier
) {
    var sliderValue by remember(state.activeIndex) { mutableStateOf(0f) }
    var seeking by remember { mutableStateOf(false) }
    LaunchedEffect(state.positionMillis, seeking) {
        if (!seeking) sliderValue = state.positionMillis.toFloat()
    }
    val duration = state.durationMillis.coerceAtLeast(1L).toFloat()

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Color.Black.copy(alpha = 0.54f))
            .then(if (compact) Modifier else Modifier.windowInsetsPadding(WindowInsets.safeDrawing))
            .padding(horizontal = if (compact) 8.dp else 18.dp, vertical = 4.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(formatTime(sliderValue.toLong()), color = Color.White, fontSize = 10.sp)
            Slider(
                value = sliderValue.coerceIn(0f, duration),
                onValueChange = {
                    seeking = true
                    sliderValue = it
                    onActivity()
                },
                onValueChangeFinished = {
                    seeking = false
                    viewModel.seekTo(sliderValue.toLong())
                },
                valueRange = 0f..duration,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 6.dp),
                colors = SliderDefaults.colors(
                    thumbColor = Color.White,
                    activeTrackColor = PlayerAccent,
                    inactiveTrackColor = Color.White.copy(alpha = 0.34f)
                )
            )
            Text(formatTime(state.durationMillis), color = Color.White, fontSize = 10.sp)
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(42.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            PlayerIconButton(
                if (state.muted) Icons.Rounded.VolumeOff else Icons.Rounded.VolumeUp,
                if (state.muted) "取消静音" else "静音",
                viewModel::toggleMuted
            )
            if (!compact) {
                Slider(
                    value = if (state.muted) 0f else state.volume.toFloat(),
                    onValueChange = { viewModel.setVolume(it.toInt()) },
                    valueRange = 0f..100f,
                    modifier = Modifier.width(96.dp),
                    colors = SliderDefaults.colors(
                        thumbColor = Color.White,
                        activeTrackColor = Color.White,
                        inactiveTrackColor = Color.White.copy(alpha = 0.28f)
                    )
                )
            }
            Spacer(Modifier.weight(1f))
            PlayerSubtitleMenu(state, viewModel, onActivity)
            Surface(
                color = Color.Black.copy(alpha = 0.45f),
                contentColor = Color.White,
                shape = RoundedCornerShape(3.dp),
                border = BorderStroke(1.dp, Color.White.copy(alpha = 0.25f)),
                modifier = Modifier.clickable {
                    val index = AndroidVlcPlayerViewModel.SUPPORTED_RATES.indexOf(state.playbackRate)
                    viewModel.setPlaybackRate(
                        AndroidVlcPlayerViewModel.SUPPORTED_RATES[(index + 1).mod(AndroidVlcPlayerViewModel.SUPPORTED_RATES.size)]
                    )
                    onActivity()
                }
            ) {
                Text(
                    "${formatRate(state.playbackRate)}x",
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
                    fontSize = 11.sp
                )
            }
            PlayerIconButton(Icons.Rounded.Fullscreen, "切换全屏", onToggleFullscreen)
        }
    }
}

/** 在横屏控制层中打开可直接切集的播放列表。 */
@Composable
private fun PlayerPlaylistMenu(
    state: PlayerUiState,
    viewModel: AndroidVlcPlayerViewModel,
    onActivity: () -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        PlayerIconButton(Icons.Rounded.PlaylistPlay, "播放列表", {
            expanded = true
            onActivity()
        })
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier.heightIn(max = 280.dp)
        ) {
            state.episodes.forEachIndexed { index, episode ->
                DropdownMenuItem(
                    text = {
                        Text(
                            "${(index + 1).toString().padStart(2, '0')}  ${episode.episodeLabel}",
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    },
                    leadingIcon = {
                        if (index == state.activeIndex) Icon(Icons.Rounded.PlayArrow, null)
                    },
                    onClick = {
                        viewModel.selectEpisode(index)
                        expanded = false
                    }
                )
            }
        }
    }
}

/** 打开字幕轨选择菜单，并提供明确的关闭字幕操作。 */
@Composable
private fun PlayerSubtitleMenu(
    state: PlayerUiState,
    viewModel: AndroidVlcPlayerViewModel,
    onActivity: () -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        PlayerIconButton(Icons.Rounded.ClosedCaption, "字幕", {
            expanded = true
            onActivity()
        })
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier.heightIn(max = 320.dp)
        ) {
            DropdownMenuItem(
                text = { Text("关闭字幕") },
                onClick = {
                    viewModel.selectSubtitleTrack(null)
                    expanded = false
                }
            )
            state.subtitleTracks.forEach { track ->
                DropdownMenuItem(
                    text = { Text(track.label, maxLines = 1) },
                    leadingIcon = {
                        if (track.selected) Icon(Icons.Rounded.CheckCircleOutline, null)
                    },
                    onClick = {
                        viewModel.selectSubtitleTrack(track.id)
                        expanded = false
                    }
                )
            }
            HorizontalDivider()
            AndroidVlcPlayerViewModel.SUPPORTED_SUBTITLE_SCALES.forEach { scale ->
                DropdownMenuItem(
                    text = { Text("字幕大小 $scale%") },
                    leadingIcon = {
                        if (scale == state.subtitleScale) Icon(Icons.Rounded.CheckCircleOutline, null)
                    },
                    onClick = {
                        viewModel.setSubtitleScale(scale)
                        expanded = false
                    }
                )
            }
        }
    }
}

/** 展示倍速、比例、音轨与字幕轨菜单。 */
@Composable
private fun PlayerSettingsMenu(
    state: PlayerUiState,
    viewModel: AndroidVlcPlayerViewModel,
    onActivity: () -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        PlayerIconButton(Icons.Rounded.Settings, "播放设置", {
            expanded = true
            onActivity()
        })
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier.heightIn(max = 360.dp)
        ) {
            DropdownMenuItem(
                text = { Text("画面比例 ${state.aspectRatio ?: "默认"}") },
                leadingIcon = { Icon(Icons.Rounded.AspectRatio, null) },
                onClick = {
                    viewModel.cycleAspectRatio()
                    expanded = false
                }
            )
            AndroidVlcPlayerViewModel.SUPPORTED_RATES.forEach { rate ->
                DropdownMenuItem(
                    text = { Text("${formatRate(rate)}x") },
                    leadingIcon = {
                        if (rate == state.playbackRate) Icon(Icons.Rounded.CheckCircleOutline, null)
                    },
                    onClick = {
                        viewModel.setPlaybackRate(rate)
                        expanded = false
                    }
                )
            }
            if (state.audioTracks.isNotEmpty()) {
                state.audioTracks.forEach { track ->
                    DropdownMenuItem(
                        text = { Text(track.label, maxLines = 1) },
                        leadingIcon = { Icon(Icons.Rounded.Headphones, null) },
                        onClick = {
                            viewModel.selectAudioTrack(track.id)
                            expanded = false
                        }
                    )
                }
            }
            DropdownMenuItem(
                text = { Text("关闭字幕") },
                leadingIcon = { Icon(Icons.Rounded.ClosedCaption, null) },
                onClick = {
                    viewModel.selectSubtitleTrack(null)
                    expanded = false
                }
            )
            state.subtitleTracks.forEach { track ->
                DropdownMenuItem(
                    text = { Text(track.label, maxLines = 1) },
                    leadingIcon = { Icon(Icons.Rounded.ClosedCaption, null) },
                    onClick = {
                        viewModel.selectSubtitleTrack(track.id)
                        expanded = false
                    }
                )
            }
            HorizontalDivider()
            AndroidVlcPlayerViewModel.SUPPORTED_SUBTITLE_SCALES.forEach { scale ->
                DropdownMenuItem(
                    text = { Text("字幕大小 $scale%") },
                    leadingIcon = {
                        if (scale == state.subtitleScale) Icon(Icons.Rounded.CheckCircleOutline, null)
                    },
                    onClick = {
                        viewModel.setSubtitleScale(scale)
                        expanded = false
                    }
                )
            }
        }
    }
}

/** 展示竖屏番剧标题、标签和简介。 */
@Composable
private fun PlayerDetails(state: PlayerUiState) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        AsyncImage(
            model = state.artworkUri,
            contentDescription = "${state.animeTitle} 封面",
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(width = 58.dp, height = 82.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(Color(0xFFE4DEDE))
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                state.animeTitle,
                color = PlayerInk,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                state.activeEpisode?.episodeLabel.orEmpty(),
                color = PlayerAccent,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 2.dp)
            )
            Row(
                modifier = Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                PlayerTag("VLC")
                PlayerTag("H.264 / HEVC")
                if (state.subtitleTracks.isNotEmpty()) PlayerTag("字幕")
            }
            if (state.description.isNotBlank()) {
                Text(
                    state.description,
                    color = PlayerMuted,
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
        }
    }
}

/** 绘制紧凑的播放器状态标签。 */
@Composable
private fun PlayerTag(label: String) {
    Surface(
        color = Color(0xFFF2ECEC),
        contentColor = PlayerMuted,
        shape = RoundedCornerShape(3.dp),
        border = BorderStroke(1.dp, Color(0xFFE5DCDC))
    ) {
        Text(label, modifier = Modifier.padding(horizontal = 6.dp, vertical = 3.dp), fontSize = 9.sp)
    }
}

/** 渲染单集列表状态，当前项使用设计稿的浅红强调。 */
@Composable
private fun EpisodeRow(
    episode: PlayerEpisode,
    index: Int,
    active: Boolean,
    completed: Boolean,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(if (active) PlayerAccentSoft else Color.Transparent)
            .then(if (active) Modifier.border(1.dp, PlayerAccent.copy(alpha = 0.16f), RoundedCornerShape(4.dp)) else Modifier)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            (index + 1).toString().padStart(2, '0'),
            color = if (active) PlayerAccent else PlayerMuted,
            fontSize = 11.sp,
            modifier = Modifier.width(28.dp)
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                episode.episodeLabel,
                color = if (active) PlayerAccent else PlayerInk,
                fontSize = 13.sp,
                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                when {
                    active -> "正在播放 · ${formatTime(episode.durationMillis)}"
                    completed -> "已看完"
                    else -> "未观看"
                },
                color = PlayerMuted,
                fontSize = 9.sp,
                modifier = Modifier.padding(top = 2.dp)
            )
        }
        Icon(
            when {
                active -> Icons.Rounded.VolumeUp
                completed -> Icons.Rounded.CheckCircleOutline
                else -> Icons.Rounded.MoreVert
            },
            contentDescription = null,
            tint = if (active) PlayerAccent else PlayerMuted,
            modifier = Modifier.size(18.dp)
        )
    }
}

/** 显示局部播放器错误，不替换整个应用外壳。 */
@Composable
private fun PlayerErrorOverlay(
    message: String,
    canRetry: Boolean,
    onRetry: () -> Unit,
    onClose: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.88f)),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Icon(
                Icons.Rounded.ErrorOutline,
                contentDescription = null,
                tint = Color(0xFFFFB4AB),
                modifier = Modifier.size(34.dp)
            )
            Text("播放失败", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
            Text(message, color = Color.White.copy(alpha = 0.72f), fontSize = 12.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (canRetry) {
                    Button(onClick = onRetry, colors = ButtonDefaults.buttonColors(containerColor = PlayerAccent)) {
                        Icon(Icons.Rounded.Refresh, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text("重试")
                    }
                }
                Button(
                    onClick = onClose,
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF343030))
                ) {
                    Icon(Icons.Rounded.Close, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("关闭")
                }
            }
        }
    }
}

/** 创建最小 48dp 的播放器图标按钮。 */
@Composable
private fun PlayerIconButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true
) {
    IconButton(onClick = onClick, enabled = enabled) {
        Icon(
            icon,
            contentDescription = label,
            tint = Color.White.copy(alpha = if (enabled) 1f else 0.34f)
        )
    }
}

/** 创建快进和快退圆形操作。 */
@Composable
private fun PlayerRoundAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit
) {
    Surface(
        modifier = Modifier.size(48.dp),
        color = Color.Black.copy(alpha = 0.48f),
        contentColor = Color.White,
        shape = RoundedCornerShape(24.dp)
    ) {
        IconButton(onClick = onClick) {
            Icon(icon, contentDescription = label)
        }
    }
}

/** 把毫秒位置格式化为播放器时间。 */
private fun formatTime(milliseconds: Long): String {
    val totalSeconds = (milliseconds.coerceAtLeast(0L) / 1_000L)
    val hours = totalSeconds / 3_600L
    val minutes = totalSeconds % 3_600L / 60L
    val seconds = totalSeconds % 60L
    return if (hours > 0L) "%d:%02d:%02d".format(hours, minutes, seconds)
    else "%02d:%02d".format(minutes, seconds)
}

/** 去除整数倍速不必要的小数位。 */
private fun formatRate(rate: Float): String = if (rate % 1f == 0f) rate.toInt().toString() else rate.toString()
