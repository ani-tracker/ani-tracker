import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RemotePlaybackMode, RemotePlaybackSession } from "@shared/contracts";
import type { AppSettings, DownloadTask, MediaFile } from "@shared/domain";
import ffmpegStaticPath from "ffmpeg-static";
import type { AppRepository } from "../repositories/app-repository";
import { logger as defaultLogger } from "../logger";

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_TRANSCODER_START_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_SESSIONS = 2;

export interface RemoteMediaAsset {
  filePath: string;
  contentType: string;
  direct: boolean;
}

export type RemoteMediaRepository = Pick<
  AppRepository,
  "getDownloadTask" | "listMediaFiles" | "getSettings"
>;

export interface RemoteMediaSessionLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface RemoteMediaSessionServiceOptions {
  clock?: () => number;
  randomBytes?: (size: number) => Buffer;
  spawnProcess?: typeof spawn;
  sessionTtlMs?: number;
  transcoderStartTimeoutMs?: number;
  maxSessions?: number;
  temporaryDirectory?: string;
  platform?: NodeJS.Platform;
  logger?: RemoteMediaSessionLogger;
  bundledFfmpegPath?: string | null;
}

interface ResolvedMedia {
  filePath: string;
  fileName: string;
  mode: RemotePlaybackMode;
  contentType: string;
  durationSeconds?: number;
}

interface MediaSessionRecord extends RemotePlaybackSession {
  deviceId: string;
  sourcePath: string;
  contentType: string;
  lastAccessedAt: number;
  temporaryDirectory?: string;
  process?: ChildProcessWithoutNullStreams;
  processError?: Error;
  expirationTimer?: NodeJS.Timeout;
}

export class RemoteMediaSessionError extends Error {
  /** 创建可映射到远程协议的媒体错误。 */
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RemoteMediaSessionError";
  }
}

export class RemoteMediaSessionService {
  private readonly clock: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly spawnProcess: typeof spawn;
  private readonly sessionTtlMs: number;
  private readonly transcoderStartTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly temporaryDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly logger: RemoteMediaSessionLogger;
  private readonly bundledFfmpegPath?: string;
  private readonly sessions = new Map<string, MediaSessionRecord>();

  /** 初始化受控媒体会话服务并注入可测试的平台依赖。 */
  constructor(
    private readonly repository: RemoteMediaRepository,
    options: RemoteMediaSessionServiceOptions = {}
  ) {
    this.clock = options.clock ?? Date.now;
    this.randomBytes = options.randomBytes ?? randomBytes;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
    this.transcoderStartTimeoutMs = positiveInteger(
      options.transcoderStartTimeoutMs,
      DEFAULT_TRANSCODER_START_TIMEOUT_MS
    );
    this.maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS);
    this.temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? defaultLogger;
    this.bundledFfmpegPath = options.bundledFfmpegPath === undefined
      ? ffmpegStaticPath ?? undefined
      : options.bundledFfmpegPath ?? undefined;
  }

  /** 为已配对设备创建短期播放会话，且不向远程端暴露真实路径。 */
  async createSession(taskId: string, deviceId: string): Promise<RemotePlaybackSession> {
    await this.cleanupExpiredSessions();
    const task = await this.repository.getDownloadTask(taskId);
    if (!task) {
      throw new RemoteMediaSessionError(404, "MEDIA_TASK_NOT_FOUND", "下载任务不存在");
    }

    const media = await this.resolveMedia(task);
    await this.closeMatchingSession(deviceId, taskId);
    await this.reserveSessionSlot();

    const now = this.clock();
    const id = this.createSessionId();
    const record: MediaSessionRecord = {
      id,
      taskId,
      fileName: media.fileName,
      mode: media.mode,
      streamUrl: media.mode === "direct"
        ? `/api/media/sessions/${id}/file`
        : `/api/media/sessions/${id}/hls/index.m3u8`,
      expiresAt: new Date(now + this.sessionTtlMs).toISOString(),
      durationSeconds: media.durationSeconds,
      deviceId,
      sourcePath: media.filePath,
      contentType: media.contentType,
      lastAccessedAt: now
    };
    this.sessions.set(id, record);
    this.refreshExpiration(record);

    try {
      if (record.mode === "hls") {
        await this.startHlsTranscode(record, await this.repository.getSettings());
      }
    } catch (error) {
      await this.closeSession(id, deviceId);
      if (error instanceof RemoteMediaSessionError) {
        throw error;
      }
      throw new RemoteMediaSessionError(503, "TRANSCODER_UNAVAILABLE", "实时转码启动失败");
    }

    this.logger.info("Remote media session created", {
      sessionId: id,
      taskId,
      deviceId,
      mode: record.mode
    });
    return toPublicSession(record);
  }

  /** 返回指定会话中的直传文件或 HLS 资源。 */
  async getAsset(sessionId: string, deviceId: string, assetName: string): Promise<RemoteMediaAsset> {
    const session = await this.requireSession(sessionId, deviceId);
    if (session.mode === "direct") {
      if (assetName !== "file") {
        throw new RemoteMediaSessionError(404, "MEDIA_ASSET_NOT_FOUND", "媒体资源不存在");
      }
      return {
        filePath: session.sourcePath,
        contentType: session.contentType,
        direct: true
      };
    }

    if (!/^(?:index\.m3u8|segment-\d{6}\.ts)$/.test(assetName) || !session.temporaryDirectory) {
      throw new RemoteMediaSessionError(404, "MEDIA_ASSET_NOT_FOUND", "媒体资源不存在");
    }
    const candidate = resolve(session.temporaryDirectory, assetName);
    if (!isPathInside(session.temporaryDirectory, candidate) || !existsSync(candidate)) {
      throw new RemoteMediaSessionError(404, "MEDIA_ASSET_NOT_READY", "媒体分片尚未生成");
    }
    try {
      return {
        filePath: await realpath(candidate),
        contentType: assetName.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
        direct: false
      };
    } catch {
      throw new RemoteMediaSessionError(404, "MEDIA_ASSET_NOT_READY", "媒体分片尚未生成");
    }
  }

  /** 关闭设备拥有的播放会话并清理转码进程和缓存。 */
  async closeSession(sessionId: string, deviceId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.deviceId !== deviceId) {
      return false;
    }
    this.sessions.delete(sessionId);
    if (session.expirationTimer) {
      clearTimeout(session.expirationTimer);
    }
    if (session.process && session.process.exitCode === null) {
      const closed = new Promise<void>((resolveClose) => session.process?.once("close", () => resolveClose()));
      session.process.kill("SIGKILL");
      await Promise.race([closed, delay(1_500)]);
    }
    if (session.temporaryDirectory) {
      try {
        await rm(session.temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn("Remote media cache cleanup failed", {
          sessionId,
          errorType: error instanceof Error ? error.name : typeof error
        });
      }
    }
    this.logger.info("Remote media session closed", {
      sessionId,
      taskId: session.taskId,
      deviceId
    });
    return true;
  }

  /** 停止全部播放会话，供网关关闭和应用退出时回收资源。 */
  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => this.closeSession(session.id, session.deviceId)));
  }

  /** 从已登记媒体或完整下载文件中解析可播放源。 */
  private async resolveMedia(task: DownloadTask): Promise<ResolvedMedia> {
    const settings = await this.repository.getSettings();
    const extensions = new Set(settings.media.videoExtensions.map(normalizeExtension));
    const mediaFiles = (await this.repository.listMediaFiles())
      .filter((media) => media.downloadTaskId === task.id)
      .sort((left, right) => right.size - left.size);

    const candidates: Array<{ filePath: string; fileName: string; media?: MediaFile }> = [
      ...mediaFiles.map((media) => ({ filePath: media.filePath, fileName: media.fileName, media })),
      ...task.files
        .filter((file) => file.selected && file.progress >= 1 && extensions.has(extname(file.name).toLowerCase()))
        .sort((left, right) => right.size - left.size)
        .map((file) => ({
          filePath: isAbsolute(file.name) ? file.name : join(task.savePath, file.name),
          fileName: basename(file.name)
        }))
    ];

    for (const candidate of candidates) {
      const source = await this.validateMediaPath(task.savePath, candidate.filePath);
      if (!source) {
        continue;
      }
      const extension = extname(source).toLowerCase();
      if (!extensions.has(extension)) {
        continue;
      }
      const mode = resolvePlaybackMode(extension, candidate.media?.normalizedVideoCodec ?? task.normalizedVideoCodec);
      return {
        filePath: source,
        fileName: candidate.fileName,
        mode,
        contentType: directContentType(extension),
        durationSeconds: candidate.media?.durationSeconds
      };
    }

    throw new RemoteMediaSessionError(409, "MEDIA_FILE_UNAVAILABLE", "已完成的媒体文件不存在或尚未写入完成");
  }

  /** 校验真实文件始终位于下载任务保存目录中。 */
  private async validateMediaPath(rootPath: string, candidatePath: string): Promise<string | undefined> {
    try {
      const [root, candidate] = await Promise.all([realpath(rootPath), realpath(candidatePath)]);
      if (!isPathInside(root, candidate)) {
        this.logger.warn("Remote media path rejected", { reason: "outside-download-directory" });
        return undefined;
      }
      const fileStats = await stat(candidate);
      return fileStats.isFile() ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  /** 启动 FFmpeg 并等待首个 HLS 播放列表生成。 */
  private async startHlsTranscode(session: MediaSessionRecord, settings: AppSettings): Promise<void> {
    const outputDirectory = await mkdtemp(join(this.temporaryDirectory, "ani-remote-media-"));
    session.temporaryDirectory = outputDirectory;
    const playlistPath = join(outputDirectory, "index.m3u8");
    const segmentPattern = join(outputDirectory, "segment-%06d.ts");
    const command = resolveFfmpegPath(settings.media.ffprobePath, this.platform, this.bundledFfmpegPath);
    const args = [
      "-nostdin",
      "-hide_banner",
      "-loglevel", "warning",
      "-i", session.sourcePath,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "160k",
      "-ac", "2",
      "-f", "hls",
      "-hls_time", "4",
      "-hls_list_size", "0",
      "-hls_playlist_type", "event",
      "-hls_segment_filename", segmentPattern,
      playlistPath
    ];
    const process = this.spawnProcess(command, args, { windowsHide: true });
    session.process = process;
    process.once("error", (error) => {
      session.processError = error;
    });
    process.once("close", (code) => {
      if (code !== 0 && !session.processError) {
        session.processError = new Error(`FFmpeg exited with code ${code ?? "unknown"}`);
      }
    });
    process.stderr.on("data", () => undefined);

    const startedAt = this.clock();
    while (!existsSync(playlistPath)) {
      if (session.processError) {
        this.logger.warn("Remote HLS transcoder failed", {
          sessionId: session.id,
          errorType: session.processError.name
        });
        throw new RemoteMediaSessionError(503, "TRANSCODER_UNAVAILABLE", "FFmpeg 不可用或无法转码此媒体");
      }
      if (this.clock() - startedAt >= this.transcoderStartTimeoutMs) {
        throw new RemoteMediaSessionError(504, "TRANSCODER_TIMEOUT", "实时转码启动超时");
      }
      await delay(100);
    }
  }

  /** 获取并刷新绑定设备的有效会话。 */
  private async requireSession(sessionId: string, deviceId: string): Promise<MediaSessionRecord> {
    const session = this.sessions.get(sessionId);
    if (!session || session.deviceId !== deviceId) {
      throw new RemoteMediaSessionError(404, "MEDIA_SESSION_NOT_FOUND", "播放会话不存在");
    }
    if (Date.parse(session.expiresAt) <= this.clock()) {
      await this.closeSession(session.id, session.deviceId);
      throw new RemoteMediaSessionError(410, "MEDIA_SESSION_EXPIRED", "播放会话已过期");
    }
    session.lastAccessedAt = this.clock();
    this.refreshExpiration(session);
    return session;
  }

  /** 重置会话空闲过期计时。 */
  private refreshExpiration(session: MediaSessionRecord): void {
    if (session.expirationTimer) {
      clearTimeout(session.expirationTimer);
    }
    const expiresAt = this.clock() + this.sessionTtlMs;
    session.expiresAt = new Date(expiresAt).toISOString();
    session.expirationTimer = setTimeout(() => {
      void this.closeSession(session.id, session.deviceId);
    }, this.sessionTtlMs);
    session.expirationTimer.unref();
  }

  /** 清理当前时间前已过期的会话。 */
  private async cleanupExpiredSessions(): Promise<void> {
    const expired = [...this.sessions.values()].filter((session) => Date.parse(session.expiresAt) <= this.clock());
    await Promise.all(expired.map((session) => this.closeSession(session.id, session.deviceId)));
  }

  /** 同一设备重复播放同一任务时替换旧会话。 */
  private async closeMatchingSession(deviceId: string, taskId: string): Promise<void> {
    const matched = [...this.sessions.values()].filter(
      (session) => session.deviceId === deviceId && session.taskId === taskId
    );
    await Promise.all(matched.map((session) => this.closeSession(session.id, session.deviceId)));
  }

  /** 达到并发上限时回收最久未访问的会话。 */
  private async reserveSessionSlot(): Promise<void> {
    if (this.sessions.size < this.maxSessions) {
      return;
    }
    const oldest = [...this.sessions.values()].sort((left, right) => left.lastAccessedAt - right.lastAccessedAt)[0];
    if (oldest) {
      await this.closeSession(oldest.id, oldest.deviceId);
    }
  }

  /** 生成不可预测且不承载业务信息的会话标识。 */
  private createSessionId(): string {
    let id: string;
    do {
      id = this.randomBytes(24).toString("base64url");
    } while (this.sessions.has(id));
    return id;
  }
}

/** 根据容器和探测编码决定直传或实时转码。 */
function resolvePlaybackMode(extension: string, codec: MediaFile["normalizedVideoCodec"] | undefined): RemotePlaybackMode {
  if (codec === "H.265/HEVC") {
    return "hls";
  }
  return extension === ".mp4" || extension === ".m4v" || extension === ".webm" ? "direct" : "hls";
}

/** 返回浏览器直传容器的 MIME 类型。 */
function directContentType(extension: string): string {
  if (extension === ".webm") {
    return "video/webm";
  }
  return extension === ".mp4" || extension === ".m4v" ? "video/mp4" : "application/octet-stream";
}

/** 从 ffprobe 配置推导同目录 FFmpeg，命令名配置则沿用 PATH。 */
function resolveFfmpegPath(
  ffprobePath: string,
  platform: NodeJS.Platform,
  bundledFfmpegPath?: string
): string {
  const normalized = ffprobePath.trim();
  if (normalized.includes("/") || normalized.includes("\\")) {
    const configuredPath = join(dirname(normalized), platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if (existsSync(configuredPath)) {
      return configuredPath;
    }
  }
  if (bundledFfmpegPath && existsSync(bundledFfmpegPath)) {
    return bundledFfmpegPath;
  }
  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/** 判断真实路径位于指定目录内部。 */
function isPathInside(rootDirectory: string, candidatePath: string): boolean {
  const relativePath = relative(rootDirectory, candidatePath);
  return relativePath === "" || (
    !isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)
  );
}

/** 规范媒体扩展名配置。 */
function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

/** 复制可公开的会话字段。 */
function toPublicSession(session: MediaSessionRecord): RemotePlaybackSession {
  return {
    id: session.id,
    taskId: session.taskId,
    fileName: session.fileName,
    mode: session.mode,
    streamUrl: session.streamUrl,
    expiresAt: session.expiresAt,
    durationSeconds: session.durationSeconds
  };
}

/** 将可选整数约束为正整数。 */
function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 非阻塞等待转码产物生成。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
