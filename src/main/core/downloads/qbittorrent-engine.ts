import type { AddTorrentOptions, TorrentEngine } from "@shared/contracts";
import type { DownloadTask, TorrentFile } from "@shared/domain";
import { qbStateToStatus, QbittorrentClient, type QbittorrentClientOptions, type QbittorrentTorrentInfo } from "./qbittorrent-client";

export class QbittorrentEngine implements TorrentEngine {
  private readonly client: QbittorrentClient;
  private connected = false;

  constructor(options: QbittorrentClientOptions) {
    this.client = new QbittorrentClient(options);
  }

  async connect(): Promise<void> {
    await this.client.login();
    this.connected = true;
  }

  async addMagnet(magnetUrl: string, options: AddTorrentOptions): Promise<DownloadTask> {
    await this.ensureConnected();
    await this.client.addUrl(magnetUrl, options.savePath, options.paused);
    return createPendingTask(magnetUrl, options.savePath);
  }

  async addTorrentFile(filePath: string, options: AddTorrentOptions): Promise<DownloadTask> {
    await this.ensureConnected();
    await this.client.addTorrentFile(filePath, options.savePath, options.paused);
    return createPendingTask(filePath, options.savePath);
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

  private async mapTorrent(torrent: QbittorrentTorrentInfo): Promise<DownloadTask> {
    const files = await this.getFiles(torrent.hash);

    return {
      id: torrent.hash,
      engine: "qbittorrent",
      torrentHash: torrent.hash,
      name: torrent.name,
      status: qbStateToStatus(torrent.state),
      progress: torrent.progress,
      downloadSpeed: torrent.dlspeed,
      uploadSpeed: torrent.upspeed,
      etaSeconds: torrent.eta > 0 ? torrent.eta : undefined,
      savePath: torrent.save_path,
      files,
      createdAt: new Date().toISOString(),
      completedAt: torrent.progress >= 1 ? new Date().toISOString() : undefined
    };
  }
}

function createPendingTask(name: string, savePath: string): DownloadTask {
  const infoHash = extractInfoHash(name);

  return {
    id: infoHash ?? `pending-${Date.now()}`,
    engine: "qbittorrent",
    torrentHash: infoHash,
    name,
    status: "queued",
    progress: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath,
    files: [],
    createdAt: new Date().toISOString()
  };
}

function extractInfoHash(value: string): string | undefined {
  if (!value.startsWith("magnet:")) {
    return undefined;
  }

  const match = value.match(/xt=urn:btih:([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase();
}
