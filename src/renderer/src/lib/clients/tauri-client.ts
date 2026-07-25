import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppClient } from "@shared/app-client";
import type { AppWindowState } from "@shared/contracts";

const WINDOW_STATE_CHANGED_EVENT = "window-state-changed";

interface TauriCommandError {
  code?: string;
  message?: string;
}

type TauriClientPlatform = "tauri-desktop" | "android" | "ios";

/** 将 Tauri 拒绝值转换为可展示错误。 */
function normalizeTauriError(method: string, error: unknown): Error {
  if (error && typeof error === "object") {
    const commandError = error as TauriCommandError;
    if (commandError.message) {
      return new Error(commandError.message);
    }
  }
  return new Error(`Tauri 命令 ${method} 执行失败：${String(error)}`);
}

/** 封装 P1 已开放的 Tauri 平台命令与事件。 */
class TauriClientCore {
  /** 保存当前 Tauri 宿主对应的平台标识。 */
  constructor(readonly platform: TauriClientPlatform) {}

  /** 读取 Tauri 主窗口状态。 */
  async getWindowState(): Promise<AppWindowState> {
    return invoke<AppWindowState>("get_window_state").catch((error) => {
      throw normalizeTauriError("get_window_state", error);
    });
  }

  /** 最小化 Tauri 主窗口。 */
  async minimizeWindow(): Promise<void> {
    return invoke<void>("minimize_window").catch((error) => {
      throw normalizeTauriError("minimize_window", error);
    });
  }

  /** 切换 Tauri 主窗口最大化状态。 */
  async toggleMaximizeWindow(): Promise<AppWindowState> {
    return invoke<AppWindowState>("toggle_maximize_window").catch((error) => {
      throw normalizeTauriError("toggle_maximize_window", error);
    });
  }

  /** 关闭 Tauri 主窗口。 */
  async closeWindow(): Promise<void> {
    return invoke<void>("close_window").catch((error) => {
      throw normalizeTauriError("close_window", error);
    });
  }

  /** 订阅 Tauri 主窗口最大化状态变化。 */
  onWindowStateChanged(listener: (state: AppWindowState) => void): () => void {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<AppWindowState>(WINDOW_STATE_CHANGED_EVENT, (event) => listener(event.payload))
      .then((disposeListener) => {
        if (disposed) {
          disposeListener();
          return;
        }
        unlisten = disposeListener;
      })
      .catch((error) => {
        console.error("[tauri-client] 窗口状态订阅失败", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }

  /** 使用系统默认程序打开外部 HTTP 或 HTTPS 链接。 */
  async openExternal(url: string): Promise<void> {
    return invoke<void>("open_external", { url }).catch((error) => {
      throw normalizeTauriError("open_external", error);
    });
  }
}

/** 创建仅暴露已迁移命令的 Tauri AppClient。 */
export function createTauriClient(platform: TauriClientPlatform): AppClient {
  const client = new TauriClientCore(platform);
  return new Proxy(client as unknown as AppClient, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value === "function") {
        return value.bind(target);
      }
      if (value !== undefined || typeof property !== "string") {
        return value;
      }

      return async () => {
        console.warn("[tauri-client] 调用了尚未迁移的业务方法", { method: property });
        throw new Error(`Tauri 业务方法尚未迁移：${property}`);
      };
    }
  });
}
