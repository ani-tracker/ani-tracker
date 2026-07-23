import Foundation
import SwiftUI

/** 竖屏下展示番剧摘要、简介和完整播放列表。 */
struct PlayerDetailsView: View {
    let snapshot: PlayerSnapshot
    let onSelectEpisode: (Int) -> Void

    @State private var synopsisExpanded = false

    var body: some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    nowPlayingSummary
                    synopsis
                    Divider()
                    playlistHeader
                    ForEach(Array(snapshot.episodes.enumerated()), id: \.element.id) { index, episode in
                        EpisodeRow(
                            episode: episode,
                            index: index,
                            snapshot: snapshot,
                            onSelect: { onSelectEpisode(index) }
                        )
                        .id(episode.id)
                    }
                }
                .padding(.bottom, 20)
            }
            .background(Color(uiColor: .systemBackground))
            .onChange(of: snapshot.activeIndex) { activeIndex in
                guard snapshot.episodes.indices.contains(activeIndex) else { return }
                withAnimation(.easeOut(duration: 0.18)) {
                    reader.scrollTo(snapshot.episodes[activeIndex].id, anchor: .center)
                }
            }
        }
    }

    /** 组合海报、当前单集和媒体标签。 */
    private var nowPlayingSummary: some View {
        HStack(alignment: .top, spacing: 14) {
            artwork
                .frame(width: 64, height: 90)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color(uiColor: .separator).opacity(0.55), lineWidth: 0.5)
                }

            VStack(alignment: .leading, spacing: 5) {
                Text(snapshot.animeTitle)
                    .font(.system(size: 19, weight: .bold))
                    .foregroundStyle(Color(uiColor: .label))
                    .lineLimit(2)

                Text(snapshot.activeEpisode?.episodeLabel ?? "尚未选择单集")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color(uiColor: .secondaryLabel))
                    .lineLimit(1)

                HStack(spacing: 6) {
                    PlayerMetadataTag(label: "正在播放", emphasized: true)
                    PlayerMetadataTag(label: "VLC")
                    if !snapshot.subtitleTracks.isEmpty || !(snapshot.activeEpisode?.subtitles.isEmpty ?? true) {
                        PlayerMetadataTag(label: "字幕")
                    }
                }
                .padding(.top, 3)

                Text("原生播放  ·  \(formatPlayerTime(snapshot.positionMilliseconds))")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color(uiColor: .tertiaryLabel))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
    }

    /** 加载网络海报，失败时保留稳定占位。 */
    @ViewBuilder
    private var artwork: some View {
        if let artworkURL = snapshot.artworkURL {
            AsyncImage(url: artworkURL) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                default:
                    artworkPlaceholder
                }
            }
        } else {
            artworkPlaceholder
        }
    }

    /** 绘制没有海报时的语义占位。 */
    private var artworkPlaceholder: some View {
        ZStack {
            Color(uiColor: .secondarySystemBackground)
            Image(systemName: "film.stack.fill")
                .font(.system(size: 23))
                .foregroundStyle(Color(uiColor: .tertiaryLabel))
        }
    }

    /** 展示可展开的简介和紧凑元数据。 */
    @ViewBuilder
    private var synopsis: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Text("VLC 内置播放器")
                Circle().frame(width: 3, height: 3)
                Text("\(snapshot.episodes.count) 集")
                Circle().frame(width: 3, height: 3)
                Text(formatPlayerRate(snapshot.playbackRate) + "x")
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(Color(uiColor: .secondaryLabel))

            if !snapshot.synopsis.isEmpty {
                Text(snapshot.synopsis)
                    .font(.system(size: 13))
                    .foregroundStyle(Color(uiColor: .secondaryLabel))
                    .lineSpacing(3)
                    .lineLimit(synopsisExpanded ? nil : 3)

                Button(synopsisExpanded ? "收起简介" : "展开简介") {
                    withAnimation(.easeOut(duration: 0.16)) {
                        synopsisExpanded.toggle()
                    }
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 18)
    }

    /** 显示列表标题和当前位置。 */
    private var playlistHeader: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Text("播放列表")
                .font(.system(size: 19, weight: .bold))
                .foregroundStyle(Color(uiColor: .label))
            Text("(\(min(snapshot.activeIndex + 1, snapshot.episodes.count))/\(snapshot.episodes.count))")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color(uiColor: .secondaryLabel))
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 8)
    }
}

/** 横屏播放器右侧的可关闭播放列表。 */
struct LandscapePlaylistPanel: View {
    let snapshot: PlayerSnapshot
    let onSelectEpisode: (Int) -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("播放列表")
                        .font(.system(size: 17, weight: .bold))
                    Text("\(snapshot.animeTitle) · \(snapshot.episodes.count) 集")
                        .font(.system(size: 10))
                        .foregroundStyle(Color(uiColor: .secondaryLabel))
                        .lineLimit(1)
                }
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭播放列表")
            }
            .padding(.leading, 16)
            .padding(.trailing, 4)
            .frame(minHeight: 56)

            Divider()

            ScrollView {
                LazyVStack(spacing: 3) {
                    ForEach(Array(snapshot.episodes.enumerated()), id: \.element.id) { index, episode in
                        EpisodeRow(
                            episode: episode,
                            index: index,
                            snapshot: snapshot,
                            onSelect: { onSelectEpisode(index) }
                        )
                    }
                }
                .padding(8)
            }
        }
        .foregroundStyle(Color(uiColor: .label))
        .background(Color(uiColor: .systemBackground).opacity(0.98))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Color(uiColor: .separator))
                .frame(width: 0.5)
        }
        .shadow(color: .black.opacity(0.32), radius: 18, x: -7)
    }
}

/** 绘制一个单集状态行。 */
private struct EpisodeRow: View {
    let episode: PlayerEpisode
    let index: Int
    let snapshot: PlayerSnapshot
    let onSelect: () -> Void

    private var active: Bool { index == snapshot.activeIndex }
    private var completed: Bool { index < snapshot.activeIndex }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 9) {
                Text(String(format: "%02d", index + 1))
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(active ? Color.accentColor : Color(uiColor: .secondaryLabel))
                    .frame(width: 28, alignment: .leading)

                VStack(alignment: .leading, spacing: 3) {
                    Text(episode.episodeLabel)
                        .font(.system(size: 13, weight: active ? .semibold : .regular))
                        .foregroundStyle(active ? Color.accentColor : Color(uiColor: .label))
                        .lineLimit(1)
                    Text(statusText)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(Color(uiColor: .secondaryLabel))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: statusSymbol)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(active ? Color.accentColor : statusColor)
                    .frame(width: 28, height: 44)
            }
            .padding(.leading, 10)
            .padding(.trailing, 6)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(active ? Color.accentColor.opacity(0.11) : Color.clear)
            .overlay(alignment: .leading) {
                if active {
                    Rectangle()
                        .fill(Color.accentColor)
                        .frame(width: 3)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if active, snapshot.durationMilliseconds > 0 {
                    GeometryReader { proxy in
                        Rectangle()
                            .fill(Color.accentColor)
                            .frame(
                                width: proxy.size.width * min(
                                    Double(snapshot.positionMilliseconds) / Double(snapshot.durationMilliseconds),
                                    1
                                ),
                                height: 2
                            )
                    }
                    .frame(height: 2)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(episode.episodeLabel)，\(statusText)")
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    /** 返回当前单集的文字状态。 */
    private var statusText: String {
        if active {
            return "正在播放 · \(formatPlayerTime(snapshot.positionMilliseconds)) / \(formatPlayerTime(snapshot.durationMilliseconds))"
        }
        if completed { return "已看完" }
        return episode.durationMilliseconds > 0 ? "时长 \(formatPlayerTime(episode.durationMilliseconds))" : "未观看"
    }

    /** 返回当前单集的辅助图标。 */
    private var statusSymbol: String {
        if active { return "speaker.wave.2.fill" }
        if completed { return "checkmark.circle" }
        return "circle"
    }

    /** 使用非红色状态色区分完成项。 */
    private var statusColor: Color {
        completed ? Color(uiColor: .systemTeal) : Color(uiColor: .tertiaryLabel)
    }
}

/** 绘制小尺寸语义媒体标签。 */
private struct PlayerMetadataTag: View {
    let label: String
    var emphasized = false

    var body: some View {
        Text(label)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(emphasized ? Color.accentColor : Color(uiColor: .secondaryLabel))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(
                emphasized
                    ? Color.accentColor.opacity(0.10)
                    : Color(uiColor: .secondarySystemBackground)
            )
            .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .stroke(
                        emphasized ? Color.accentColor.opacity(0.22) : Color(uiColor: .separator).opacity(0.45),
                        lineWidth: 0.5
                    )
            }
    }
}

/** 把毫秒格式化为播放器时间。 */
func formatPlayerTime(_ milliseconds: Int64) -> String {
    let seconds = max(milliseconds, 0) / 1_000
    let hours = Int(seconds / 3_600)
    let minutes = Int(seconds % 3_600 / 60)
    let remainder = Int(seconds % 60)
    return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, remainder)
        : String(format: "%02d:%02d", minutes, remainder)
}

/** 去除整数倍速末尾无意义的小数位。 */
func formatPlayerRate(_ rate: Float) -> String {
    rate.rounded() == rate ? String(Int(rate)) : String(rate)
}
