import Foundation

/** 原生播放器当前所处的稳定阶段。 */
enum PlayerStatus: Equatable {
    case idle
    case loading
    case ready
    case playing
    case paused
    case buffering
    case ended
    case error
}

/** iOS 播放器支持的离散画面比例。 */
enum PlayerAspectRatio: String, CaseIterable, Identifiable {
    case automatic
    case widescreen
    case standard

    var id: String { rawValue }

    var title: String {
        switch self {
        case .automatic: "默认"
        case .widescreen: "16:9"
        case .standard: "4:3"
        }
    }

    var vlcValue: String? {
        switch self {
        case .automatic: nil
        case .widescreen: "16:9"
        case .standard: "4:3"
        }
    }
}

/** 一条可由 MobileVLCKit 加载的外部字幕。 */
struct PlayerSubtitle: Identifiable, Hashable {
    let id: String
    let label: String
    let url: URL
    let language: String?
    let isDefault: Bool
}

/** 移动播放列表中的单集媒体。 */
struct PlayerEpisode: Identifiable, Hashable {
    let id: String
    let title: String
    let episodeLabel: String
    let mediaURL: URL
    let durationMilliseconds: Int64
    let subtitles: [PlayerSubtitle]
}

/** 业务页面打开原生播放器时传递的完整参数。 */
struct PlayerLaunchRequest: Equatable {
    let sessionID: String
    let animeTitle: String
    let synopsis: String
    let artworkURL: URL?
    let episodes: [PlayerEpisode]
    let activeIndex: Int
    let startPositionMilliseconds: Int64
    let autoplay: Bool
}

/** MobileVLCKit 暴露给 SwiftUI 的音轨或字幕轨。 */
struct PlayerTrack: Identifiable, Equatable {
    let id: Int32
    let label: String
    let selected: Bool
}

/** SwiftUI 只依赖该快照，不直接读取 VLCMediaPlayer。 */
struct PlayerSnapshot: Equatable {
    var sessionID = ""
    var animeTitle = "Ani Tracker"
    var synopsis = ""
    var artworkURL: URL?
    var episodes: [PlayerEpisode] = []
    var activeIndex = 0
    var status: PlayerStatus = .idle
    var positionMilliseconds: Int64 = 0
    var durationMilliseconds: Int64 = 0
    var volume: Int32 = 70
    var muted = false
    var playbackRate: Float = 1
    var audioTracks: [PlayerTrack] = []
    var subtitleTracks: [PlayerTrack] = []
    var aspectRatio: PlayerAspectRatio = .automatic
    var watchedEpisodeIDs: Set<String> = []
    var autoNextSecondsRemaining: Int?
    var errorMessage: String?

    var activeEpisode: PlayerEpisode? {
        episodes.indices.contains(activeIndex) ? episodes[activeIndex] : nil
    }
}
