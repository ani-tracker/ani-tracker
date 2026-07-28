import OSLog
import SwiftUI
import UniformTypeIdentifiers
import UIKit

private let playerScreenLogger = Logger(subsystem: "dev.ani.tracker", category: "PlayerScreen")

/** 组合 Tauri 原生页的方向自适应布局、控制层显隐和文件选择。 */
struct PlayerScreen: View {
    @ObservedObject var controller: MobileVLCPlayerController

    let onClose: () -> Void

    @State private var controlsVisible = true
    @State private var playlistPresented = false
    @State private var interactionSequence = 0
    @State private var fileImporterPresented = false

    var body: some View {
        GeometryReader { geometry in
            let landscape = geometry.size.width > geometry.size.height

            // 横竖屏保持同一视频结构节点，避免 SwiftUI 重建 MobileVLCKit drawable。
            VStack(spacing: 0) {
                videoStage(
                    compact: !landscape,
                    safeAreaInsets: landscape
                        ? geometry.safeAreaInsets
                        : EdgeInsets(
                            top: geometry.safeAreaInsets.top,
                            leading: geometry.safeAreaInsets.leading,
                            bottom: 0,
                            trailing: geometry.safeAreaInsets.trailing
                        ),
                    landscape: landscape,
                    availableWidth: geometry.size.width
                )
                .frame(maxWidth: .infinity, maxHeight: landscape ? .infinity : nil)
                .frame(height: landscape ? nil : geometry.size.width * 9 / 16 + geometry.safeAreaInsets.top)

                if !landscape {
                    PlayerDetailsView(
                        snapshot: controller.snapshot,
                        onSelectEpisode: selectEpisode
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(landscape ? Color.black : Color(uiColor: .systemBackground))
            .ignoresSafeArea(edges: landscape ? .all : .top)
            .animation(.easeOut(duration: 0.18), value: controlsVisible)
            .animation(.easeOut(duration: 0.20), value: playlistPresented)
            .task(id: autoHideToken) {
                await scheduleControlHiding()
            }
            .onChange(of: controller.snapshot.status) { status in
                if status != .playing {
                    revealControls()
                }
            }
            .onChange(of: controller.snapshot.activeIndex) { _ in
                revealControls()
                playlistPresented = false
            }
            .onChange(of: landscape) { isLandscape in
                playlistPresented = false
                revealControls()
                playerScreenLogger.info("iOS 播放器方向已切换: landscape=\(isLandscape, privacy: .public)")
            }
        }
        .statusBarHidden(true)
        .fileImporter(
            isPresented: $fileImporterPresented,
            allowedContentTypes: [.audiovisualContent, .data],
            allowsMultipleSelection: false,
            onCompletion: handleImportedFiles
        )
    }

    /** 组合 VLC 表面、手势、加载、错误和控制层。 */
    private func videoStage(
        compact: Bool,
        safeAreaInsets: EdgeInsets,
        landscape: Bool,
        availableWidth: CGFloat
    ) -> some View {
        ZStack {
            Color.black
            VLCVideoSurface(controller: controller)
                .accessibilityHidden(true)

            PlayerGestureLayer(
                onSingleTap: toggleControls,
                onDoubleTapLeft: {
                    controller.skip(by: -10_000)
                    revealControls()
                },
                onDoubleTapCenter: {
                    controller.togglePlayback()
                    revealControls()
                },
                onDoubleTapRight: {
                    controller.skip(by: 10_000)
                    revealControls()
                }
            )

            if controlsVisible && currentErrorMessage == nil {
                PlayerControlsView(
                    controller: controller,
                    compact: compact,
                    safeAreaInsets: safeAreaInsets,
                    onClose: closePlayer,
                    onActivity: revealControls,
                    onTogglePlaylist: {
                        playlistPresented.toggle()
                        revealControls()
                    },
                    onToggleOrientation: {
                        requestOrientation(landscape ? .portrait : .landscape)
                    }
                )
                .transition(.opacity)
            }

            if controller.snapshot.status == .loading || controller.snapshot.status == .buffering {
                ProgressView()
                    .tint(.white)
                    .scaleEffect(1.15)
                    .frame(width: 52, height: 52)
                    .background(Color.black.opacity(0.42))
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .accessibilityLabel(controller.snapshot.status == .loading ? "正在准备视频" : "正在缓冲")
            }

            if landscape && playlistPresented && currentErrorMessage == nil {
                Color.black.opacity(0.30)
                    .ignoresSafeArea()
                    .onTapGesture {
                        playlistPresented = false
                        revealControls()
                    }

                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    LandscapePlaylistPanel(
                        snapshot: controller.snapshot,
                        onSelectEpisode: selectEpisode,
                        onClose: {
                            playlistPresented = false
                            revealControls()
                        }
                    )
                    .padding(.trailing, safeAreaInsets.trailing)
                    .background(Color(uiColor: .systemBackground).opacity(0.98))
                    .frame(width: max(320, min(390, availableWidth * 0.42)))
                    .padding(.top, safeAreaInsets.top)
                    .padding(.bottom, safeAreaInsets.bottom)
                    .transition(.move(edge: .trailing))
                }
            }

            if
                let seconds = controller.snapshot.autoNextSecondsRemaining,
                let nextEpisode = controller.snapshot.episodes[safe: controller.snapshot.activeIndex + 1],
                currentErrorMessage == nil
            {
                AutoNextOverlay(
                    episodeLabel: nextEpisode.episodeLabel,
                    seconds: seconds,
                    onCancel: controller.cancelAutoNext,
                    onPlayNow: controller.nextEpisode
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                .padding(.trailing, max(12, safeAreaInsets.trailing))
                .padding(.bottom, compact ? 68 : max(84, safeAreaInsets.bottom + 68))
            }

            if let errorMessage = currentErrorMessage {
                PlayerErrorOverlay(
                    message: errorMessage,
                    canRetry: !controller.snapshot.episodes.isEmpty,
                    onRetry: controller.retry,
                    onChooseFile: { fileImporterPresented = true },
                    onClose: closePlayer
                )
            }
        }
        .clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("视频播放器")
    }

    /** 返回真实错误或缺少媒体时的占位错误。 */
    private var currentErrorMessage: String? {
        if let message = controller.snapshot.errorMessage { return message }
        if controller.snapshot.episodes.isEmpty { return "尚未选择可播放的媒体" }
        return nil
    }

    /** 生成可取消的控制层隐藏任务标识。 */
    private var autoHideToken: String {
        "\(interactionSequence)-\(controller.snapshot.status)-\(controlsVisible)-\(playlistPresented)"
    }

    /** 播放三秒无操作后隐藏控制层。 */
    private func scheduleControlHiding() async {
        guard
            controller.snapshot.status == .playing,
            controlsVisible,
            !playlistPresented,
            currentErrorMessage == nil
        else { return }

        try? await Task.sleep(nanoseconds: 3_000_000_000)
        guard !Task.isCancelled else { return }
        withAnimation(.easeOut(duration: 0.18)) {
            controlsVisible = false
        }
    }

    /** 显示控制层并重置隐藏计时。 */
    private func revealControls() {
        controlsVisible = true
        interactionSequence &+= 1
    }

    /** 仅在播放状态允许手动隐藏控制层。 */
    private func toggleControls() {
        if controlsVisible && controller.snapshot.status == .playing && !playlistPresented {
            controlsVisible = false
        } else {
            revealControls()
        }
    }

    /** 切换单集并关闭横屏列表。 */
    private func selectEpisode(_ index: Int) {
        guard index != controller.snapshot.activeIndex else {
            playlistPresented = false
            revealControls()
            return
        }
        controller.selectEpisode(at: index)
        playlistPresented = false
        revealControls()
    }

    /** 关闭当前播放会话并恢复竖屏。 */
    private func closePlayer() {
        playlistPresented = false
        requestOrientation(.portrait)
        onClose()
    }

    /** 请求 iOS 16 场景切换为目标方向。 */
    private func requestOrientation(_ orientations: UIInterfaceOrientationMask) {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
        else { return }

        scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientations)) { error in
            playerScreenLogger.error("iOS 播放器方向切换失败: \(error.localizedDescription, privacy: .public)")
        }
        UIViewController.attemptRotationToDeviceOrientation()
    }

    /** 读取文件选择结果并交给安全作用域播放器入口。 */
    private func handleImportedFiles(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else {
                controller.showError("未选择可播放的视频文件")
                return
            }
            controller.loadSecurityScopedMedia(url)
            revealControls()
        case .failure(let error):
            playerScreenLogger.error("iOS 本地媒体选择失败: \(error.localizedDescription, privacy: .public)")
            controller.showError("无法访问所选视频文件")
        }
    }
}

/** 在视频内显示可取消的自动下一集提示。 */
private struct AutoNextOverlay: View {
    let episodeLabel: String
    let seconds: Int
    let onCancel: () -> Void
    let onPlayNow: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(seconds) 秒后播放")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.68))
                Text(episodeLabel)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
            }
            .frame(width: 116, alignment: .leading)

            Button(action: onPlayNow) {
                Image(systemName: "forward.end.fill")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("立即播放下一集")

            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("取消自动下一集")
        }
        .padding(10)
        .foregroundStyle(.white)
        .background(Color.black.opacity(0.95))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(.white.opacity(0.18), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }
}

private extension Collection {
    /** 安全读取集合索引，避免播放列表更新时越界。 */
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

/** 将视频区域划分为三段，支持单击和双击操作。 */
private struct PlayerGestureLayer: View {
    let onSingleTap: () -> Void
    let onDoubleTapLeft: () -> Void
    let onDoubleTapCenter: () -> Void
    let onDoubleTapRight: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            tapRegion(doubleTapAction: onDoubleTapLeft)
            tapRegion(doubleTapAction: onDoubleTapCenter)
            tapRegion(doubleTapAction: onDoubleTapRight)
        }
    }

    /** 创建一个等宽手势区域。 */
    private func tapRegion(doubleTapAction: @escaping () -> Void) -> some View {
        Color.clear
            .contentShape(Rectangle())
            .onTapGesture(count: 2, perform: doubleTapAction)
            .onTapGesture(count: 1, perform: onSingleTap)
    }
}
