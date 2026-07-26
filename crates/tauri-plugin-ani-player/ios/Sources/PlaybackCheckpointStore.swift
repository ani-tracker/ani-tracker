import CryptoKit
import Foundation

/** iOS Tauri 原生播放器的一条本地续播记录。 */
struct MobilePlaybackCheckpoint: Codable, Equatable {
    let positionMilliseconds: Int64
    let durationMilliseconds: Int64
    let completed: Bool
    let watched: Bool
    let updatedAt: Date
}

/** 使用脱敏媒体键在 UserDefaults 中保存原生播放进度。 */
final class PlaybackCheckpointStore {
    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /** 允许测试注入隔离的 UserDefaults。 */
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /** 读取指定单集的续播记录，损坏内容按不存在处理。 */
    func read(for episode: PlayerEpisode) -> MobilePlaybackCheckpoint? {
        guard let data = defaults.data(forKey: checkpointKey(for: episode)) else { return nil }
        return try? decoder.decode(MobilePlaybackCheckpoint.self, from: data)
    }

    /** 保存当前位置，并让 90% 已看状态跨重启保持单调。 */
    @discardableResult
    func save(
        episode: PlayerEpisode,
        positionMilliseconds: Int64,
        durationMilliseconds: Int64,
        completed: Bool
    ) -> MobilePlaybackCheckpoint {
        let duration = max(durationMilliseconds, 0)
        let position = min(max(positionMilliseconds, 0), duration > 0 ? duration : Int64.max)
        let checkpoint = MobilePlaybackCheckpoint(
            positionMilliseconds: position,
            durationMilliseconds: duration,
            completed: completed,
            watched: read(for: episode)?.watched == true || Self.playbackPercent(
                positionMilliseconds: position,
                durationMilliseconds: duration
            ) >= 90,
            updatedAt: Date()
        )
        if let data = try? encoder.encode(checkpoint) {
            defaults.set(data, forKey: checkpointKey(for: episode))
        }
        return checkpoint
    }

    /** 返回适合继续播放的位置，已播完或接近片尾时从头开始。 */
    func resumePositionMilliseconds(for episode: PlayerEpisode) -> Int64 {
        guard let checkpoint = read(for: episode) else { return 0 }
        guard !checkpoint.completed, checkpoint.positionMilliseconds >= 5_000 else { return 0 }
        if
            checkpoint.durationMilliseconds > 0,
            checkpoint.durationMilliseconds - checkpoint.positionMilliseconds <= 30_000
        {
            return 0
        }
        return checkpoint.positionMilliseconds
    }

    /** 返回单集是否已跨过一次 90% 阈值。 */
    func isWatched(_ episode: PlayerEpisode) -> Bool {
        read(for: episode)?.watched == true
    }

    /** 将毫秒位置换算为受限百分比。 */
    static func playbackPercent(positionMilliseconds: Int64, durationMilliseconds: Int64) -> Double {
        guard durationMilliseconds > 0 else { return 0 }
        return min(max(Double(positionMilliseconds) / Double(durationMilliseconds) * 100, 0), 100)
    }

    /** 对稳定单集标识和媒体 URL 求摘要，避免把真实地址写入偏好键。 */
    private func checkpointKey(for episode: PlayerEpisode) -> String {
        let source = Data("\(episode.id)|\(episode.mediaURL.absoluteString)".utf8)
        let digest = SHA256.hash(data: source).map { String(format: "%02x", $0) }.joined()
        return "ani.player.checkpoint.\(digest)"
    }
}
