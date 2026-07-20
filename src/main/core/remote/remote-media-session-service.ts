import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  RemotePlaybackMode,
  RemotePlaybackRequestMode,
  RemotePlaybackSession
} from "@shared/contracts";
import type { AppSettings, DownloadTask, MediaFile } from "@shared/domain";
import * as ffprobeInstallerModule from "@ffprobe-installer/ffprobe";
import {
  probeMediaDuration,
  type FfprobeMediaProbeOptions
} from "../media/ffprobe-media-probe-service";
import {
  resolveBundledFfmpegBinary,
  resolveFfmpegCommand
} from "../media/ffmpeg-binary-resolver";
import type { AppRepository } from "../repositories/app-repository";
import { logger as defaultLogger } from "../logger";
import {
  prepareRemoteSubtitles,
  type RemoteSubtitlePreparationOptions,
  type RemoteSubtitlePreparationResult
} from "./remote-subtitle-service";

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_TRANSCODER_START_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_SESSIONS = 2;
const bundledFfprobeInstallerPath = resolveFfprobeInstallerPath(ffprobeInstallerModule);
const bundledFfmpegPath = resolveBundledFfmpegBinary();

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
  bundledFfprobePath?: string | null;
  durationProbe?: (filePath: string, options: FfprobeMediaProbeOptions) => Promise<number | undefined>;
  subtitlePreparer?: (
    sourcePath: string,
    outputDirectory: string,
    options: RemoteSubtitlePreparationOptions
  ) => Promise<RemoteSubtitlePreparationResult>;
}

interface ResolvedMedia {
  filePath: string;
  fileName: string;
  fileIndex?: number;
  mode: RemotePlaybackMode;
  contentType: string;
  durationSeconds?: number;
  settings: AppSettings;
}

interface MediaSessionRecord extends RemotePlaybackSession {
  access: "browser" | "external";
  externalAccessToken?: string;
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
  private readonly bundledFfmpegPath?: string | null;
  private readonly bundledFfprobePath?: string;
  private readonly durationProbe: NonNullable<RemoteMediaSessionServiceOptions["durationProbe"]>;
  private readonly subtitlePreparer: NonNullable<RemoteMediaSessionServiceOptions["subtitlePreparer"]>;
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
      ? bundledFfmpegPath
      : options.bundledFfmpegPath;
    this.bundledFfprobePath = options.bundledFfprobePath === undefined
      ? bundledFfprobeInstallerPath
      : options.bundledFfprobePath ?? undefined;
    this.durationProbe = options.durationProbe ?? probeMediaDuration;
    this.subtitlePreparer = options.subtitlePreparer ?? prepareRemoteSubtitles;
  }

  /** 为已配对设备创建短期播放会话，且不向远程端暴露真实路径。 */
  async createSession(
    taskId: string,
    deviceId: string,
    requestedMode: RemotePlaybackRequestMode,
    requestedFileIndex?: number
  ): Promise<RemotePlaybackSession> {
    return this.createSessionRecord(taskId, deviceId, requestedMode, requestedFileIndex, "browser");
  }

  /** 创建供远程设备本地播放器读取的临时无 Cookie 媒体会话。 */
  async createExternalSession(
    taskId: string,
    deviceId: string,
    requestedMode: RemotePlaybackRequestMode,
    requestedFileIndex?: number
  ): Promise<RemotePlaybackSession> {
    return this.createSessionRecord(taskId, deviceId, requestedMode, requestedFileIndex, "external");
  }

  /** 创建指定访问形态的媒体会话并统一初始化资源。 */
  private async createSessionRecord(
    taskId: string,
    deviceId: string,
    requestedMode: RemotePlaybackRequestMode,
    requestedFileIndex: number | undefined,
    access: MediaSessionRecord["access"]
  ): Promise<RemotePlaybackSession> {
    await this.cleanupExpiredSessions();
    const task = await this.repository.getDownloadTask(taskId);
    if (!task) {
      throw new RemoteMediaSessionError(404, "MEDIA_TASK_NOT_FOUND", "下载任务不存在");
    }

    const media = await this.resolveMedia(task, requestedMode, requestedFileIndex);
    await this.closeMatchingSession(deviceId, taskId, access);
    await this.reserveSessionSlot();

    const now = this.clock();
    const id = this.createSessionId();
    const externalAccessToken = access === "external" ? this.createExternalAccessToken() : undefined;
    const assetBaseUrl = externalAccessToken
      ? `/api/media/external/${externalAccessToken}/sessions/${id}`
      : `/api/media/sessions/${id}`;
    const record: MediaSessionRecord = {
      id,
      taskId,
      fileIndex: media.fileIndex,
      fileName: media.fileName,
      mode: media.mode,
      streamUrl: media.mode === "direct"
        ? `${assetBaseUrl}/file`
        : `${assetBaseUrl}/hls/index.m3u8`,
      expiresAt: new Date(now + this.sessionTtlMs).toISOString(),
      durationSeconds: media.durationSeconds,
      subtitles: [],
      access,
      externalAccessToken,
      deviceId,
      sourcePath: media.filePath,
      contentType: media.contentType,
      lastAccessedAt: now
    };
    this.sessions.set(id, record);
    this.refreshExpiration(record);

    if (record.mode === "hls") {
      try {
        record.temporaryDirectory = await mkdtemp(join(this.temporaryDirectory, "ani-remote-media-"));
        await this.prepareSessionSubtitles(record, media.settings);
        await this.startHlsTranscode(record, media.settings);
      } catch (error) {
        await this.closeSession(id, deviceId);
        if (error instanceof RemoteMediaSessionError) {
          throw error;
        }
        throw new RemoteMediaSessionError(503, "TRANSCODER_UNAVAILABLE", "实时转码启动失败");
      }
    } else {
      try {
        record.temporaryDirectory = await mkdtemp(join(this.temporaryDirectory, "ani-remote-media-"));
        await this.prepareSessionSubtitles(record, media.settings);
      } catch (error) {
        this.logger.warn("Remote subtitle cache initialization failed", {
          sessionId: record.id,
          errorType: error instanceof Error ? error.name : typeof error
        });
      }
    }

    this.logger.info("Remote media session created", {
      sessionId: id,
      taskId,
      deviceId,
      mode: record.mode,
      requestedMode,
      fileIndex: record.fileIndex,
      access
    });
    return toPublicSession(record);
  }

  /** 返回指定会话中的直传文件或 HLS 资源。 */
  async getAsset(sessionId: string, deviceId: string, assetName: string): Promise<RemoteMediaAsset> {
    const session = await this.requireSession(sessionId, deviceId);
    return this.resolveSessionAsset(session, assetName);
  }

  /** 使用会话专属高熵票据返回外部播放器媒体资源。 */
  async getExternalAsset(sessionId: string, accessToken: string, assetName: string): Promise<RemoteMediaAsset> {
    const session = this.sessions.get(sessionId);
    if (
      !session
      || session.access !== "external"
      || !secureTokenEquals(session.externalAccessToken, accessToken)
    ) {
      throw new RemoteMediaSessionError(404, "MEDIA_SESSION_NOT_FOUND", "播放会话不存在或已过期");
    }
    session.lastAccessedAt = this.clock();
    this.refreshExpiration(session);
    return this.resolveSessionAsset(session, assetName);
  }

  /** 解析已授权会话中的直传、字幕或 HLS 资源。 */
  private async resolveSessionAsset(session: MediaSessionRecord, assetName: string): Promise<RemoteMediaAsset> {
    const subtitle = session.subtitles.find((item) => item.url.endsWith(`/subtitles/${assetName}`));
    if (subtitle && /^subtitle-\d{3}\.(?:ass|vtt)$/.test(assetName) && session.temporaryDirectory) {
      const candidate = resolve(session.temporaryDirectory, assetName);
      if (!isPathInside(session.temporaryDirectory, candidate) || !existsSync(candidate)) {
        throw new RemoteMediaSessionError(404, "MEDIA_ASSET_NOT_FOUND", "字幕资源不存在");
      }
      return {
        filePath: await realpath(candidate),
        contentType: subtitle.type === "ass"
          ? "text/x-ssa; charset=utf-8"
          : "text/vtt; charset=utf-8",
        direct: false
      };
    }
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
  private async resolveMedia(
    task: DownloadTask,
    requestedMode: RemotePlaybackRequestMode,
    requestedFileIndex?: number
  ): Promise<ResolvedMedia> {
    if (requestedFileIndex !== undefined && (
      !Number.isSafeInteger(requestedFileIndex) || requestedFileIndex < 0
    )) {
      throw new RemoteMediaSessionError(400, "MEDIA_FILE_INVALID", "媒体文件标识无效");
    }
    const settings = await this.repository.getSettings();
    const extensions = new Set(settings.media.videoExtensions.map(normalizeExtension));
    const mediaFiles = (await this.repository.listMediaFiles())
      .filter((media) => media.downloadTaskId === task.id)
      .sort((left, right) => right.size - left.size);
    const completedTaskFiles = task.files
      .filter((file) => file.selected && file.progress >= 1 && extensions.has(extname(file.name).toLowerCase()))
      .sort((left, right) => right.size - left.size);
    const requestedTaskFile = requestedFileIndex === undefined
      ? undefined
      : completedTaskFiles.find((file) => file.index === requestedFileIndex);
    if (requestedFileIndex !== undefined && !requestedTaskFile) {
      throw new RemoteMediaSessionError(409, "MEDIA_FILE_UNAVAILABLE", "指定媒体文件不存在或尚未写入完成");
    }

    const candidates: Array<{
      filePath: string;
      fileName: string;
      fileIndex?: number;
      media?: MediaFile;
    }> = requestedTaskFile
      ? [{
          filePath: isAbsolute(requestedTaskFile.name)
            ? requestedTaskFile.name
            : join(task.savePath, requestedTaskFile.name),
          fileName: basename(requestedTaskFile.name),
          fileIndex: requestedTaskFile.index
        }]
      : [
          ...mediaFiles.map((media) => ({
            filePath: media.filePath,
            fileName: media.fileName,
            media
          })),
          ...completedTaskFiles.map((file) => ({
            filePath: isAbsolute(file.name) ? file.name : join(task.savePath, file.name),
            fileName: basename(file.name),
            fileIndex: file.index
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
      return {
        filePath: source,
        fileName: candidate.fileName,
        fileIndex: candidate.fileIndex,
        mode: requestedMode === "transcode" ? "hls" : "direct",
        contentType: directContentType(extension),
        durationSeconds: candidate.media?.durationSeconds
          ?? await this.resolveDuration(source, settings),
        settings
      };
    }

    throw new RemoteMediaSessionError(409, "MEDIA_FILE_UNAVAILABLE", "已完成的媒体文件不存在或尚未写入完成");
  }

  /** 在媒体扫描尚未提供时长时按需探测，失败不阻断播放。 */
  private async resolveDuration(filePath: string, settings: AppSettings): Promise<number | undefined> {
    const configuredPath = settings.media.ffprobePath.trim() || "ffprobe";
    try {
      const durationSeconds = await this.durationProbe(filePath, {
        ffprobePath: configuredPath,
        timeoutMs: settings.media.ffprobeTimeoutSeconds * 1_000
      });
      if (durationSeconds !== undefined) {
        this.logger.info("Remote media duration probed", { durationSeconds });
      }
      return durationSeconds;
    } catch (error) {
      if (this.bundledFfprobePath && this.bundledFfprobePath !== configuredPath) {
        try {
          const durationSeconds = await this.durationProbe(filePath, {
            ffprobePath: this.bundledFfprobePath,
            timeoutMs: settings.media.ffprobeTimeoutSeconds * 1_000
          });
          this.logger.info("Remote media duration probed with bundled FFprobe", { durationSeconds });
          return durationSeconds;
        } catch (fallbackError) {
          this.logger.warn("Bundled remote media duration probe failed", {
            errorType: fallbackError instanceof Error ? fallbackError.name : typeof fallbackError
          });
          return undefined;
        }
      }
      this.logger.warn("Remote media duration probe failed", {
        errorType: error instanceof Error ? error.name : typeof error
      });
      return undefined;
    }
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

  /** 提取会话可用文本字幕，失败时保留视频播放能力。 */
  private async prepareSessionSubtitles(session: MediaSessionRecord, settings: AppSettings): Promise<void> {
    if (!session.temporaryDirectory) {
      return;
    }
    const configuredFfprobePath = settings.media.ffprobePath.trim() || "ffprobe";
    try {
      const result = await this.subtitlePreparer(session.sourcePath, session.temporaryDirectory, {
        ffprobePaths: [configuredFfprobePath, this.bundledFfprobePath ?? ""],
        ffmpegPath: resolveFfmpegCommand({
          ffprobePath: configuredFfprobePath,
          platform: this.platform,
          bundledFfmpegPath: this.bundledFfmpegPath
        }),
        timeoutMs: settings.media.ffprobeTimeoutSeconds * 1_000
      });
      session.subtitles = result.subtitles.map((subtitle) => ({
        id: subtitle.id,
        label: subtitle.label,
        language: subtitle.language,
        type: subtitle.type,
        url: `${sessionAssetBaseUrl(session)}/subtitles/${subtitle.assetName}`,
        default: subtitle.default
      }));
      this.logger.info("Remote media subtitles prepared", {
        sessionId: session.id,
        detectedCount: result.detectedCount,
        supportedCount: session.subtitles.length,
        unsupportedCount: result.unsupportedCount,
        failedCount: result.failedCount
      });
    } catch (error) {
      this.logger.warn("Remote media subtitle preparation failed", {
        sessionId: session.id,
        errorType: error instanceof Error ? error.name : typeof error
      });
    }
  }

  /** 启动 FFmpeg 并等待首个 HLS 播放列表生成。 */
  private async startHlsTranscode(session: MediaSessionRecord, settings: AppSettings): Promise<void> {
    const outputDirectory = session.temporaryDirectory
      ?? await mkdtemp(join(this.temporaryDirectory, "ani-remote-media-"));
    session.temporaryDirectory = outputDirectory;
    const playlistPath = join(outputDirectory, "index.m3u8");
    const segmentPattern = join(outputDirectory, "segment-%06d.ts");
    const command = resolveFfmpegCommand({
      ffprobePath: settings.media.ffprobePath,
      platform: this.platform,
      bundledFfmpegPath: this.bundledFfmpegPath
    });
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

  /** 同一设备重复创建相同访问形态的任务时替换旧会话。 */
  private async closeMatchingSession(
    deviceId: string,
    taskId: string,
    access: MediaSessionRecord["access"]
  ): Promise<void> {
    const matched = [...this.sessions.values()].filter(
      (session) => session.deviceId === deviceId && session.taskId === taskId && session.access === access
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

  /** 生成仅存在于内存且可安全放入 URL 路径的外部播放票据。 */
  private createExternalAccessToken(): string {
    return this.randomBytes(32).toString("base64url");
  }
}

/** 返回浏览器直传容器的 MIME 类型。 */
function directContentType(extension: string): string {
  if (extension === ".webm") {
    return "video/webm";
  }
  if (extension === ".mp4" || extension === ".m4v") {
    return "video/mp4";
  }
  if (extension === ".mkv") {
    return "video/x-matroska";
  }
  if (extension === ".avi") {
    return "video/x-msvideo";
  }
  if (extension === ".mov") {
    return "video/quicktime";
  }
  return extension === ".mpg" || extension === ".mpeg" ? "video/mpeg" : "application/octet-stream";
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

/** 返回媒体会话面向当前访问形态的资源根地址。 */
function sessionAssetBaseUrl(session: MediaSessionRecord): string {
  return session.externalAccessToken
    ? `/api/media/external/${session.externalAccessToken}/sessions/${session.id}`
    : `/api/media/sessions/${session.id}`;
}

/** 使用恒定时间比较高熵媒体票据，避免泄露前缀匹配信息。 */
function secureTokenEquals(expected: string | undefined, actual: string): boolean {
  if (!expected) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

/** 复制可公开的会话字段。 */
function toPublicSession(session: MediaSessionRecord): RemotePlaybackSession {
  return {
    id: session.id,
    taskId: session.taskId,
    fileIndex: session.fileIndex,
    fileName: session.fileName,
    mode: session.mode,
    streamUrl: session.streamUrl,
    expiresAt: session.expiresAt,
    durationSeconds: session.durationSeconds,
    subtitles: session.subtitles.map((subtitle) => ({ ...subtitle }))
  };
}

/** 将可选整数约束为正整数。 */
function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 兼容 FFprobe 安装包在 CommonJS 与 ESM 中的导出形态。 */
function resolveFfprobeInstallerPath(moduleValue: unknown): string | undefined {
  const candidate = moduleValue as {
    path?: unknown;
    default?: { path?: unknown };
  };
  const value = candidate.path ?? candidate.default?.path;
  return typeof value === "string" ? value : undefined;
}

/** 非阻塞等待转码产物生成。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
