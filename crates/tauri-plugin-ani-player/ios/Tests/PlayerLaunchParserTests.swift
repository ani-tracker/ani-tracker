import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import tauri_plugin_ani_player
#else
@testable import AniTracker
#endif

/** 验证外部任务只能生成结构完整的原生播放请求。 */
final class PlayerLaunchParserTests: XCTestCase {
    /** Rust 播放命令中的番剧标题、简介和封面应完整进入原生展示模型。 */
    func testParsesTransportPresentation() throws {
        let presentation = PlayerLaunchParser.parsePresentation(
            [
                "animeTitle": "  星海回声  ",
                "description": "第八集简介",
                "artworkUri": "https://example.test/cover.jpg"
            ],
            fallbackTitle: "episode-08.mkv"
        )

        XCTAssertEqual(presentation.animeTitle, "星海回声")
        XCTAssertEqual(presentation.synopsis, "第八集简介")
        XCTAssertEqual(presentation.artworkURL?.absoluteString, "https://example.test/cover.jpg")
    }

    /** 展示字段缺失或为空时仅回退标题，不应阻断媒体加载。 */
    func testFallsBackFromEmptyTransportPresentation() {
        let presentation = PlayerLaunchParser.parsePresentation(
            ["animeTitle": "  ", "description": ""],
            fallbackTitle: "episode-08.mkv"
        )

        XCTAssertEqual(presentation.animeTitle, "episode-08.mkv")
        XCTAssertEqual(presentation.synopsis, "")
        XCTAssertNil(presentation.artworkURL)
    }

    /** 合法深链应保留媒体、续播位置和自动播放参数。 */
    func testParsesValidPlayerDeepLink() throws {
        let url = try XCTUnwrap(
            URL(string: "anitracker://player?url=https%3A%2F%2Fexample.test%2Fepisode.m3u8&title=%E6%98%9F%E6%B5%B7%E5%9B%9E%E5%A3%B0&episode=%E7%AC%AC08%E9%9B%86&position=12000&autoplay=false")
        )

        let request = try XCTUnwrap(PlayerLaunchParser.parse(url))

        XCTAssertEqual(request.animeTitle, "星海回声")
        XCTAssertEqual(request.episodes.first?.episodeLabel, "第08集")
        XCTAssertEqual(request.episodes.first?.mediaURL.absoluteString, "https://example.test/episode.m3u8")
        XCTAssertEqual(request.startPositionMilliseconds, 12_000)
        XCTAssertFalse(request.autoplay)
    }

    /** 重复字幕参数应保持顺序并仅默认启用第一条。 */
    func testParsesRepeatedSubtitleParameters() throws {
        let url = try XCTUnwrap(
            URL(string: "anitracker://player?url=https%3A%2F%2Fexample.test%2Fvideo.mkv&subtitle=https%3A%2F%2Fexample.test%2Fzh.ass&subtitle=https%3A%2F%2Fexample.test%2Fja.vtt")
        )

        let request = try XCTUnwrap(PlayerLaunchParser.parse(url))
        let subtitles = try XCTUnwrap(request.episodes.first?.subtitles)

        XCTAssertEqual(subtitles.map(\.url.pathExtension), ["ass", "vtt"])
        XCTAssertTrue(subtitles[0].isDefault)
        XCTAssertFalse(subtitles[1].isDefault)
    }

    /** 非播放器协议或缺少媒体地址时必须拒绝启动。 */
    func testRejectsInvalidPlayerDeepLinks() throws {
        XCTAssertNil(PlayerLaunchParser.parse(try XCTUnwrap(URL(string: "https://example.test/video"))))
        XCTAssertNil(PlayerLaunchParser.parse(try XCTUnwrap(URL(string: "anitracker://player?title=missing"))))
    }
}
