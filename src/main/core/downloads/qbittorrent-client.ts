import { mapQbittorrentState } from "../torrent-state";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface QbittorrentClientOptions {
  baseUrl: string;
  username: string;
  password?: string;
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
}

export interface QbittorrentTorrentFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
  is_seed?: boolean;
}

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

  async addUrl(url: string, savePath: string, paused = false): Promise<void> {
    const body = new URLSearchParams({
      urls: url,
      savepath: savePath,
      paused: paused ? "true" : "false"
    });

    await this.requestText("/api/v2/torrents/add", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
  }

  async addTorrentFile(filePath: string, savePath: string, paused = false): Promise<void> {
    const buffer = await readFile(filePath);
    const formData = new FormData();
    formData.append("torrents", new Blob([buffer]), basename(filePath));
    formData.append("savepath", savePath);
    formData.append("paused", paused ? "true" : "false");

    await this.requestText("/api/v2/torrents/add", {
      method: "POST",
      body: formData
    });
  }

  async listTorrents(): Promise<QbittorrentTorrentInfo[]> {
    return this.requestJson<QbittorrentTorrentInfo[]>("/api/v2/torrents/info");
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

  async pause(hash: string): Promise<void> {
    await this.torrentAction("/api/v2/torrents/pause", hash);
  }

  async resume(hash: string): Promise<void> {
    await this.torrentAction("/api/v2/torrents/resume", hash);
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

  private async torrentAction(path: string, hash: string): Promise<void> {
    const body = new URLSearchParams({
      hashes: hash
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

  private async requestRaw(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, this.options.baseUrl);
    const headers = new Headers(init?.headers);
    if (this.cookie) {
      headers.set("Cookie", this.cookie);
    }

    return fetch(url, {
      ...init,
      headers
    });
  }
}

export function qbStateToStatus(state: string) {
  return mapQbittorrentState(state);
}
