import AVFoundation
import Combine
import Foundation
import MobileVLCKit
import OSLog
import UIKit

/** 将 MobileVLCKit 映射为 SwiftUI 可观察的单一播放器状态。 */
final class MobileVLCPlayerController: NSObject, ObservableObject, VLCMediaPlayerDelegate {
    static let supportedRates: [Float] = [0.5, 0.75, 1, 1.25, 1.5, 2]

    @Published private(set) var snapshot = PlayerSnapshot()

    private let mediaPlayer: VLCMediaPlayer
    private let audioSession = AVAudioSession.sharedInstance()
    private let logger = Logger(subsystem: "dev.ani.tracker", category: "MobileVLCKit")
    private weak var attachedView: UIView?
    private var pendingStartPosition: Int64 = 0
    private var pendingSubtitles: [PlayerSubtitle] = []
    private var subtitlesAttached = false
    private var autoplay = true
    private var resumeAfterBackground = false
    private var resumeAfterInterruption = false
    private var securityScopedURL: URL?

    /** 创建固定缓存策略的 MobileVLCKit 播放器并监听音频中断。 */
    override init() {
        mediaPlayer = VLCMediaPlayer(options: [
            "--audio-time-stretch",
            "--network-caching=1500",
            "--file-caching=500"
        ])
        super.init()
        mediaPlayer.delegate = self
        mediaPlayer.audio.volume = snapshot.volume
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: audioSession
        )
        logger.info("iOS MobileVLCKit 运行时初始化完成")
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        mediaPlayer.delegate = nil
        mediaPlayer.stop()
        securityScopedURL?.stopAccessingSecurityScopedResource()
    }

    /** 初始化或替换业务播放会话。 */
    func initialize(_ request: PlayerLaunchRequest) {
        load(request, preservingSecurityScope: false)
    }

    /** 获取文件沙盒授权后加载用户选择的本地媒体。 */
    func loadSecurityScopedMedia(_ url: URL) {
        releaseSecurityScopedResource()
        if url.startAccessingSecurityScopedResource() {
            securityScopedURL = url
        }
        let episode = PlayerEpisode(
            id: "local-file",
            title: url.deletingPathExtension().lastPathComponent,
            episodeLabel: "本地视频",
            mediaURL: url,
            durationMilliseconds: 0,
            subtitles: []
        )
        let request = PlayerLaunchRequest(
            sessionID: UUID().uuidString,
            animeTitle: episode.title,
            synopsis: "",
            artworkURL: nil,
            episodes: [episode],
            activeIndex: 0,
            startPositionMilliseconds: 0,
            autoplay: true
        )
        load(request, preservingSecurityScope: true)
    }

    /** 将 VLC 视频输出绑定到当前 SwiftUI UIView。 */
    func attach(to view: UIView) {
        guard attachedView !== view else { return }
        mediaPlayer.drawable = view
        attachedView = view
        logger.info("iOS MobileVLCKit 视频表面已绑定")
    }

    /** 仅解绑当前 UIView，旋转时保留底层播放会话。 */
    func detach(from view: UIView) {
        guard attachedView === view else { return }
        mediaPlayer.drawable = nil
        attachedView = nil
    }

    /** 在播放和暂停之间切换。 */
    func togglePlayback() {
        mediaPlayer.isPlaying ? pause() : play()
    }

    /** 激活系统媒体音频会话并开始播放。 */
    func play() {
        do {
            try configureAudioSession()
            mediaPlayer.play()
            snapshot.errorMessage = nil
        } catch {
            fail("无法激活媒体音频会话", error: error)
        }
    }

    /** 暂停当前媒体并取消自动恢复标记。 */
    func pause() {
        resumeAfterBackground = false
        resumeAfterInterruption = false
        pauseKeepingResumeIntent()
    }

    /** 跳转到当前媒体中的合法毫秒位置。 */
    func seek(to positionMilliseconds: Int64) {
        let maximum = snapshot.durationMilliseconds > 0 ? snapshot.durationMilliseconds : Int64(Int32.max)
        let target = min(max(positionMilliseconds, 0), maximum)
        mediaPlayer.time = VLCTime(int: Int32(clamping: target))
        snapshot.positionMilliseconds = target
    }

    /** 相对当前播放进度快进或快退。 */
    func skip(by milliseconds: Int64) {
        seek(to: snapshot.positionMilliseconds + milliseconds)
    }

    /** 设置 0 到 100 的音量，并在调节时取消静音。 */
    func setVolume(_ volume: Int32) {
        let normalized = min(max(volume, 0), 100)
        mediaPlayer.audio.volume = normalized
        mediaPlayer.audio.isMuted = false
        snapshot.volume = normalized
        snapshot.muted = false
    }

    /** 切换 MobileVLCKit 音频静音状态。 */
    func toggleMuted() {
        let nextMuted = !snapshot.muted
        mediaPlayer.audio.isMuted = nextMuted
        snapshot.muted = nextMuted
    }

    /** 设置最接近的受支持播放倍速。 */
    func setPlaybackRate(_ rate: Float) {
        let normalized = Self.supportedRates.min(by: { abs($0 - rate) < abs($1 - rate) }) ?? 1
        mediaPlayer.rate = normalized
        snapshot.playbackRate = normalized
    }

    /** 应用 VLC 音轨选择。 */
    func selectAudioTrack(_ trackID: Int32) {
        mediaPlayer.currentAudioTrackIndex = trackID
        refreshTracks()
    }

    /** 应用 VLC 字幕轨选择，空值表示关闭字幕。 */
    func selectSubtitleTrack(_ trackID: Int32?) {
        mediaPlayer.currentVideoSubTitleIndex = trackID ?? -1
        refreshTracks()
    }

    /** 切换默认、16:9 和 4:3 画面比例。 */
    func selectAspectRatio(_ aspectRatio: PlayerAspectRatio) {
        mediaPlayer.scaleFactor = 0
        if let value = aspectRatio.vlcValue {
            value.withCString { pointer in
                mediaPlayer.videoAspectRatio = UnsafeMutablePointer(mutating: pointer)
            }
        } else {
            mediaPlayer.videoAspectRatio = nil
        }
        snapshot.aspectRatio = aspectRatio
    }

    /** 加载播放列表中的指定单集。 */
    func selectEpisode(at index: Int) {
        loadEpisode(at: index, startPosition: 0)
    }

    /** 播放上一集，列表首项不执行操作。 */
    func previousEpisode() {
        let target = snapshot.activeIndex - 1
        guard target >= 0 else { return }
        loadEpisode(at: target, startPosition: 0)
    }

    /** 播放下一集，列表末项保持结束状态。 */
    func nextEpisode() {
        let target = snapshot.activeIndex + 1
        guard snapshot.episodes.indices.contains(target) else { return }
        loadEpisode(at: target, startPosition: 0)
    }

    /** 使用当前媒体和位置重建 VLC 输入。 */
    func retry() {
        loadEpisode(at: snapshot.activeIndex, startPosition: snapshot.positionMilliseconds)
    }

    /** 让宿主页面展示不依赖 VLC 回调的可恢复错误。 */
    func showError(_ message: String) {
        fail(message)
    }

    /** 真正进入后台时暂停，返回前台后按原状态恢复。 */
    func enterBackground() {
        resumeAfterBackground = mediaPlayer.isPlaying
        if resumeAfterBackground {
            pauseKeepingResumeIntent()
        }
    }

    /** 返回活动状态时恢复生命周期自动暂停的媒体。 */
    func becomeActive() {
        guard resumeAfterBackground else { return }
        resumeAfterBackground = false
        play()
    }

    /** 停止播放并释放文件访问授权。 */
    func close() {
        resumeAfterBackground = false
        resumeAfterInterruption = false
        mediaPlayer.stop()
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        releaseSecurityScopedResource()
        snapshot = PlayerSnapshot(errorMessage: "尚未选择可播放的媒体")
        logger.info("iOS MobileVLCKit 播放会话已关闭")
    }

    /** 接收 VLC 状态通知并切换到主线程更新快照。 */
    func mediaPlayerStateChanged(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            self?.refreshPlayerState()
        }
    }

    /** 接收 VLC 时间通知并切换到主线程更新进度。 */
    func mediaPlayerTimeChanged(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            self?.refreshTime()
        }
    }

    /** 加载完整业务请求并保持同一控制器实例。 */
    private func load(_ request: PlayerLaunchRequest, preservingSecurityScope: Bool) {
        guard !request.episodes.isEmpty else {
            fail("播放列表为空")
            return
        }
        if !preservingSecurityScope {
            releaseSecurityScopedResource()
        }
        autoplay = request.autoplay
        snapshot = PlayerSnapshot(
            sessionID: request.sessionID,
            animeTitle: request.animeTitle,
            synopsis: request.synopsis,
            artworkURL: request.artworkURL,
            episodes: request.episodes,
            activeIndex: min(max(request.activeIndex, 0), request.episodes.count - 1),
            status: .idle,
            volume: snapshot.volume
        )
        loadEpisode(at: snapshot.activeIndex, startPosition: max(request.startPositionMilliseconds, 0))
    }

    /** 创建 VLCMedia 并开始当前单集的原生播放。 */
    private func loadEpisode(at index: Int, startPosition: Int64) {
        guard snapshot.episodes.indices.contains(index) else { return }
        let episode = snapshot.episodes[index]
        pendingStartPosition = max(startPosition, 0)
        pendingSubtitles = episode.subtitles
        subtitlesAttached = false
        snapshot.activeIndex = index
        snapshot.status = .loading
        snapshot.positionMilliseconds = pendingStartPosition
        snapshot.durationMilliseconds = episode.durationMilliseconds
        snapshot.audioTracks = []
        snapshot.subtitleTracks = []
        snapshot.errorMessage = nil

        let media = VLCMedia(url: episode.mediaURL)
        media.addOption(":network-caching=1500")
        mediaPlayer.stop()
        mediaPlayer.media = media
        if autoplay {
            play()
        } else {
            snapshot.status = .ready
        }
        logger.info("iOS MobileVLCKit 已加载媒体: session=\(self.snapshot.sessionID, privacy: .public), index=\(index)")
    }

    /** 把 MobileVLCKit 状态枚举归一为跨平台播放阶段。 */
    private func refreshPlayerState() {
        switch mediaPlayer.state.rawValue {
        case 1:
            snapshot.status = .loading
        case 2:
            snapshot.status = .buffering
        case 3:
            snapshot.status = .ended
            snapshot.positionMilliseconds = snapshot.durationMilliseconds
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        case 4:
            fail("MobileVLCKit 无法解码或读取当前媒体")
        case 5:
            snapshot.status = .playing
            snapshot.errorMessage = nil
            applyPendingPlaybackValues()
            refreshTracks()
        case 6:
            snapshot.status = .paused
        case 7:
            refreshTracks()
        default:
            if snapshot.status != .loading {
                snapshot.status = .paused
            }
        }
    }

    /** 读取当前播放时间和媒体总时长。 */
    private func refreshTime() {
        snapshot.positionMilliseconds = Int64(max(mediaPlayer.time.intValue, 0))
        let mediaLength = mediaPlayer.media?.length.intValue ?? 0
        if mediaLength > 0 {
            snapshot.durationMilliseconds = Int64(mediaLength)
        }
    }

    /** 在 VLC 真正开始后应用续播位置与外部字幕。 */
    private func applyPendingPlaybackValues() {
        if pendingStartPosition > 0 {
            mediaPlayer.time = VLCTime(int: Int32(clamping: pendingStartPosition))
            snapshot.positionMilliseconds = pendingStartPosition
            pendingStartPosition = 0
        }
        guard !subtitlesAttached else { return }
        subtitlesAttached = true
        for subtitle in pendingSubtitles {
            _ = mediaPlayer.addPlaybackSlave(
                subtitle.url,
                type: .subtitle,
                enforce: subtitle.isDefault
            )
        }
    }

    /** 从 MobileVLCKit 读取音轨和字幕轨列表。 */
    private func refreshTracks() {
        let audioIDs = (mediaPlayer.audioTrackIndexes as? [NSNumber] ?? []).map(\.int32Value)
        let audioNames = mediaPlayer.audioTrackNames as? [String] ?? []
        snapshot.audioTracks = audioIDs.enumerated().map { offset, trackID in
            PlayerTrack(
                id: trackID,
                label: audioNames.indices.contains(offset) ? audioNames[offset] : "音轨 \(offset + 1)",
                selected: trackID == mediaPlayer.currentAudioTrackIndex
            )
        }

        let subtitleIDs = (mediaPlayer.videoSubTitlesIndexes as? [NSNumber] ?? []).map(\.int32Value)
        let subtitleNames = mediaPlayer.videoSubTitlesNames as? [String] ?? []
        snapshot.subtitleTracks = subtitleIDs.enumerated().map { offset, trackID in
            PlayerTrack(
                id: trackID,
                label: subtitleNames.indices.contains(offset) ? subtitleNames[offset] : "字幕 \(offset + 1)",
                selected: trackID == mediaPlayer.currentVideoSubTitleIndex
            )
        }
    }

    /** 配置适合视频播放的系统音频会话。 */
    private func configureAudioSession() throws {
        try audioSession.setCategory(.playback, mode: .moviePlayback, options: [.allowAirPlay])
        try audioSession.setActive(true)
    }

    /** 执行不改变自动恢复意图的底层暂停。 */
    private func pauseKeepingResumeIntent() {
        if mediaPlayer.isPlaying {
            mediaPlayer.pause()
        }
        snapshot.status = .paused
    }

    /** 处理电话、Siri 等系统音频中断。 */
    @objc private func handleAudioInterruption(_ notification: Notification) {
        guard
            let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: rawType)
        else { return }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch type {
            case .began:
                self.resumeAfterInterruption = self.mediaPlayer.isPlaying
                if self.resumeAfterInterruption {
                    self.pauseKeepingResumeIntent()
                }
            case .ended:
                let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
                if self.resumeAfterInterruption, options.contains(.shouldResume) {
                    self.resumeAfterInterruption = false
                    self.play()
                }
            @unknown default:
                break
            }
        }
    }

    /** 停止访问上一个安全作用域文件。 */
    private func releaseSecurityScopedResource() {
        securityScopedURL?.stopAccessingSecurityScopedResource()
        securityScopedURL = nil
    }

    /** 记录脱敏错误并切换为可恢复错误状态。 */
    private func fail(_ message: String, error: Error? = nil) {
        if let error {
            logger.error("\(message, privacy: .public): \(error.localizedDescription, privacy: .public)")
        } else {
            logger.error("\(message, privacy: .public)")
        }
        snapshot.status = .error
        snapshot.errorMessage = message
    }
}

private extension PlayerSnapshot {
    /** 创建仅包含错误提示的初始快照。 */
    init(errorMessage: String) {
        self.init(status: .error, errorMessage: errorMessage)
    }
}
