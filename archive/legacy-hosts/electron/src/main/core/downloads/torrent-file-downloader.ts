import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defaultMetadataHttpClient, type MetadataFetchOptions } from "../metadata/metadata-http-client";
import { logger } from "../logger";

const MAX_TORRENT_FILE_BYTES = 20 * 1024 * 1024;

export interface TorrentHttpClient {
  fetch(input: string | URL, options?: MetadataFetchOptions): Promise<Response>;
}

export interface DownloadedTorrentData {
  data: Uint8Array;
  fileName: string;
}

export interface DownloadedTorrentTempFile {
  filePath: string;
  fileName: string;
  size: number;
  cleanup(): Promise<void>;
}

/** 下载并校验远程 torrent 元数据，避免把站点错误页继续传给下载引擎。 */
export async function downloadTorrentData(
  url: string,
  httpClient: TorrentHttpClient = defaultMetadataHttpClient
): Promise<DownloadedTorrentData> {
  logger.info("Torrent file proxy download started", { host: safeHost(url) });
  const response = await httpClient.fetch(url, {
    source: "torrent-download",
    headers: {
      Accept: "application/x-bittorrent, application/octet-stream;q=0.9, */*;q=0.1"
    }
  });
  if (!response.ok) {
    throw new Error(`Torrent file download failed: ${response.status} ${response.statusText}`);
  }

  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_TORRENT_FILE_BYTES) {
    throw new Error(`Torrent file exceeds ${MAX_TORRENT_FILE_BYTES} bytes`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  validateTorrentData(data);
  const fileName = resolveTorrentFileName(url);
  logger.info("Torrent file proxy download completed", {
    host: safeHost(url),
    fileName,
    size: data.byteLength
  });
  return { data, fileName };
}

/** 下载远程 torrent 到临时文件，供 qBittorrent multipart 文件上传使用。 */
export async function downloadTorrentToTempFile(
  url: string,
  httpClient: TorrentHttpClient = defaultMetadataHttpClient
): Promise<DownloadedTorrentTempFile> {
  const torrent = await downloadTorrentData(url, httpClient);
  const tempDir = await mkdtemp(join(tmpdir(), "ani-torrent-"));
  const fileName = sanitizeTorrentFileName(torrent.fileName);
  const filePath = join(tempDir, fileName);
  await writeFile(filePath, torrent.data);
  logger.info("Torrent file saved to temp file", {
    host: safeHost(url),
    fileName,
    size: torrent.data.byteLength
  });

  return {
    filePath,
    fileName,
    size: torrent.data.byteLength,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true });
      logger.info("Torrent temp file removed", { fileName });
    }
  };
}

/** 判断地址是否需要先按远程 torrent 文件下载处理。 */
export function isHttpTorrentUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** 获取地址 host，用于日志中定位来源站点。 */
export function safeHost(value: string): string | undefined {
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

/** 校验响应大小和 bencode 字典特征，避免把错误页上传给 qBittorrent。 */
function validateTorrentData(data: Uint8Array): void {
  if (!data.byteLength) {
    throw new Error("Torrent file is empty");
  }
  if (data.byteLength > MAX_TORRENT_FILE_BYTES) {
    throw new Error(`Torrent file exceeds ${MAX_TORRENT_FILE_BYTES} bytes`);
  }
  if (data[0] !== 0x64 || data[data.byteLength - 1] !== 0x65 || !Buffer.from(data).includes(Buffer.from("4:info"))) {
    throw new Error("Torrent file response is not valid bencode metadata");
  }
}

/** 从下载地址推导安全的 torrent 文件名。 */
function resolveTorrentFileName(value: string): string {
  try {
    const pathName = new URL(value).pathname;
    const candidate = decodeURIComponent(pathName.split("/").at(-1) ?? "").trim();
    return candidate.toLowerCase().endsWith(".torrent") ? candidate : "download.torrent";
  } catch {
    return "download.torrent";
  }
}

/** 移除路径片段，避免临时文件名携带目录穿越。 */
function sanitizeTorrentFileName(value: string): string {
  const candidate = basename(value.replace(/[/\\]/g, "_")).trim();
  return candidate.toLowerCase().endsWith(".torrent") ? candidate : "download.torrent";
}
