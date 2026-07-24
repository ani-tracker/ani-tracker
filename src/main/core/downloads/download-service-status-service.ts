import type {
  DownloadServiceStatus,
  EmbeddedTorrentCoreStatus,
  QbittorrentManagedStatus,
  TorrentConnectionTestResult
} from "@shared/contracts";
import type { AppSettings } from "@shared/domain";

export interface DownloadServiceStatusDependencies {
  getEmbeddedStatus: (settings: AppSettings) => EmbeddedTorrentCoreStatus | Promise<EmbeddedTorrentCoreStatus>;
  getManagedStatus: (settings: AppSettings) => QbittorrentManagedStatus | Promise<QbittorrentManagedStatus>;
  testExternalConnection: (settings: AppSettings) => TorrentConnectionTestResult | Promise<TorrentConnectionTestResult>;
}

/** 按当前默认下载模式汇总真实核心状态，避免各界面分别推断。 */
export class DownloadServiceStatusService {
  constructor(private readonly dependencies: DownloadServiceStatusDependencies) {}

  /** 查询当前默认下载引擎，并将不同后端状态归一化。 */
  async getStatus(settings: AppSettings): Promise<DownloadServiceStatus> {
    if (settings.download.defaultTorrentEngine === "embedded") {
      return this.getEmbeddedStatus(settings);
    }
    if (settings.download.qbittorrent.managed.enabled) {
      return this.getManagedStatus(settings);
    }
    return this.getExternalStatus(settings);
  }

  /** 查询内置 libtorrent sidecar 的进程状态。 */
  private async getEmbeddedStatus(settings: AppSettings): Promise<DownloadServiceStatus> {
    try {
      const status = await this.dependencies.getEmbeddedStatus(settings);
      if (status.lastError) {
        return { mode: "embedded", state: "error", message: status.lastError };
      }
      if (status.running) {
        return {
          mode: "embedded",
          state: "online",
          message: "内置下载核心运行中",
          taskCount: status.taskCount
        };
      }
      return {
        mode: "embedded",
        state: "idle",
        message: status.enabled ? "内置下载核心未运行" : "内置下载核心未启用"
      };
    } catch (error) {
      return createErrorStatus("embedded", error, "读取内置下载核心状态失败");
    }
  }

  /** 查询应用托管 qBittorrent-nox 的进程状态。 */
  private async getManagedStatus(settings: AppSettings): Promise<DownloadServiceStatus> {
    try {
      const status = await this.dependencies.getManagedStatus(settings);
      if (status.lastError) {
        return { mode: "managed", state: "error", message: status.lastError };
      }
      if (status.running) {
        return { mode: "managed", state: "online", message: "qBittorrent-nox 运行中" };
      }
      return {
        mode: "managed",
        state: "idle",
        message: status.enabled ? "qBittorrent-nox 未运行" : "托管核心未启用"
      };
    } catch (error) {
      return createErrorStatus("managed", error, "读取 qBittorrent-nox 状态失败");
    }
  }

  /** 验证外部 qBittorrent WebUI 的连接状态。 */
  private async getExternalStatus(settings: AppSettings): Promise<DownloadServiceStatus> {
    try {
      const result = await this.dependencies.testExternalConnection(settings);
      return {
        mode: "external",
        state: result.ok ? "online" : "error",
        message: result.ok ? "外部 qBittorrent 已连接" : result.message,
        taskCount: result.taskCount
      };
    } catch (error) {
      return createErrorStatus("external", error, "外部 qBittorrent 连接失败");
    }
  }
}

/** 将状态查询异常转换为可展示结果，避免应用壳刷新失败。 */
function createErrorStatus(
  mode: DownloadServiceStatus["mode"],
  error: unknown,
  fallbackMessage: string
): DownloadServiceStatus {
  return {
    mode,
    state: "error",
    message: error instanceof Error ? error.message : fallbackMessage
  };
}
