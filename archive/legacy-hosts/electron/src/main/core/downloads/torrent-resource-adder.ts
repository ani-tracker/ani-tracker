import type { AddTorrentOptions, TorrentEngine } from "@shared/contracts";
import type { DownloadTask } from "@shared/domain";
import {
  downloadTorrentToTempFile,
  isHttpTorrentUrl,
  safeHost,
  type TorrentHttpClient
} from "./torrent-file-downloader";
import { logger } from "../logger";

interface AddTorrentAddressInput {
  engine: TorrentEngine;
  url: string;
  options: AddTorrentOptions;
  torrentHttpClient?: TorrentHttpClient;
  context?: Record<string, unknown>;
}

interface AddReleaseTorrentInput {
  engine: TorrentEngine;
  magnetUrl?: string;
  torrentUrl?: string;
  options: AddTorrentOptions;
  torrentHttpClient?: TorrentHttpClient;
  context?: Record<string, unknown>;
}

/** 按资源地址类型添加下载；torrent URL 会先落盘再上传到下载引擎。 */
export async function addTorrentAddressToEngine(input: AddTorrentAddressInput): Promise<DownloadTask> {
  const url = input.url.trim();
  if (!url) {
    throw new Error("请输入 magnet 或 torrent 地址");
  }

  if (!isHttpTorrentUrl(url)) {
    logger.info("Torrent address add using direct URL", {
      inputType: url.startsWith("magnet:") ? "magnet" : "url",
      savePath: input.options.savePath,
      ...input.context
    });
    return input.engine.addMagnet(url, input.options);
  }

  return addDownloadedTorrentFileToEngine({
    engine: input.engine,
    torrentUrl: url,
    options: input.options,
    torrentHttpClient: input.torrentHttpClient,
    context: input.context
  });
}

/** 按 release 优先级添加下载；magnet 直传，只有 torrent URL 执行先下载再上传。 */
export async function addReleaseTorrentToEngine(input: AddReleaseTorrentInput): Promise<DownloadTask> {
  const magnetUrl = input.magnetUrl?.trim();
  if (magnetUrl) {
    return addTorrentAddressToEngine({
      engine: input.engine,
      url: magnetUrl,
      options: input.options,
      torrentHttpClient: input.torrentHttpClient,
      context: input.context
    });
  }

  const torrentUrl = input.torrentUrl?.trim();
  if (!torrentUrl) {
    throw new Error("资源没有 magnet 或 torrent 地址，无法添加下载");
  }

  return addTorrentAddressToEngine({
    engine: input.engine,
    url: torrentUrl,
    options: input.options,
    torrentHttpClient: input.torrentHttpClient,
    context: input.context
  });
}

/** 先下载远程 torrent 文件，再通过 addTorrentFile 推送给下载引擎。 */
async function addDownloadedTorrentFileToEngine(input: {
  engine: TorrentEngine;
  torrentUrl: string;
  options: AddTorrentOptions;
  torrentHttpClient?: TorrentHttpClient;
  context?: Record<string, unknown>;
}): Promise<DownloadTask> {
  logger.info("Torrent URL download before engine add started", {
    host: safeHost(input.torrentUrl),
    savePath: input.options.savePath,
    ...input.context
  });
  const torrentFile = await downloadTorrentToTempFile(input.torrentUrl, input.torrentHttpClient);
  try {
    const task = await input.engine.addTorrentFile(torrentFile.filePath, input.options);
    logger.info("Torrent file pushed to engine", {
      host: safeHost(input.torrentUrl),
      fileName: torrentFile.fileName,
      size: torrentFile.size,
      taskId: task.id,
      torrentHash: task.torrentHash,
      ...input.context
    });
    return task;
  } finally {
    try {
      await torrentFile.cleanup();
    } catch (error) {
      logger.warn("Torrent temp file cleanup failed", {
        fileName: torrentFile.fileName,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
