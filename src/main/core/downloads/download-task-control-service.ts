import type { DownloadTask } from "@shared/domain";
import type { AppRepository } from "../repositories/app-repository";
import { CompletedDownloadMediaAutoScanner } from "../media/completed-download-media-auto-scanner";
import type { QbittorrentManagedService } from "./qbittorrent-managed-service";
import { QbittorrentEngine } from "./qbittorrent-engine";
import { createTorrentEngine } from "./torrent-engine-factory";

export class DownloadTaskControlService {
  private readonly mediaAutoScanner: CompletedDownloadMediaAutoScanner;

  /** 创建供 IPC 与远程网关共同调用的下载任务控制服务。 */
  constructor(
    private readonly repository: AppRepository,
    private readonly qbittorrentManagedService: QbittorrentManagedService
  ) {
    this.mediaAutoScanner = new CompletedDownloadMediaAutoScanner(repository);
  }

  /** 从当前下载引擎刷新任务，并异步触发已完成媒体扫描。 */
  async refresh(): Promise<DownloadTask[]> {
    const settings = await this.repository.getSettings();
    const engine = createTorrentEngine(settings, {
      qbittorrentBaseUrl: this.qbittorrentManagedService.getRuntimeBaseUrl(settings)
    });
    const tasks = await engine.listTasks();
    const merged = await this.repository.mergeDownloadTasksFromEngine(tasks);
    void this.mediaAutoScanner.scanCompletedTasks(merged);
    return merged;
  }

  /** 暂停指定下载任务，并同步本地任务状态。 */
  async pause(taskId: string): Promise<DownloadTask[]> {
    const task = await this.requireTask(taskId);
    if (task.engine === "qbittorrent") {
      const engine = await this.createQbittorrentEngine();
      await engine.pause(task.torrentHash ?? task.id);
    }
    return this.repository.updateDownloadStatus(task.id, "paused");
  }

  /** 恢复指定下载任务，并同步本地任务状态。 */
  async resume(taskId: string): Promise<DownloadTask[]> {
    const task = await this.requireTask(taskId);
    if (task.engine === "qbittorrent") {
      const engine = await this.createQbittorrentEngine();
      await engine.resume(task.torrentHash ?? task.id);
    }
    return this.repository.updateDownloadStatus(task.id, "downloading");
  }

  /** 读取任务并统一返回不存在错误。 */
  private async requireTask(taskId: string): Promise<DownloadTask> {
    const task = await this.repository.getDownloadTask(taskId);
    if (!task) {
      throw new Error("下载任务不存在");
    }
    return task;
  }

  /** 使用当前设置创建 qBittorrent 控制引擎。 */
  private async createQbittorrentEngine(): Promise<QbittorrentEngine> {
    const settings = await this.repository.getSettings();
    return new QbittorrentEngine({
      baseUrl: this.qbittorrentManagedService.getRuntimeBaseUrl(settings),
      username: settings.download.qbittorrent.username,
      password: settings.download.qbittorrent.password
    });
  }
}
