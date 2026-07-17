import type { AddTorrentOptions, TorrentEngine } from "@shared/contracts";
import type { DownloadTask, TorrentFile } from "@shared/domain";
import { randomUUID } from "node:crypto";
import { qbStateToStatus, QbittorrentClient, type QbittorrentClientOptions, type QbittorrentTorrentInfo } from "./qbittorrent-client";
import {
  downloadTorrentData,
  isHttpTorrentUrl,
  safeHost,
  type TorrentHttpClient
} from "./torrent-file-downloader";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import { logger } from "../logger";

const DEFAULT_ADD_CONFIRMATION_TIMEOUT_MS = 10_000;
const DEFAULT_ADD_CONFIRMATION_POLL_INTERVAL_MS = 250;

export interface QbittorrentEngineOptions extends QbittorrentClientOptions {
  torrentHttpClient?: TorrentHttpClient;
  addConfirmationTimeoutMs?: number;
  addConfirmationPollIntervalMs?: number;
}

export class QbittorrentEngine implements TorrentEngine {
  private readonly client: QbittorrentClient;
  private readonly torrentHttpClient: TorrentHttpClient;
  private readonly addConfirmationTimeoutMs: number;
  private readonly addConfirmationPollIntervalMs: number;
  private connected = false;

  constructor(options: QbittorrentEngineOptions) {
    this.client = new QbittorrentClient(options);
    this.torrentHttpClient = options.torrentHttpClient ?? defaultMetadataHttpClient;
    this.addConfirmationTimeoutMs = normalizePositiveInteger(
      options.addConfirmationTimeoutMs,
      DEFAULT_ADD_CONFIRMATION_TIMEOUT_MS
    );
    this.addConfirmationPollIntervalMs = normalizePositiveInteger(
      options.addConfirmationPollIntervalMs,
      DEFAULT_ADD_CONFIRMATION_POLL_INTERVAL_MS
    );
  }

  async connect(): Promise<void> {
    await this.client.login();
    this.connected = true;
  }

  /** 添加 magnet；兼容历史调用中传入的 torrent URL。 */
  async addMagnet(magnetUrl: string, options: AddTorrentOptions): Promise<DownloadTask> {
    await this.ensureConnected();
    const correlationTag = options.correlationTag ?? createCorrelationTag();

    try {
      if (isHttpTorrentUrl(magnetUrl)) {
        const torrent = await downloadTorrentData(magnetUrl, this.torrentHttpClient);
        await this.client.addTorrentData(
          torrent.data,
          torrent.fileName,
          options.savePath,
          options.paused,
          correlationTag
        );
        logger.info("qBittorrent torrent file uploaded", {
          host: safeHost(magnetUrl),
          fileName: torrent.fileName,
          size: torrent.data.byteLength,
          savePath: options.savePath
        });
      } else {
        await this.client.addUrl(magnetUrl, options.savePath, options.paused, correlationTag);
        logger.info("qBittorrent magnet added", {
          infoHash: extractInfoHash(magnetUrl),
          savePath: options.savePath
        });
      }

      return await this.confirmAddedTorrent(correlationTag);
    } catch (error) {
      logger.error("qBittorrent download add failed", {
        inputType: isHttpTorrentUrl(magnetUrl) ? "torrent-url" : "magnet",
        host: safeHost(magnetUrl),
        message: getErrorMessage(error)
      });
      throw error;
    }
  }

  /** 上传本地 torrent 文件到 qBittorrent。 */
  async addTorrentFile(filePath: string, options: AddTorrentOptions): Promise<DownloadTask> {
    await this.ensureConnected();
    const correlationTag = options.correlationTag ?? createCorrelationTag();
    await this.client.addTorrentFile(filePath, options.savePath, options.paused, correlationTag);
    return this.confirmAddedTorrent(correlationTag);
  }

  async listTasks(): Promise<DownloadTask[]> {
    await this.ensureConnected();
    const torrents = await this.client.listTorrents();
    return Promise.all(torrents.map((torrent) => this.mapTorrent(torrent)));
  }

  async getTask(taskId: string): Promise<DownloadTask> {
    await this.ensureConnected();
    const torrent = await this.client.getTorrent(taskId);
    if (!torrent) {
      throw new Error(`Torrent not found: ${taskId}`);
    }

    return this.mapTorrent(torrent);
  }

  async getFiles(taskId: string): Promise<TorrentFile[]> {
    await this.ensureConnected();
    const files = await this.client.getFiles(taskId);
    return files.map((file) => ({
      id: `${taskId}:${file.index}`,
      index: file.index,
      name: file.name,
      size: file.size,
      progress: file.progress,
      priority: file.priority,
      selected: file.priority > 0
    }));
  }

  async setFilePriority(taskId: string, fileIndexes: number[], priority: number): Promise<void> {
    await this.ensureConnected();
    await this.client.setFilePriority(taskId, fileIndexes, priority);
  }

  async pause(taskId: string): Promise<void> {
    await this.ensureConnected();
    await this.client.pause(taskId);
  }

  async resume(taskId: string): Promise<void> {
    await this.ensureConnected();
    await this.client.resume(taskId);
  }

  async remove(taskId: string, deleteFiles: boolean): Promise<void> {
    await this.ensureConnected();
    await this.client.remove(taskId, deleteFiles);
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  /** 轮询关联标签，只有 qBittorrent 返回真实任务后才允许业务层持久化。 */
  private async confirmAddedTorrent(correlationTag: string): Promise<DownloadTask> {
    const deadline = Date.now() + this.addConfirmationTimeoutMs;

    do {
      const torrent = (await this.client.listTorrentsByTag(correlationTag))[0];
      if (torrent) {
        const task = await this.mapConfirmedTorrent(torrent);
        logger.info("qBittorrent download add confirmed", {
          torrentHash: torrent.hash,
          correlationTag,
          state: torrent.state
        });
        return task;
      }

      await sleep(this.addConfirmationPollIntervalMs);
    } while (Date.now() < deadline);

    throw new Error(`qBittorrent 未在 ${this.addConfirmationTimeoutMs}ms 内确认新增任务`);
  }

  /** 映射刚确认的任务；magnet 元数据未完成时允许文件列表暂时为空。 */
  private async mapConfirmedTorrent(torrent: QbittorrentTorrentInfo): Promise<DownloadTask> {
    try {
      return await this.mapTorrent(torrent);
    } catch (error) {
      logger.warn("qBittorrent confirmed task files not ready", {
        torrentHash: torrent.hash,
        state: torrent.state,
        message: getErrorMessage(error)
      });
      return this.mapTorrentWithoutFiles(torrent);
    }
  }

  private async mapTorrent(torrent: QbittorrentTorrentInfo): Promise<DownloadTask> {
    const files = await this.getFiles(torrent.hash);

    return {
      ...this.mapTorrentWithoutFiles(torrent),
      files
    };
  }

  /** 映射 qBittorrent 任务基础字段，不依赖元数据文件列表。 */
  private mapTorrentWithoutFiles(torrent: QbittorrentTorrentInfo): DownloadTask {
    return {
      id: torrent.hash,
      engine: "qbittorrent",
      torrentHash: torrent.hash,
      correlationTag: extractCorrelationTag(torrent.tags),
      name: torrent.name,
      status: qbStateToStatus(torrent.state),
      progress: torrent.progress,
      downloadSpeed: torrent.dlspeed,
      uploadSpeed: torrent.upspeed,
      etaSeconds: torrent.eta > 0 ? torrent.eta : undefined,
      savePath: torrent.save_path,
      files: [],
      createdAt: new Date().toISOString(),
      completedAt: torrent.progress >= 1 ? new Date().toISOString() : undefined
    };
  }
}

function createCorrelationTag(): string {
  return `ani-tracker-${randomUUID()}`;
}

function extractCorrelationTag(tags?: string): string | undefined {
  return tags?.split(",").map((tag) => tag.trim()).find((tag) => tag.startsWith("ani-tracker-"));
}

function extractInfoHash(value: string): string | undefined {
  if (!value.startsWith("magnet:")) {
    return undefined;
  }

  const match = value.match(/xt=urn:btih:([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isFinite(value) ? Math.max(1, Math.round(value)) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
