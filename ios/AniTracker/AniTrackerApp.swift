import OSLog
import SwiftUI

private let applicationLogger = Logger(subsystem: "dev.ani.tracker", category: "Application")

/** Ani Tracker iOS 原生 VLC 播放器入口。 */
@main
struct AniTrackerApp: App {
    @StateObject private var playerController = MobileVLCPlayerController()

    var body: some Scene {
        WindowGroup {
            PlayerApplicationView(controller: playerController)
        }
    }
}

/** 连接深链、进程参数和应用生命周期。 */
private struct PlayerApplicationView: View {
    @ObservedObject var controller: MobileVLCPlayerController

    @Environment(\.scenePhase) private var scenePhase
    @State private var bootstrapped = false

    var body: some View {
        PlayerScreen(controller: controller, onClose: controller.close)
            .tint(Color.accentColor)
            .onAppear(perform: bootstrapIfNeeded)
            .onOpenURL(perform: openDeepLink)
            .onChange(of: scenePhase, perform: handleScenePhase)
    }

    /** 首次显示时读取模拟器调试参数。 */
    private func bootstrapIfNeeded() {
        guard !bootstrapped else { return }
        bootstrapped = true
        guard let request = PlayerLaunchParser.parseProcessArguments() else {
            applicationLogger.info("iOS 播放器等待深链或本地文件")
            return
        }
        controller.initialize(request)
        applicationLogger.info("iOS 播放器已从进程参数创建会话")
    }

    /** 解析 anitracker://player 深链并替换当前会话。 */
    private func openDeepLink(_ url: URL) {
        guard let request = PlayerLaunchParser.parse(url) else {
            applicationLogger.error("iOS 播放器收到无效深链")
            controller.showError("播放任务不存在或媒体地址无效")
            return
        }
        controller.initialize(request)
        applicationLogger.info("iOS 播放器已从深链创建会话")
    }

    /** 前后台切换时保持用户主动暂停意图。 */
    private func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            controller.becomeActive()
        case .background:
            controller.enterBackground()
        case .inactive:
            break
        @unknown default:
            break
        }
    }
}
