import { mapQbittorrentState } from "../torrent-state";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface QbittorrentClientOptions {
  baseUrl: string;
  username: string;
  password?: string;
  requestTimeoutMs?: number;
}

export interface QbittorrentTorrentInfo {
  hash: string;
  name: string;
  state: string;
  progress: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  save_path: string;
  content_path?: string;
  size?: number;
  tags?: string;
}

export interface QbittorrentTorrentFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
  is_seed?: boolean;
}

export interface QbittorrentSeedingLimits {
  ratioLimit: number;
  timeLimitMinutes: number;
}

const DEFAULT_QBITTORRENT_REQUEST_TIMEOUT_MS = 15_000;

export class QbittorrentClient {
  private cookie = "";

  constructor(private readonly options: QbittorrentClientOptions) {}

  async login(): Promise<void> {
    const body = new URLSearchParams({
      username: this.options.username,
      password: this.options.password ?? ""
    });

    const response = await this.requestRaw("/api/v2/auth/login", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    if (!response.ok) {
      throw new Error(`qBittorrent login failed: ${response.status} ${response.statusText}`);
    }

    if (response.status === 204) {
      const cookie = response.headers.get("set-cookie");
      if (cookie) {
        this.cookie = cookie.split(";")[0];
      }
      return;
    }

    const text = await response.text();
    if (!text.toLowerCase().includes("ok")) {
      throw new Error("qBittorrent login failed: invalid username or password");
    }

    const cookie = response.headers.get("set-cookie");
    if (cookie) {
      this.cookie = cookie.split(";")[0];
    }
  }

  async addUrl(url: string, savePath: string, paused = false, correlationTag?: string): Promise<void> {
    const body = new URLSearchParams({
      urls: url,
      savepath: savePath,
      paused: paused ? "true" : "false"
    });
    if (correlationTag) {
      body.set("tags", correlationTag);
    }

    await this.requestAddTorrent({
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
  }

  async addTorrentFile(filePath: string, savePath: string, paused = false, correlationTag?: string): Promise<void> {
    const buffer = await readFile(filePath);
    await this.addTorrentData(buffer, basename(filePath), savePath, paused, correlationTag);
  }

  /** 将内存中的 torrent 元数据通过 multipart 上传到 qBittorrent。 */
  async addTorrentData(
    data: Uint8Array,
    fileName: string,
    savePath: string,
    paused = false,
    correlationTag?: string
  ): Promise<void> {
    const formData = new FormData();
    formData.append("torrents", new Blob([Buffer.from(data)]), fileName);
    formData.append("savepath", savePath);
    formData.append("paused", paused ? "true" : "false");
    if (correlationTag) {
      formData.append("tags", correlationTag);
    }

    await this.requestAddTorrent({
      method: "POST",
      body: formData
    });
  }

  async listTorrents(): Promise<QbittorrentTorrentInfo[]> {
    return this.requestJson<QbittorrentTorrentInfo[]>("/api/v2/torrents/info");
  }

  /** 按 Ani Tracker 关联标签查询已被 qBittorrent 接收的任务。 */
  async listTorrentsByTag(tag: string): Promise<QbittorrentTorrentInfo[]> {
    return this.requestJson<QbittorrentTorrentInfo[]>(
      `/api/v2/torrents/info?tag=${encodeURIComponent(tag)}`
    );
  }

  async getTorrent(hash: string): Promise<QbittorrentTorrentInfo | undefined> {
    const torrents = await this.requestJson<QbittorrentTorrentInfo[]>(
      `/api/v2/torrents/info?hashes=${encodeURIComponent(hash)}`
    );
    return torrents[0];
  }

  async getFiles(hash: string): Promise<QbittorrentTorrentFile[]> {
    return this.requestJson<QbittorrentTorrentFile[]>(
      `/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`
    );
  }

  async setFilePriority(hash: string, fileIndexes: number[], priority: number): Promise<void> {
    const body = new URLSearchParams({
      hash,
      id: fileIndexes.join("|"),
      priority: String(priority)
    });

    await this.requestText("/api/v2/torrents/filePrio", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
  }

  /** 设置 qBittorrent 全局上传和下载速度限制，单位为 bytes/s，0 表示不限速。 */
  async setGlobalSpeedLimits(downloadLimitBytesPerSecond: number, uploadLimitBytesPerSecond: number): Promise<void> {
    await Promise.all([
      this.setTransferLimit("/api/v2/transfer/setDownloadLimit", downloadLimitBytesPerSecond),
      this.setTransferLimit("/api/v2/transfer/setUploadLimit", uploadLimitBytesPerSecond)
    ]);
  }

  /** 设置 qBittorrent 全局做种停止目标，-1 表示禁用对应目标。 */
  async setGlobalSeedingLimits(limits: QbittorrentSeedingLimits): Promise<void> {
    const body = new URLSearchParams({
      json: JSON.stringify({
        max_ratio_enabled: limits.ratioLimit >= 0,
        max_ratio: normalizeRatioLimit(limits.ratioLimit),
        max_seeding_time_enabled: limits.timeLimitMinutes >= 0,
        max_seeding_time: normalizeTimeLimitMinutes(limits.timeLimitMinutes),
        max_ratio_act: 0
      })
    });
    await this.requestText("/api/v2/app/setPreferences", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
  }

  async pause(hash: string): Promise<void> {
    await this.torrentAction("/api/v2/torrents/stop", hash, "/api/v2/torrents/pause");
  }

  async resume(hash: string): Promise<void> {
    await this.torrentAction("/api/v2/torrents/start", hash, "/api/v2/torrents/resume");
  }

  async remove(hash: string, deleteFiles: boolean): Promise<void> {
    const body = new URLSearchParams({
      hashes: hash,
      deleteFiles: deleteFiles ? "true" : "false"
    });

    await this.requestText("/api/v2/torrents/delete", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
  }

  /** 调用 qBittorrent 5 任务动作端点，并在 404 时回退到 qBittorrent 4 端点。 */
  private async torrentAction(path: string, hash: string, legacyPath?: string): Promise<void> {
    const body = new URLSearchParams({
      hashes: hash
    });
    const request: RequestInit = {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    };
    const response = await this.requestRaw(path, request);
    if (response.status === 404 && legacyPath) {
      await this.requestText(legacyPath, request);
      return;
    }
    if (!response.ok) {
      throw new Error(`qBittorrent request failed: ${response.status} ${response.statusText}`);
    }
    await response.text();
  }

  /** 调用 qBittorrent transfer API 设置单个全局速度限制。 */
  private async setTransferLimit(path: string, limitBytesPerSecond: number): Promise<void> {
    const body = new URLSearchParams({
      limit: String(normalizeTransferLimit(limitBytesPerSecond))
    });

    await this.requestText(path, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const text = await this.requestText(path, init);
    return JSON.parse(text) as T;
  }

  private async requestText(path: string, init?: RequestInit): Promise<string> {
    const response = await this.requestRaw(path, init);
    if (!response.ok) {
      throw new Error(`qBittorrent request failed: ${response.status} ${response.statusText}`);
    }

    return response.text();
  }

  /** 校验添加接口的文本结果，避免把 HTTP 200 的 `Fails.` 误判为成功。 */
  private async requestAddTorrent(init: RequestInit): Promise<void> {
    const result = (await this.requestText("/api/v2/torrents/add", init)).trim();
    if (result && !result.toLowerCase().startsWith("ok")) {
      throw new Error(`qBittorrent add torrent failed: ${result}`);
    }
  }

  /** 请求本地 qBittorrent Web API，并在超时后主动终止连接。 */
  private async requestRaw(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, this.options.baseUrl);
    const headers = new Headers(init?.headers);
    const controller = new AbortController();
    const requestTimeoutMs = normalizeRequestTimeoutMs(this.options.requestTimeoutMs);
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    if (this.cookie) {
      headers.set("Cookie", this.cookie);
    }

    try {
      return await fetch(url, {
        ...init,
        headers,
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`qBittorrent request timeout after ${requestTimeoutMs}ms: ${init?.method ?? "GET"} ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function qbStateToStatus(state: string) {
  return mapQbittorrentState(state);
}

function normalizeTransferLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function normalizeRatioLimit(value: number): number {
  return value >= 0 && Number.isFinite(value) ? Math.max(0, value) : -1;
}

function normalizeTimeLimitMinutes(value: number): number {
  return value >= 0 && Number.isFinite(value) ? Math.max(1, Math.round(value)) : -1;
}

function normalizeRequestTimeoutMs(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_QBITTORRENT_REQUEST_TIMEOUT_MS;
  }

  return Math.max(1_000, Math.min(60_000, Math.round(value)));
}
