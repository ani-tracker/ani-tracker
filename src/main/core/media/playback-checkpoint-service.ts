import type {
  PlaybackCheckpoint,
  SavePlaybackCheckpointInput
} from "@shared/contracts";
import type { AppRepository } from "../repositories/app-repository";
import { logger } from "../logger";
import type { PlaybackStatusService } from "./playback-status-service";

const MAX_PLAYBACK_SECONDS = 31 * 24 * 60 * 60;
const MIN_RESUME_SECONDS = 5;
const END_RESUME_GUARD_SECONDS = 30;

type PlaybackCheckpointRepository = Pick<
  AppRepository,
  "getPlaybackCheckpoint" | "upsertPlaybackCheckpoint"
>;

/** 持久化续播位置，并在首次跨过 90% 时同步已看状态。 */
export class PlaybackCheckpointService {
  constructor(
    private readonly repository: PlaybackCheckpointRepository,
    private readonly playbackStatusService: Pick<PlaybackStatusService, "handleTaskProgress">,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** 校验并保存当前位置，已看标记对同一任务文件保持幂等。 */
  async save(input: SavePlaybackCheckpointInput): Promise<PlaybackCheckpoint> {
    const normalized = normalizePlaybackCheckpointInput(input);
    const existing = await this.repository.getPlaybackCheckpoint(normalized.taskId, normalized.fileIndex);
    const percent = calculatePlaybackPercent(normalized.positionSeconds, normalized.durationSeconds);
    let watchedReported = existing?.watchedReported ?? false;

    if (!watchedReported && percent >= 90) {
      watchedReported = await this.playbackStatusService.handleTaskProgress({
        taskId: normalized.taskId,
        fileIndex: normalized.fileIndex,
        percent
      });
    }

    const checkpoint: PlaybackCheckpoint = {
      ...normalized,
      completed: normalized.completed ?? false,
      watchedReported,
      updatedAt: this.clock().toISOString()
    };
    await this.repository.upsertPlaybackCheckpoint(checkpoint);
    if (
      !existing
      || existing.completed !== checkpoint.completed
      || existing.watchedReported !== checkpoint.watchedReported
    ) {
      logger.info("播放业务状态已持久化", {
        taskId: checkpoint.taskId,
        fileIndex: checkpoint.fileIndex,
        positionSeconds: Math.round(checkpoint.positionSeconds),
        durationSeconds: Math.round(checkpoint.durationSeconds),
        completed: checkpoint.completed,
        watchedReported: checkpoint.watchedReported
      });
    }
    return checkpoint;
  }
}

/** 将播放位置换算为受限百分比，未知时长返回 0。 */
export function calculatePlaybackPercent(positionSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(positionSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, positionSeconds / durationSeconds * 100));
}

/** 返回可安全恢复的位置，已播完或接近片尾时从头开始。 */
export function resolvePlaybackResumePosition(checkpoint: PlaybackCheckpoint | undefined): number | undefined {
  if (!checkpoint || checkpoint.completed || checkpoint.positionSeconds < MIN_RESUME_SECONDS) {
    return undefined;
  }
  if (
    checkpoint.durationSeconds > 0
    && checkpoint.durationSeconds - checkpoint.positionSeconds <= END_RESUME_GUARD_SECONDS
  ) {
    return undefined;
  }
  return checkpoint.positionSeconds;
}

/** 约束来自 IPC 或远程端的续播写入，防止异常数值污染数据库。 */
export function normalizePlaybackCheckpointInput(
  input: SavePlaybackCheckpointInput
): SavePlaybackCheckpointInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("播放续播参数格式无效");
  }
  const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(taskId)) {
    throw new Error("下载任务标识格式无效");
  }
  if (input.fileIndex !== undefined && (!Number.isSafeInteger(input.fileIndex) || input.fileIndex < 0)) {
    throw new Error("播放文件索引必须是非负整数");
  }
  if (!isPlaybackSeconds(input.positionSeconds) || !isPlaybackSeconds(input.durationSeconds)) {
    throw new Error("播放位置和时长必须是有效的非负秒数");
  }

  const durationSeconds = input.durationSeconds;
  const positionSeconds = durationSeconds > 0
    ? Math.min(input.positionSeconds, durationSeconds)
    : input.positionSeconds;
  return {
    taskId,
    ...(input.fileIndex === undefined ? {} : { fileIndex: input.fileIndex }),
    positionSeconds,
    durationSeconds,
    completed: input.completed === true
  };
}

/** 判断秒数是否处于播放器允许持久化的范围。 */
function isPlaybackSeconds(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PLAYBACK_SECONDS;
}
