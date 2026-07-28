import Foundation

/** 将旧宿主深链或调试启动参数转换为播放器业务模型。 */
enum PlayerLaunchParser {
    /** 解析 Rust 播放命令携带的番剧展示字段，缺失标题时回退到文件名。 */
    static func parsePresentation(
        _ source: [String: Any],
        fallbackTitle: String
    ) -> PlayerPresentation {
        let animeTitle = normalizedString(source["animeTitle"]) ?? fallbackTitle
        let synopsis = normalizedString(source["description"]) ?? ""
        let artworkURL = normalizedString(source["artworkUri"]).flatMap(URL.init(string:))
        return PlayerPresentation(
            animeTitle: animeTitle,
            synopsis: synopsis,
            artworkURL: artworkURL
        )
    }

    /** 解析 anitracker://player 深链，缺少合法媒体 URL 时返回空。 */
    static func parse(_ deepLink: URL) -> PlayerLaunchRequest? {
        guard deepLink.scheme?.lowercased() == "anitracker" else { return nil }
        guard deepLink.host?.lowercased() == "player" else { return nil }
        guard let components = URLComponents(url: deepLink, resolvingAgainstBaseURL: false) else { return nil }
        let queryItems = components.queryItems ?? []
        guard let source = firstValue(named: "url", in: queryItems), let mediaURL = URL(string: source) else {
            return nil
        }

        let title = firstValue(named: "title", in: queryItems) ?? "Ani Tracker"
        let episodeLabel = firstValue(named: "episode", in: queryItems) ?? "当前视频"
        let subtitles = queryItems
            .filter { $0.name == "subtitle" }
            .compactMap(\.value)
            .compactMap(URL.init(string:))
            .enumerated()
            .map { index, url in
                PlayerSubtitle(
                    id: "subtitle-\(index)",
                    label: "字幕 \(index + 1)",
                    url: url,
                    language: nil,
                    isDefault: index == 0
                )
            }
        let episode = PlayerEpisode(
            id: "episode-0",
            title: title,
            episodeLabel: episodeLabel,
            mediaURL: mediaURL,
            durationMilliseconds: 0,
            subtitles: subtitles
        )

        return PlayerLaunchRequest(
            sessionID: firstValue(named: "session", in: queryItems) ?? UUID().uuidString,
            animeTitle: title,
            synopsis: firstValue(named: "description", in: queryItems) ?? "",
            artworkURL: firstValue(named: "artwork", in: queryItems).flatMap(URL.init(string:)),
            episodes: [episode],
            activeIndex: 0,
            startPositionMilliseconds: Int64(firstValue(named: "position", in: queryItems) ?? "0") ?? 0,
            autoplay: firstValue(named: "autoplay", in: queryItems) != "false"
        )
    }

    /** 读取 --media-url 调试参数，方便模拟器直接打开媒体。 */
    static func parseProcessArguments(_ arguments: [String] = ProcessInfo.processInfo.arguments) -> PlayerLaunchRequest? {
        guard let flagIndex = arguments.firstIndex(of: "--media-url") else { return nil }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex), let mediaURL = URL(string: arguments[valueIndex]) else { return nil }
        let episode = PlayerEpisode(
            id: "debug-episode",
            title: "Ani Tracker",
            episodeLabel: "当前视频",
            mediaURL: mediaURL,
            durationMilliseconds: 0,
            subtitles: []
        )
        return PlayerLaunchRequest(
            sessionID: UUID().uuidString,
            animeTitle: "Ani Tracker",
            synopsis: "",
            artworkURL: nil,
            episodes: [episode],
            activeIndex: 0,
            startPositionMilliseconds: 0,
            autoplay: true
        )
    }

    /** 返回同名查询参数的首个非空值。 */
    private static func firstValue(named name: String, in items: [URLQueryItem]) -> String? {
        items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    /** 将传输字段归一为空白安全的可选字符串。 */
    private static func normalizedString(_ value: Any?) -> String? {
        (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
