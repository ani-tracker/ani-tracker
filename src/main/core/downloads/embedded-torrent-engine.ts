import type { AddTorrentOptions, TorrentEngine } from "@shared/contracts";
import type { AppSettings, DownloadStatus, DownloadTask, TorrentFile } from "@shared/domain";
import {
  embeddedTorrentCoreService,
  type EmbeddedTorrentCoreClient
} from "./embedded-torrent-core-service";

const DOWNLOAD_STATUSES = new Set<DownloadStatus>([
  "queued",
  "fetching_metadata",
  "downloading",
  "stalled",
  "paused",
  "checking",
  "moving",
  "completed",
  "seeding",
  "error",
  "missing_files"
]);

export interface EmbeddedTorrentEngineOptions {
  settings: AppSettings;
  client?: EmbeddedTorrentCoreClient;
}

/** 将内置 sidecar 协议适配为应用统一 TorrentEngine。 */
export class EmbeddedTorrentEngine implements TorrentEngine {
  private readonly settings: AppSettings;
  private readonly client: EmbeddedTorrentCoreClient;

  constructor(options: EmbeddedTorrentEngineOptions) {
    this.settings = options.settings;
    this.client = options.client ?? embeddedTorrentCoreService;
  }

  /** 向内置核心添加 magnet 任务。 */
  async addMagnet(magnetUrl: string, options: AddTorrentOptions): Promise<DownloadTask> {
    const result = await this.execute("addMagnet", {
      url: magnetUrl,
      ...toCoreAddOptions(options)
    });
    return mapCoreTask(result);
  }

  /** 向内置核心添加本地 torrent 文件。 */
  async addTorrentFile(filePath: string, options: AddTorrentOptions): Promise<DownloadTask> {
    const result = await this.execute("addTorrentFile", {
      filePath,
      ...toCoreAddOptions(options)
    });
    return mapCoreTask(result);
  }

  /** 返回内置核心中的全部任务。 */
  async listTasks(): Promise<DownloadTask[]> {
    const result = asRecord(await this.execute("listTasks", {}));
    return asArray(result.tasks).map(mapCoreTask);
  }

  /** 返回指定内置任务快照。 */
  async getTask(taskId: string): Promise<DownloadTask> {
    return mapCoreTask(await this.execute("getTask", { taskId }));
  }

  /** 返回指定内置任务的文件快照。 */
  async getFiles(taskId: string): Promise<TorrentFile[]> {
    const result = asRecord(await this.execute("getFiles", { taskId }));
    return asArray(result.files).map((file) => mapCoreFile(taskId, file));
  }

  /** 设置指定文件索引的下载优先级。 */
  async setFilePriority(taskId: string, fileIndexes: number[], priority: number): Promise<void> {
    await this.execute("setFilePriority", { taskId, fileIndexes, priority });
  }

  /** 暂停指定内置任务。 */
  async pause(taskId: string): Promise<void> {
    await this.execute("pause", { taskId });
  }

  /** 恢复指定内置任务。 */
  async resume(taskId: string): Promise<void> {
    await this.execute("resume", { taskId });
  }

  /** 移除指定任务，并按参数决定是否删除下载文件。 */
  async remove(taskId: string, deleteFiles: boolean): Promise<void> {
    await this.execute("remove", { taskId, deleteFiles });
  }

  /** 使用当前应用设置执行一条 sidecar 命令。 */
  private execute<T>(method: Parameters<EmbeddedTorrentCoreClient["execute"]>[0], params: Record<string, unknown>) {
    return this.client.execute<T>(method, params, this.settings);
  }
}

/** 将 sidecar 任务快照转换为共享领域模型。 */
export function mapCoreTask(value: unknown): DownloadTask {
  const task = asRecord(value);
  const id = readRequiredString(task.id, "任务标识");
  const completedAt = readOptionalString(task.completedAt);
  return {
    id,
    engine: "embedded",
    torrentHash: readOptionalString(task.torrentHash) ?? id,
    correlationTag: readOptionalString(task.correlationTag),
    name: readOptionalString(task.name) ?? id,
    status: readDownloadStatus(task.status),
    progress: normalizeProgress(task.progress),
    downloadSpeed: readNumber(task.downloadSpeed, 0),
    uploadSpeed: readNumber(task.uploadSpeed, 0),
    etaSeconds: readNumber(task.etaSeconds, 0),
    savePath: readOptionalString(task.savePath) ?? "",
    files: asArray(task.files).map((file) => mapCoreFile(id, file)),
    createdAt: readOptionalString(task.createdAt) ?? new Date().toISOString(),
    completedAt
  };
}

/** 将 sidecar 文件快照转换为共享领域模型。 */
export function mapCoreFile(taskId: string, value: unknown): TorrentFile {
  const file = asRecord(value);
  const index = Math.max(0, Math.round(readNumber(file.index, 0)));
  const priority = Math.max(0, Math.round(readNumber(file.priority, 0)));
  return {
    id: `${taskId}:${index}`,
    index,
    name: readOptionalString(file.name) ?? `文件 ${index + 1}`,
    size: Math.max(0, readNumber(file.size, 0)),
    progress: normalizeProgress(file.progress),
    priority,
    selected: readBoolean(file.selected, priority > 0)
  };
}

function toCoreAddOptions(options: AddTorrentOptions): Record<string, unknown> {
  return {
    savePath: options.savePath,
    selectedFileIndexes: options.selectedFileIndexes ?? [],
    correlationTag: options.correlationTag ?? "",
    paused: options.paused ?? false
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("内置下载核心返回了无效对象");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readRequiredString(value: unknown, label: string): string {
  const result = readOptionalString(value);
  if (!result) {
    throw new Error(`内置下载核心缺少${label}`);
  }
  return result;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function readDownloadStatus(value: unknown): DownloadStatus {
  return typeof value === "string" && DOWNLOAD_STATUSES.has(value as DownloadStatus)
    ? value as DownloadStatus
    : "error";
}

function normalizeProgress(value: unknown): number {
  return Math.min(1, Math.max(0, readNumber(value, 0)));
}
