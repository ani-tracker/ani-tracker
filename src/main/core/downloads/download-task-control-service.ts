import type { DownloadTask, TorrentEngineKind } from "@shared/domain";
import type { TorrentEngine } from "@shared/contracts";
import type { AppRepository } from "../repositories/app-repository";
import { CompletedDownloadMediaAutoScanner } from "../media/completed-download-media-auto-scanner";
import type { QbittorrentManagedService } from "./qbittorrent-managed-service";
import { createTorrentEngineForKind } from "./torrent-engine-factory";
import type { EmbeddedTorrentCoreClient } from "./embedded-torrent-core-service";
import { logger } from "../logger";

export interface DownloadTaskControlServiceOptions {
  embeddedTorrentClient?: EmbeddedTorrentCoreClient;
}

export class DownloadTaskControlService {
  private readonly mediaAutoScanner: CompletedDownloadMediaAutoScanner;

  /** 创建供 IPC 与远程网关共同调用的下载任务控制服务。 */
  constructor(
    private readonly repository: AppRepository,
    private readonly qbittorrentManagedService: QbittorrentManagedService,
    private readonly options: DownloadTaskControlServiceOptions = {}
  ) {
    this.mediaAutoScanner = new CompletedDownloadMediaAutoScanner(repository);
  }

  /** 刷新默认引擎及旧任务所属引擎，并异步触发已完成媒体扫描。 */
  async refresh(): Promise<DownloadTask[]> {
    const settings = await this.repository.getSettings();
    const existing = await this.repository.listDownloads();
    const kinds = new Set<TorrentEngineKind>([
      settings.download.defaultTorrentEngine,
      ...existing.map((task) => task.engine)
    ]);
    const tasks: DownloadTask[] = [];
    for (const kind of kinds) {
      try {
        tasks.push(...await this.createEngine(kind).then((engine) => engine.listTasks()));
      } catch (error) {
        if (kind === settings.download.defaultTorrentEngine) {
          throw error;
        }
        logger.warn("Inactive torrent engine refresh failed", {
          engine: kind,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const merged = await this.repository.mergeDownloadTasksFromEngine(tasks);
    void this.mediaAutoScanner.scanCompletedTasks(merged);
    return merged;
  }

  /** 暂停指定下载任务，并同步本地任务状态。 */
  async pause(taskId: string): Promise<DownloadTask[]> {
    const task = await this.requireTask(taskId);
    const engine = await this.createEngine(task.engine);
    await engine.pause(task.torrentHash ?? task.id);
    return this.repository.updateDownloadStatus(task.id, "paused");
  }

  /** 恢复指定下载任务，并同步本地任务状态。 */
  async resume(taskId: string): Promise<DownloadTask[]> {
    const task = await this.requireTask(taskId);
    const engine = await this.createEngine(task.engine);
    await engine.resume(task.torrentHash ?? task.id);
    return this.repository.updateDownloadStatus(task.id, "downloading");
  }

  /** 从任务原属引擎移除任务，再删除本地业务关联。 */
  async remove(taskId: string, deleteFiles: boolean): Promise<DownloadTask[]> {
    const task = await this.requireTask(taskId);
    const engine = await this.createEngine(task.engine);
    await engine.remove(task.torrentHash ?? task.id, deleteFiles);
    return this.repository.removeDownloadTask(task.id);
  }

  /** 更新任务原属引擎的文件优先级，并同步本地快照。 */
  async setFilePriority(taskId: string, fileIndexes: number[], priority: number): Promise<DownloadTask[]> {
    const task = await this.requireTask(taskId);
    const engine = await this.createEngine(task.engine);
    await engine.setFilePriority(task.torrentHash ?? task.id, fileIndexes, priority);
    return this.repository.upsertDownloadTask({
      ...task,
      files: task.files.map((file) => fileIndexes.includes(file.index)
        ? { ...file, priority, selected: priority > 0 }
        : file)
    });
  }

  /** 读取任务并统一返回不存在错误。 */
  private async requireTask(taskId: string): Promise<DownloadTask> {
    const task = await this.repository.getDownloadTask(taskId);
    if (!task) {
      throw new Error("下载任务不存在");
    }
    return task;
  }

  /** 使用当前设置创建指定类型的任务控制引擎。 */
  private async createEngine(kind: TorrentEngineKind): Promise<TorrentEngine> {
    const settings = await this.repository.getSettings();
    return createTorrentEngineForKind(settings, kind, {
      qbittorrentBaseUrl: this.qbittorrentManagedService.getRuntimeBaseUrl(settings),
      embeddedTorrentClient: this.options.embeddedTorrentClient
    });
  }
}
