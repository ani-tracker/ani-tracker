import Foundation
import XCTest
@testable import AniTracker

/** 验证 iOS 原生播放器续播记录的恢复和幂等观看策略。 */
final class PlaybackCheckpointStoreTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "PlaybackCheckpointStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    /** 只在可靠中段位置恢复，完成状态从头播放。 */
    func testResumePositionAndCompletedGuard() throws {
        let episode = try makeEpisode()
        let store = PlaybackCheckpointStore(defaults: defaults)

        store.save(
            episode: episode,
            positionMilliseconds: 120_000,
            durationMilliseconds: 1_400_000,
            completed: false
        )
        XCTAssertEqual(store.resumePositionMilliseconds(for: episode), 120_000)

        store.save(
            episode: episode,
            positionMilliseconds: 1_400_000,
            durationMilliseconds: 1_400_000,
            completed: true
        )
        XCTAssertEqual(store.resumePositionMilliseconds(for: episode), 0)
    }

    /** 90% 已看标记写入后不会因回退进度撤销。 */
    func testWatchedStateIsMonotonic() throws {
        let episode = try makeEpisode()
        let store = PlaybackCheckpointStore(defaults: defaults)
        store.save(
            episode: episode,
            positionMilliseconds: 900_000,
            durationMilliseconds: 1_000_000,
            completed: false
        )
        store.save(
            episode: episode,
            positionMilliseconds: 100_000,
            durationMilliseconds: 1_000_000,
            completed: false
        )
        XCTAssertTrue(store.isWatched(episode))
    }

    /** 创建不依赖真实文件的稳定测试单集。 */
    private func makeEpisode() throws -> PlayerEpisode {
        PlayerEpisode(
            id: "episode-8",
            title: "测试番剧",
            episodeLabel: "第 08 集",
            mediaURL: try XCTUnwrap(URL(string: "https://example.test/episode-8.mkv")),
            durationMilliseconds: 1_400_000,
            subtitles: []
        )
    }
}
