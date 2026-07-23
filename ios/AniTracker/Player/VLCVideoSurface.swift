import SwiftUI
import UIKit

/** 将 MobileVLCKit 的原生视频输出表面嵌入 SwiftUI。 */
struct VLCVideoSurface: UIViewRepresentable {
    let controller: MobileVLCPlayerController

    /** 保存控制器引用，供视图销毁时精确解绑。 */
    final class Coordinator {
        let controller: MobileVLCPlayerController

        init(controller: MobileVLCPlayerController) {
            self.controller = controller
        }
    }

    /** 创建纯黑的视频承载视图。 */
    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.backgroundColor = .black
        view.isOpaque = true
        controller.attach(to: view)
        return view
    }

    /** 旋转或重组后确保 VLC 仍绑定当前视图。 */
    func updateUIView(_ uiView: UIView, context: Context) {
        controller.attach(to: uiView)
    }

    /** 创建负责生命周期解绑的协调器。 */
    func makeCoordinator() -> Coordinator {
        Coordinator(controller: controller)
    }

    /** SwiftUI 移除视频表面时保留底层播放会话。 */
    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.controller.detach(from: uiView)
    }
}
