package dev.ani.tracker.android.player

import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** 定义业务页面与原生 VLC 播放器之间的最小 Intent 契约。 */
object PlayerLaunchContract {
    const val EXTRA_SESSION_ID = "dev.ani.tracker.player.SESSION_ID"
    const val EXTRA_MEDIA_URI = "dev.ani.tracker.player.MEDIA_URI"
    const val EXTRA_ANIME_TITLE = "dev.ani.tracker.player.ANIME_TITLE"
    const val EXTRA_EPISODE_LABEL = "dev.ani.tracker.player.EPISODE_LABEL"
    const val EXTRA_DESCRIPTION = "dev.ani.tracker.player.DESCRIPTION"
    const val EXTRA_ARTWORK_URI = "dev.ani.tracker.player.ARTWORK_URI"
    const val EXTRA_START_POSITION_MILLIS = "dev.ani.tracker.player.START_POSITION_MILLIS"
    const val EXTRA_AUTOPLAY = "dev.ani.tracker.player.AUTOPLAY"
    const val EXTRA_PLAYLIST_URIS = "dev.ani.tracker.player.PLAYLIST_URIS"
    const val EXTRA_PLAYLIST_TITLES = "dev.ani.tracker.player.PLAYLIST_TITLES"
    const val EXTRA_PLAYLIST_LABELS = "dev.ani.tracker.player.PLAYLIST_LABELS"
    const val EXTRA_PLAYLIST_JSON = "dev.ani.tracker.player.PLAYLIST_JSON"
    const val EXTRA_PLAYLIST_INDEX = "dev.ani.tracker.player.PLAYLIST_INDEX"
    const val EXTRA_SUBTITLE_URIS = "dev.ani.tracker.player.SUBTITLE_URIS"
    const val EXTRA_SUBTITLE_LABELS = "dev.ani.tracker.player.SUBTITLE_LABELS"

    /** 创建只携带播放参数、不暴露应用内部对象的原生播放器 Intent。 */
    fun createIntent(context: Context, request: PlayerLaunchRequest): Intent {
        val activeEpisode = request.episodes.getOrNull(request.activeIndex)
        return Intent(context, PlayerActivity::class.java).apply {
            putExtra(EXTRA_SESSION_ID, request.sessionId)
            putExtra(EXTRA_MEDIA_URI, activeEpisode?.uri)
            putExtra(EXTRA_ANIME_TITLE, request.animeTitle)
            putExtra(EXTRA_EPISODE_LABEL, activeEpisode?.episodeLabel)
            putExtra(EXTRA_DESCRIPTION, request.description)
            putExtra(EXTRA_ARTWORK_URI, request.artworkUri)
            putExtra(EXTRA_START_POSITION_MILLIS, request.startPositionMillis)
            putExtra(EXTRA_AUTOPLAY, request.autoplay)
            putStringArrayListExtra(EXTRA_PLAYLIST_URIS, ArrayList(request.episodes.map(PlayerEpisode::uri)))
            putStringArrayListExtra(EXTRA_PLAYLIST_TITLES, ArrayList(request.episodes.map(PlayerEpisode::title)))
            putStringArrayListExtra(EXTRA_PLAYLIST_LABELS, ArrayList(request.episodes.map(PlayerEpisode::episodeLabel)))
            putExtra(EXTRA_PLAYLIST_JSON, serializeEpisodes(request.episodes))
            putExtra(EXTRA_PLAYLIST_INDEX, request.activeIndex)
            putStringArrayListExtra(EXTRA_SUBTITLE_URIS, ArrayList(activeEpisode?.subtitles.orEmpty().map(PlayerSubtitle::uri)))
            putStringArrayListExtra(EXTRA_SUBTITLE_LABELS, ArrayList(activeEpisode?.subtitles.orEmpty().map(PlayerSubtitle::label)))
        }
    }

    /** 从外部参数构造安全的播放请求，缺少媒体地址时返回空。 */
    fun parse(intent: Intent): PlayerLaunchRequest? {
        val directUri = intent.getStringExtra(EXTRA_MEDIA_URI)?.trim().orEmpty()
            .ifBlank { intent.dataString?.trim().orEmpty() }
        val structuredEpisodes = parseEpisodes(intent.getStringExtra(EXTRA_PLAYLIST_JSON))
        val playlistUris = intent.getStringArrayListExtra(EXTRA_PLAYLIST_URIS)
            ?.map(String::trim)
            ?.filter(String::isNotEmpty)
            .orEmpty()
        val mediaUris = if (structuredEpisodes.isNotEmpty()) {
            structuredEpisodes.map(PlayerEpisode::uri)
        } else {
            playlistUris.ifEmpty { listOfNotNull(directUri.takeIf(String::isNotEmpty)) }
        }
        if (mediaUris.isEmpty()) return null

        val titles = intent.getStringArrayListExtra(EXTRA_PLAYLIST_TITLES).orEmpty()
        val labels = intent.getStringArrayListExtra(EXTRA_PLAYLIST_LABELS).orEmpty()
        val requestedIndex = intent.getIntExtra(EXTRA_PLAYLIST_INDEX, 0)
        val activeIndex = requestedIndex.coerceIn(0, mediaUris.lastIndex)
        val subtitleUris = intent.getStringArrayListExtra(EXTRA_SUBTITLE_URIS).orEmpty()
        val subtitleLabels = intent.getStringArrayListExtra(EXTRA_SUBTITLE_LABELS).orEmpty()
        val activeSubtitles = subtitleUris.mapIndexed { index, uri ->
            PlayerSubtitle(
                id = "subtitle-$index",
                label = subtitleLabels.getOrNull(index)?.takeIf(String::isNotBlank) ?: "字幕 ${index + 1}",
                uri = uri,
                isDefault = index == 0
            )
        }
        val animeTitle = intent.getStringExtra(EXTRA_ANIME_TITLE)?.takeIf(String::isNotBlank)
            ?: "Ani Tracker"
        val fallbackEpisodeLabel = intent.getStringExtra(EXTRA_EPISODE_LABEL)?.takeIf(String::isNotBlank)

        val episodes = structuredEpisodes.ifEmpty {
            mediaUris.mapIndexed { index, uri ->
                PlayerEpisode(
                    id = "episode-$index",
                    title = titles.getOrNull(index)?.takeIf(String::isNotBlank) ?: animeTitle,
                    episodeLabel = labels.getOrNull(index)?.takeIf(String::isNotBlank)
                        ?: fallbackEpisodeLabel
                        ?: "第 ${index + 1} 集",
                    uri = uri,
                    subtitles = if (index == activeIndex) activeSubtitles else emptyList()
                )
            }
        }

        return PlayerLaunchRequest(
            sessionId = intent.getStringExtra(EXTRA_SESSION_ID)?.takeIf(String::isNotBlank)
                ?: UUID.randomUUID().toString(),
            animeTitle = animeTitle,
            description = intent.getStringExtra(EXTRA_DESCRIPTION).orEmpty(),
            artworkUri = intent.getStringExtra(EXTRA_ARTWORK_URI)?.takeIf(String::isNotBlank),
            episodes = episodes,
            activeIndex = activeIndex,
            startPositionMillis = intent.getLongExtra(EXTRA_START_POSITION_MILLIS, 0L).coerceAtLeast(0L),
            autoplay = intent.getBooleanExtra(EXTRA_AUTOPLAY, true)
        )
    }

    /** 使用 Android 平台 JSON API 序列化完整播放列表。 */
    private fun serializeEpisodes(episodes: List<PlayerEpisode>): String {
        return JSONArray().apply {
            episodes.forEach { episode ->
                put(
                    JSONObject().apply {
                        put("id", episode.id)
                        put("title", episode.title)
                        put("episodeLabel", episode.episodeLabel)
                        put("uri", episode.uri)
                        put("durationMillis", episode.durationMillis)
                        put(
                            "subtitles",
                            JSONArray().apply {
                                episode.subtitles.forEach { subtitle ->
                                    put(
                                        JSONObject().apply {
                                            put("id", subtitle.id)
                                            put("label", subtitle.label)
                                            put("uri", subtitle.uri)
                                            put("language", subtitle.language)
                                            put("default", subtitle.isDefault)
                                        }
                                    )
                                }
                            }
                        )
                    }
                )
            }
        }.toString()
    }

    /** 解析新版结构化播放列表，异常数据降级到旧数组契约。 */
    private fun parseEpisodes(serialized: String?): List<PlayerEpisode> {
        if (serialized.isNullOrBlank()) return emptyList()
        return runCatching {
            val items = JSONArray(serialized)
            buildList {
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index) ?: continue
                    val uri = item.optString("uri").trim()
                    if (uri.isEmpty()) continue
                    val subtitlesJson = item.optJSONArray("subtitles") ?: JSONArray()
                    val subtitles = buildList {
                        for (subtitleIndex in 0 until subtitlesJson.length()) {
                            val subtitle = subtitlesJson.optJSONObject(subtitleIndex) ?: continue
                            val subtitleUri = subtitle.optString("uri").trim()
                            if (subtitleUri.isEmpty()) continue
                            add(
                                PlayerSubtitle(
                                    id = subtitle.optString("id", "subtitle-$subtitleIndex"),
                                    label = subtitle.optString("label", "字幕 ${subtitleIndex + 1}"),
                                    uri = subtitleUri,
                                    language = subtitle.optString("language").takeIf(String::isNotBlank),
                                    isDefault = subtitle.optBoolean("default", subtitleIndex == 0)
                                )
                            )
                        }
                    }
                    add(
                        PlayerEpisode(
                            id = item.optString("id", "episode-$index"),
                            title = item.optString("title", "Ani Tracker"),
                            episodeLabel = item.optString("episodeLabel", "第 ${index + 1} 集"),
                            uri = uri,
                            durationMillis = item.optLong("durationMillis", 0L).coerceAtLeast(0L),
                            subtitles = subtitles
                        )
                    )
                }
            }
        }.getOrDefault(emptyList())
    }
}
