import { randomUUID } from "node:crypto";
import type { AddTorrentOptions, TorrentEngine } from "@shared/contracts";
import type { DownloadTask } from "@shared/domain";
import { logger } from "../logger";

export interface TorrentAddRecoveryIdentity {
  infoHash?: string;
  name?: string;
}

/** 添加下载任务；若 qB 确认超时但任务已存在，则从引擎列表恢复真实任务。 */
export async function addMagnetWithRecovery(
  engine: TorrentEngine,
  url: string,
  options: AddTorrentOptions,
  identity: TorrentAddRecoveryIdentity = {}
): Promise<DownloadTask> {
  const correlationTag = options.correlationTag ?? createCorrelationTag();
  const addOptions = { ...options, correlationTag };

  try {
    return await engine.addMagnet(url, addOptions);
  } catch (error) {
    const recovered = await recoverAddedTask(engine, {
      correlationTag,
      infoHash: identity.infoHash ?? extractInfoHash(url),
      name: identity.name,
      savePath: options.savePath
    });
    if (recovered) {
      logger.warn("Download task recovered after engine add failure", {
        taskId: recovered.id,
        torrentHash: recovered.torrentHash,
        correlationTag,
        message: error instanceof Error ? error.message : String(error)
      });
      return recovered;
    }

    throw error;
  }
}

interface RecoverAddedTaskInput {
  correlationTag: string;
  infoHash?: string;
  name?: string;
  savePath: string;
}

/** 从引擎列表按标签、hash 或唯一名称找回已被 qB 接收的任务。 */
async function recoverAddedTask(
  engine: TorrentEngine,
  input: RecoverAddedTaskInput
): Promise<DownloadTask | undefined> {
  let tasks: DownloadTask[];
  try {
    tasks = await engine.listTasks();
  } catch (error) {
    logger.warn("Download add recovery list failed", {
      correlationTag: input.correlationTag,
      message: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }

  const tagMatch = findUniqueTask(tasks, (task) => task.correlationTag === input.correlationTag);
  if (tagMatch) {
    return tagMatch;
  }

  const normalizedHash = normalizeInfoHash(input.infoHash);
  if (normalizedHash) {
    const hashMatch = findUniqueTask(tasks, (task) =>
      normalizeInfoHash(task.torrentHash) === normalizedHash || normalizeInfoHash(task.id) === normalizedHash
    );
    if (hashMatch) {
      return hashMatch;
    }
  }

  if (input.name) {
    return findUniqueTask(tasks, (task) =>
      task.name === input.name && normalizePath(task.savePath) === normalizePath(input.savePath)
    );
  }

  return undefined;
}

/** 查找唯一任务，避免多个候选时误关联。 */
function findUniqueTask(tasks: DownloadTask[], predicate: (task: DownloadTask) => boolean): DownloadTask | undefined {
  const matches = tasks.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

/** 生成传给 qBittorrent 的单次添加关联标签。 */
function createCorrelationTag(): string {
  return `ani-tracker-${randomUUID()}`;
}

/** 从 magnet 链接解析 BTIH。 */
function extractInfoHash(value: string): string | undefined {
  if (!value.startsWith("magnet:")) {
    return undefined;
  }

  return value.match(/xt=urn:btih:([a-z0-9]+)/i)?.[1];
}

function normalizeInfoHash(value?: string): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}
