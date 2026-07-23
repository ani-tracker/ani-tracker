import SwiftUI

/** 渲染视频上方的顶部、中央和底部控制层。 */
struct PlayerControlsView: View {
    @ObservedObject var controller: MobileVLCPlayerController

    let compact: Bool
    let safeAreaInsets: EdgeInsets
    let onClose: () -> Void
    let onActivity: () -> Void
    let onTogglePlaylist: () -> Void
    let onToggleOrientation: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.18)
                .allowsHitTesting(false)

            topBar
                .frame(maxHeight: .infinity, alignment: .top)

            centerControls

            PlayerBottomControls(
                controller: controller,
                compact: compact,
                safeAreaInsets: safeAreaInsets,
                onActivity: onActivity,
                onToggleOrientation: onToggleOrientation
            )
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .foregroundStyle(.white)
    }

    /** 绘制标题、切集、播放列表和设置入口。 */
    private var topBar: some View {
        HStack(spacing: 0) {
            PlayerIconButton(symbol: "chevron.left", label: "关闭播放器", action: onClose)

            VStack(alignment: compact ? .center : .leading, spacing: 1) {
                Text(controller.snapshot.animeTitle)
                    .font(.system(size: compact ? 12 : 15, weight: .semibold))
                    .lineLimit(1)
                if !compact {
                    Text(controller.snapshot.activeEpisode?.episodeLabel ?? "")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.white.opacity(0.72))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: compact ? .center : .leading)

            if !compact {
                PlayerIconButton(
                    symbol: "backward.end.fill",
                    label: "上一集",
                    enabled: controller.snapshot.activeIndex > 0
                ) {
                    controller.previousEpisode()
                    onActivity()
                }
                PlayerIconButton(
                    symbol: "forward.end.fill",
                    label: "下一集",
                    enabled: controller.snapshot.activeIndex < controller.snapshot.episodes.count - 1
                ) {
                    controller.nextEpisode()
                    onActivity()
                }
                PlayerIconButton(symbol: "list.bullet", label: "播放列表") {
                    onTogglePlaylist()
                    onActivity()
                }
            }

            PlayerSettingsMenu(controller: controller, onActivity: onActivity)
        }
        .padding(.leading, max(safeAreaInsets.leading, compact ? 4 : 12))
        .padding(.trailing, max(safeAreaInsets.trailing, compact ? 4 : 12))
        .padding(.top, safeAreaInsets.top)
        .frame(minHeight: 48 + safeAreaInsets.top)
        .background(Color.black.opacity(0.48))
    }

    /** 绘制播放与十秒跳转操作。 */
    private var centerControls: some View {
        HStack(spacing: compact ? 20 : 34) {
            if !compact {
                PlayerRoundButton(symbol: "gobackward.10", label: "快退 10 秒") {
                    controller.skip(by: -10_000)
                    onActivity()
                }
            }

            Button {
                controller.togglePlayback()
                onActivity()
            } label: {
                Image(systemName: controller.snapshot.status == .playing ? "pause.fill" : "play.fill")
                    .font(.system(size: compact ? 25 : 34, weight: .semibold))
                    .offset(x: controller.snapshot.status == .playing ? 0 : 2)
                    .frame(width: compact ? 58 : 74, height: compact ? 58 : 74)
                    .background(Color.black.opacity(0.60))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(.white.opacity(0.22), lineWidth: 1)
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(controller.snapshot.status == .playing ? "暂停" : "播放")

            if !compact {
                PlayerRoundButton(symbol: "goforward.10", label: "快进 10 秒") {
                    controller.skip(by: 10_000)
                    onActivity()
                }
            }
        }
    }
}

/** 绘制时间轴、音量、字幕、倍速和方向控制。 */
private struct PlayerBottomControls: View {
    @ObservedObject var controller: MobileVLCPlayerController

    let compact: Bool
    let safeAreaInsets: EdgeInsets
    let onActivity: () -> Void
    let onToggleOrientation: () -> Void

    @State private var seeking = false
    @State private var seekValue = 0.0

    private var duration: Double {
        Double(max(controller.snapshot.durationMilliseconds, 1))
    }

    var body: some View {
        VStack(spacing: compact ? 2 : 3) {
            HStack(spacing: compact ? 6 : 12) {
                Text(formatPlayerTime(Int64(seekValue)))
                    .frame(width: compact ? 34 : 48, alignment: .trailing)
                Slider(
                    value: $seekValue,
                    in: 0...duration,
                    onEditingChanged: handleSeekEditing
                )
                .tint(Color.accentColor)
                .accessibilityLabel("播放进度")
                Text(formatPlayerTime(controller.snapshot.durationMilliseconds))
                    .frame(width: compact ? 34 : 48, alignment: .leading)
            }
            .font(.system(size: compact ? 9 : 10, weight: .medium, design: .monospaced))

            HStack(spacing: compact ? 2 : 5) {
                PlayerIconButton(
                    symbol: controller.snapshot.muted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                    label: controller.snapshot.muted ? "取消静音" : "静音"
                ) {
                    controller.toggleMuted()
                    onActivity()
                }

                if !compact {
                    Slider(
                        value: Binding(
                            get: { controller.snapshot.muted ? 0 : Double(controller.snapshot.volume) },
                            set: {
                                controller.setVolume(Int32($0.rounded()))
                                onActivity()
                            }
                        ),
                        in: 0...100
                    )
                    .tint(.white)
                    .frame(width: 96)
                    .accessibilityLabel("音量")
                }

                Spacer(minLength: 4)

                PlayerSubtitleMenu(controller: controller, onActivity: onActivity)
                PlayerRateMenu(controller: controller, onActivity: onActivity)

                if !compact {
                    PlayerAspectRatioMenu(controller: controller, onActivity: onActivity)
                }

                PlayerIconButton(
                    symbol: compact ? "rectangle.landscape" : "rectangle.portrait",
                    label: compact ? "进入横屏" : "返回竖屏",
                    action: onToggleOrientation
                )
            }
            .frame(height: 42)
        }
        .padding(.leading, max(safeAreaInsets.leading, compact ? 8 : 18))
        .padding(.trailing, max(safeAreaInsets.trailing, compact ? 8 : 18))
        .padding(.top, 4)
        .padding(.bottom, max(safeAreaInsets.bottom, 4))
        .background(Color.black.opacity(0.58))
        .onAppear {
            seekValue = Double(controller.snapshot.positionMilliseconds)
        }
        .onChange(of: controller.snapshot.positionMilliseconds) { position in
            if !seeking {
                seekValue = min(Double(position), duration)
            }
        }
        .onChange(of: controller.snapshot.activeIndex) { _ in
            seeking = false
            seekValue = Double(controller.snapshot.positionMilliseconds)
        }
    }

    /** 在拖动结束时提交跳转位置。 */
    private func handleSeekEditing(_ editing: Bool) {
        seeking = editing
        onActivity()
        if !editing {
            controller.seek(to: Int64(seekValue.rounded()))
        }
    }
}

/** 提供关闭字幕和字幕轨选择。 */
private struct PlayerSubtitleMenu: View {
    @ObservedObject var controller: MobileVLCPlayerController
    let onActivity: () -> Void

    var body: some View {
        Menu {
            Button("关闭字幕") {
                controller.selectSubtitleTrack(nil)
                onActivity()
            }
            if controller.snapshot.subtitleTracks.isEmpty {
                Button("无可用文本字幕") {}
                    .disabled(true)
            } else {
                ForEach(controller.snapshot.subtitleTracks) { track in
                    Button {
                        controller.selectSubtitleTrack(track.id)
                        onActivity()
                    } label: {
                        Label(track.label, systemImage: track.selected ? "checkmark" : "captions.bubble")
                    }
                }
            }
        } label: {
            Image(systemName: "captions.bubble")
                .frame(width: 44, height: 44)
        }
        .foregroundStyle(.white)
        .accessibilityLabel("字幕")
        .simultaneousGesture(TapGesture().onEnded { _ in onActivity() })
    }
}

/** 提供离散播放倍速选择。 */
private struct PlayerRateMenu: View {
    @ObservedObject var controller: MobileVLCPlayerController
    let onActivity: () -> Void

    var body: some View {
        Menu {
            ForEach(MobileVLCPlayerController.supportedRates, id: \.self) { rate in
                Button {
                    controller.setPlaybackRate(rate)
                    onActivity()
                } label: {
                    Label(
                        formatPlayerRate(rate) + "x",
                        systemImage: rate == controller.snapshot.playbackRate ? "checkmark" : "speedometer"
                    )
                }
            }
        } label: {
            Text(formatPlayerRate(controller.snapshot.playbackRate) + "x")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .padding(.horizontal, 7)
                .frame(minWidth: 44, minHeight: 44)
        }
        .foregroundStyle(.white)
        .accessibilityLabel("播放倍速")
        .simultaneousGesture(TapGesture().onEnded { _ in onActivity() })
    }
}

/** 提供默认、16:9 和 4:3 画面比例。 */
private struct PlayerAspectRatioMenu: View {
    @ObservedObject var controller: MobileVLCPlayerController
    let onActivity: () -> Void

    var body: some View {
        Menu {
            ForEach(PlayerAspectRatio.allCases) { aspectRatio in
                Button {
                    controller.selectAspectRatio(aspectRatio)
                    onActivity()
                } label: {
                    Label(
                        aspectRatio.title,
                        systemImage: aspectRatio == controller.snapshot.aspectRatio ? "checkmark" : "aspectratio"
                    )
                }
            }
        } label: {
            Image(systemName: "aspectratio")
                .frame(width: 44, height: 44)
        }
        .foregroundStyle(.white)
        .accessibilityLabel("画面比例")
        .simultaneousGesture(TapGesture().onEnded { _ in onActivity() })
    }
}

/** 提供画面比例、音轨和字幕的完整设置菜单。 */
private struct PlayerSettingsMenu: View {
    @ObservedObject var controller: MobileVLCPlayerController
    let onActivity: () -> Void

    var body: some View {
        Menu {
            Section("画面比例") {
                ForEach(PlayerAspectRatio.allCases) { aspectRatio in
                    Button {
                        controller.selectAspectRatio(aspectRatio)
                        onActivity()
                    } label: {
                        Label(
                            aspectRatio.title,
                            systemImage: aspectRatio == controller.snapshot.aspectRatio ? "checkmark" : "aspectratio"
                        )
                    }
                }
            }

            Section("倍速") {
                ForEach(MobileVLCPlayerController.supportedRates, id: \.self) { rate in
                    Button {
                        controller.setPlaybackRate(rate)
                        onActivity()
                    } label: {
                        Label(
                            formatPlayerRate(rate) + "x",
                            systemImage: rate == controller.snapshot.playbackRate ? "checkmark" : "speedometer"
                        )
                    }
                }
            }

            if !controller.snapshot.audioTracks.isEmpty {
                Section("音轨") {
                    ForEach(controller.snapshot.audioTracks) { track in
                        Button {
                            controller.selectAudioTrack(track.id)
                            onActivity()
                        } label: {
                            Label(track.label, systemImage: track.selected ? "checkmark" : "headphones")
                        }
                    }
                }
            }

            Section("字幕") {
                Button("关闭字幕") {
                    controller.selectSubtitleTrack(nil)
                    onActivity()
                }
                ForEach(controller.snapshot.subtitleTracks) { track in
                    Button {
                        controller.selectSubtitleTrack(track.id)
                        onActivity()
                    } label: {
                        Label(track.label, systemImage: track.selected ? "checkmark" : "captions.bubble")
                    }
                }
            }
        } label: {
            Image(systemName: "gearshape")
                .frame(width: 44, height: 44)
        }
        .foregroundStyle(.white)
        .accessibilityLabel("播放设置")
        .simultaneousGesture(TapGesture().onEnded { _ in onActivity() })
    }
}

/** 创建最小 44pt 的视频图标按钮。 */
private struct PlayerIconButton: View {
    let symbol: String
    let label: String
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white.opacity(enabled ? 1 : 0.34))
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}

/** 创建半透明的十秒跳转按钮。 */
private struct PlayerRoundButton: View {
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 25, weight: .semibold))
                .frame(width: 50, height: 50)
                .background(Color.black.opacity(0.48))
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/** 显示局部播放错误并保留可恢复操作。 */
struct PlayerErrorOverlay: View {
    let message: String
    let canRetry: Bool
    let onRetry: () -> Void
    let onChooseFile: () -> Void
    let onClose: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.90)

            VStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 29, weight: .medium))
                    .foregroundStyle(Color(uiColor: .systemOrange))
                Text("播放失败")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                Text(message)
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.72))
                    .multilineTextAlignment(.center)
                    .lineLimit(3)

                HStack(spacing: 8) {
                    if canRetry {
                        Button("重试", action: onRetry)
                            .buttonStyle(PlayerErrorButtonStyle(prominent: true))
                    } else {
                        Button("选择视频", action: onChooseFile)
                            .buttonStyle(PlayerErrorButtonStyle(prominent: true))
                    }
                    Button("关闭", action: onClose)
                        .buttonStyle(PlayerErrorButtonStyle(prominent: false))
                }
                .padding(.top, 2)
            }
            .padding(24)
            .frame(maxWidth: 380)
        }
        .accessibilityElement(children: .contain)
    }
}

/** 为错误提示提供紧凑且一致的命令样式。 */
private struct PlayerErrorButtonStyle: ButtonStyle {
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 15)
            .frame(minHeight: 40)
            .background(prominent ? Color.accentColor : Color.white.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .opacity(configuration.isPressed ? 0.76 : 1)
    }
}
