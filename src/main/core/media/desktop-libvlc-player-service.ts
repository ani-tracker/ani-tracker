import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PlayerAspectRatio,
  PlayerCapabilities,
  PlayerCommand,
  PlayerCommandResult,
  PlayerError,
  PlayerMediaSource,
  PlayerSnapshot,
  PlayerTrack
} from "@shared/player-contract";
import {
  createInitialPlayerSnapshot,
  createUnavailablePlayerCapabilities,
  rejectUnsupportedPlayerCommand
} from "@shared/player-contract";
import type { RemoteMediaAsset } from "../remote/remote-media-session-service";
import { logger } from "../logger";

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const PLAYER_COMMAND_TYPES = new Set<PlayerCommand["type"]>([
  "load",
  "play",
  "pause",
  "seek",
  "set-volume",
  "set-muted",
  "set-rate",
  "select-audio-track",
  "select-subtitle-track",
  "set-aspect-ratio",
  "set-fullscreen",
  "set-picture-in-picture",
  "previous-item",
  "next-item",
  "retry",
  "close"
]);
const PLAYER_EVENT_NAMES = [
  "playing",
  "paused",
  "stopped",
  "endReached",
  "timeChanged",
  "positionChanged",
  "lengthChanged",
  "buffering",
  "error",
  "audioTrackChanged",
  "subtitleTrackChanged"
] as const;

interface NativeTrackInfo {
  id: number;
  name: string;
}

interface NativePlayerEvent {
  time?: number;
  length?: number;
  position?: number;
  trackId?: number;
}

/** electron-vlc-player 中被桌面适配器使用的最小 API。 */
export interface DesktopNativeVlcPlayer {
  embed(): Promise<void>;
  destroy(): void | Promise<void>;
  on(event: string, listener: (payload?: NativePlayerEvent) => void): unknown;
  off(event: string, listener: (payload?: NativePlayerEvent) => void): unknown;
  setSource(source: string, options?: { autoplay?: boolean; mediaOptions?: string[] }): void;
  play(): void;
  pause(): void;
  setTime(milliseconds: number): void;
  getTime(): number;
  getLength(): number;
  setVolume(volume: number): void;
  getVolume(): number;
  setMute(muted: boolean): void;
  getMute(): boolean;
  setRate(rate: number): void;
  getRate(): number;
  getAudioTracks(): NativeTrackInfo[];
  getAudioTrack(): number;
  setAudioTrack(trackId: number): void;
  getSubtitleTracks(): NativeTrackInfo[];
  getSubtitleTrack(): number;
  setSubtitleTrack(trackId: number): void;
  addSubtitleFile(uri: string): boolean;
  setAspectRatio(ratio: string): void;
  setScale(scale: number): void;
}

interface DesktopNativeVlcPlayerOptions {
  window: unknown;
  container: string;
  vlcDir: string;
  controls: boolean;
  pageFullscreenButton: boolean;
  autoAdvancePlaylist: boolean;
  hardwareAcceleration: "any";
  locale: string;
}

export interface DesktopLibVlcModule {
  VlcPlayer: new (options: DesktopNativeVlcPlayerOptions) => DesktopNativeVlcPlayer;
}

interface ResolvedSubtitle {
  id: string;
  label: string;
  uri: string;
  default: boolean;
}

interface PlayerRecord {
  ownerId: number;
  player?: DesktopNativeVlcPlayer;
  capabilities: PlayerCapabilities;
  snapshot?: PlayerSnapshot;
  activeSessionId?: string;
  activeSource?: PlayerMediaSource;
  resolvedSource?: string;
  resolvedSubtitles: ResolvedSubtitle[];
  subtitleTrackIds: Map<string, number>;
  pendingStartPositionSeconds?: number;
  loadGeneration: number;
  sequence: number;
  disposed: boolean;
  listeners: Map<string, (payload?: NativePlayerEvent) => void>;
  runtimeError?: PlayerError;
}

export interface DesktopLibVlcPlayerServiceOptions {
  resolveAsset: (requestUrl: string) => Promise<RemoteMediaAsset>;
  publishSnapshot: (ownerId: number, snapshot: PlayerSnapshot) => void;
  setFullscreen: (ownerId: number, fullscreen: boolean) => boolean | Promise<boolean>;
  closeWindow: (ownerId: number) => boolean | Promise<boolean>;
  loadModule?: () => Promise<DesktopLibVlcModule>;
  resolveVlcDirectory?: () => string | undefined;
}

/** 将统一播放器契约映射到 Electron 主进程中的 libVLC 实例。 */
export class DesktopLibVlcPlayerService {
  private readonly records = new Map<number, PlayerRecord>();
  private modulePromise?: Promise<DesktopLibVlcModule>;

  constructor(private readonly options: DesktopLibVlcPlayerServiceOptions) {}

  /** 在视频宿主页加载完成后创建并嵌入原生播放表面。 */
  async attach(ownerId: number, hostWindow: unknown): Promise<void> {
    await this.dispose(ownerId);
    const record = createPlayerRecord(ownerId);
    this.records.set(ownerId, record);

    const vlcDirectory = this.options.resolveVlcDirectory?.() ?? resolveDesktopLibVlcDirectory();
    if (!vlcDirectory) {
      this.markRuntimeUnavailable(record, "未找到 libVLC 3.0.x 运行时");
      return;
    }

    try {
      const module = await this.loadModule();
      if (record.disposed || this.records.get(ownerId) !== record) return;
      const player = new module.VlcPlayer({
        window: hostWindow,
        container: "#vlc-host",
        vlcDir: vlcDirectory,
        controls: false,
        pageFullscreenButton: false,
        autoAdvancePlaylist: false,
        hardwareAcceleration: "any",
        locale: "zh-CN"
      });
      record.player = player;
      this.bindPlayerEvents(record, player);
      await player.embed();
      if (record.disposed || this.records.get(ownerId) !== record) {
        await Promise.resolve(player.destroy());
        return;
      }
      record.capabilities = createDesktopLibVlcCapabilities();
      logger.info("桌面 libVLC 播放表面已就绪", { ownerId });
    } catch (error) {
      this.markRuntimeUnavailable(record, toRuntimeErrorMessage(error));
      await this.destroyNativePlayer(record);
      logger.error("桌面 libVLC 初始化失败", {
        ownerId,
        errorType: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** 返回指定控制层窗口对应的原生播放器能力。 */
  getCapabilities(ownerId: number): PlayerCapabilities {
    return this.records.get(ownerId)?.capabilities
      ?? createUnavailablePlayerCapabilities("libvlc", "electron", "播放器窗口尚未注册");
  }

  /** 校验并执行来自 preload 的统一播放器命令。 */
  async dispatch(command: PlayerCommand, ownerId: number): Promise<PlayerCommandResult> {
    const record = this.records.get(ownerId);
    if (!record || record.disposed || !record.player || record.capabilities.availability !== "available") {
      return rejectCommand(command, record?.runtimeError ?? createRuntimeMissingError("libVLC 原生运行时尚未就绪"));
    }
    if (!isValidCommandEnvelope(command)) {
      return rejectCommand(command, createInvalidCommandError("播放器命令标识无效"));
    }
    if (command.type !== "load" && record.activeSessionId !== command.sessionId) {
      return rejectCommand(command, createInvalidCommandError("播放器会话已切换，请重试"));
    }

    try {
      switch (command.type) {
        case "load":
          return await this.loadSource(record, command);
        case "play":
          record.player.play();
          break;
        case "pause":
          record.player.pause();
          this.patchSnapshot(record, { status: "paused" });
          break;
        case "seek":
          if (!isFiniteRange(command.positionSeconds, 0, Number.MAX_SAFE_INTEGER)) {
            return rejectCommand(command, createInvalidCommandError("跳转时间无效"));
          }
          record.player.setTime(Math.round(command.positionSeconds * 1_000));
          this.patchSnapshot(record, { positionSeconds: command.positionSeconds });
          break;
        case "set-volume":
          if (!isFiniteRange(command.volume, 0, 1)) {
            return rejectCommand(command, createInvalidCommandError("音量参数无效"));
          }
          record.player.setVolume(Math.round(command.volume * 100));
          record.player.setMute(false);
          this.patchSnapshot(record, { volume: command.volume, muted: false });
          break;
        case "set-muted":
          if (typeof command.muted !== "boolean") {
            return rejectCommand(command, createInvalidCommandError("静音参数无效"));
          }
          record.player.setMute(command.muted);
          this.patchSnapshot(record, { muted: command.muted });
          break;
        case "set-rate":
          if (!PLAYBACK_RATES.includes(command.rate as (typeof PLAYBACK_RATES)[number])) {
            return rejectCommand(command, createInvalidCommandError("播放倍速无效"));
          }
          record.player.setRate(command.rate);
          this.patchSnapshot(record, { playbackRate: command.rate });
          break;
        case "select-audio-track":
          return this.selectTrack(record, command, "audio");
        case "select-subtitle-track":
          return this.selectTrack(record, command, "subtitle");
        case "set-aspect-ratio":
          return this.setAspectRatio(record, command);
        case "set-fullscreen": {
          if (typeof command.fullscreen !== "boolean") {
            return rejectCommand(command, createInvalidCommandError("全屏参数无效"));
          }
          const fullscreen = await this.options.setFullscreen(ownerId, command.fullscreen);
          this.patchSnapshot(record, { fullscreen });
          break;
        }
        case "set-picture-in-picture":
          return rejectUnsupportedPlayerCommand(command.commandId, "桌面 libVLC 暂不支持画中画");
        case "previous-item":
        case "next-item":
          return rejectUnsupportedPlayerCommand(command.commandId, "播放列表切换由页面会话管理");
        case "retry":
          if (!record.resolvedSource || !record.activeSource) {
            return rejectCommand(command, createInvalidCommandError("没有可重试的媒体资源"));
          }
          record.subtitleTrackIds.clear();
          record.player.setSource(record.resolvedSource, createSetSourceOptions(record.activeSource));
          this.patchSnapshot(record, { status: "loading", error: undefined });
          break;
        case "close":
          await this.options.closeWindow(ownerId);
          break;
      }
      return { commandId: command.commandId, accepted: true };
    } catch (error) {
      const playerError = toPlayerError(error);
      this.patchSnapshot(record, { status: "error", error: playerError });
      logger.error("桌面 libVLC 命令执行失败", {
        ownerId,
        commandType: command.type,
        sessionId: command.sessionId,
        errorType: error instanceof Error ? error.name : typeof error
      });
      return rejectCommand(command, playerError);
    }
  }

  /** 幂等释放指定窗口持有的原生播放器和事件监听器。 */
  async dispose(ownerId: number): Promise<void> {
    const record = this.records.get(ownerId);
    if (!record || record.disposed) return;
    record.disposed = true;
    record.loadGeneration += 1;
    this.records.delete(ownerId);
    await this.destroyNativePlayer(record);
    logger.info("桌面 libVLC 播放器已释放", { ownerId });
  }

  /** 解析资源后换源，真实本地路径只保留在主进程内。 */
  private async loadSource(
    record: PlayerRecord,
    command: Extract<PlayerCommand, { type: "load" }>
  ): Promise<PlayerCommandResult> {
    if (!isValidPlayerSource(command.source)) {
      return rejectCommand(command, createInvalidCommandError("媒体资源参数无效"));
    }
    const generation = ++record.loadGeneration;
    record.activeSessionId = command.sessionId;
    record.activeSource = command.source;
    record.resolvedSource = undefined;
    record.resolvedSubtitles = [];
    record.subtitleTrackIds.clear();
    record.pendingStartPositionSeconds = isFiniteRange(
      command.startPositionSeconds,
      0,
      Number.MAX_SAFE_INTEGER
    ) ? command.startPositionSeconds : undefined;
    record.sequence = 0;
    record.snapshot = createInitialPlayerSnapshot({
      sessionId: command.sessionId,
      capabilities: record.capabilities
    });
    this.patchSnapshot(record, {
      status: "loading",
      source: command.source,
      durationSeconds: command.source.durationSeconds ?? 0,
      error: undefined
    });

    try {
      const [mediaAsset, subtitleAssets] = await Promise.all([
        this.options.resolveAsset(command.source.uri),
        Promise.all(command.source.subtitles.map(async (subtitle) => {
          try {
            return { subtitle, asset: await this.options.resolveAsset(subtitle.uri) };
          } catch (error) {
            logger.warn("桌面 libVLC 字幕资源解析失败，继续播放视频", {
              ownerId: record.ownerId,
              sessionId: command.sessionId,
              subtitleId: subtitle.id,
              errorType: error instanceof Error ? error.name : typeof error
            });
            return undefined;
          }
        }))
      ]);
      if (record.disposed || generation !== record.loadGeneration || !record.player) {
        return rejectCommand(command, createInvalidCommandError("播放器会话已切换"));
      }
      record.resolvedSource = mediaAsset.filePath;
      record.resolvedSubtitles = subtitleAssets
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .map(({ subtitle, asset }) => ({
        id: subtitle.id,
        label: subtitle.label,
        uri: pathToFileURL(asset.filePath).toString(),
        default: subtitle.default
        }));
      record.player.setSource(mediaAsset.filePath, createSetSourceOptions(command.source));
      logger.info("桌面 libVLC 已加载受控媒体资源", {
        ownerId: record.ownerId,
        sessionId: command.sessionId,
        taskId: command.source.taskId,
        fileIndex: command.source.fileIndex,
        mode: command.source.mode,
        subtitleCount: record.resolvedSubtitles.length
      });
      return { commandId: command.commandId, accepted: true };
    } catch (error) {
      if (generation !== record.loadGeneration || record.disposed) {
        return rejectCommand(command, createInvalidCommandError("播放器会话已切换"));
      }
      const playerError = toPlayerError(error);
      this.patchSnapshot(record, { status: "error", error: playerError });
      return rejectCommand(command, playerError);
    }
  }

  /** 将 native 事件归并为带递增序号的完整快照。 */
  private bindPlayerEvents(record: PlayerRecord, player: DesktopNativeVlcPlayer): void {
    const bind = (event: (typeof PLAYER_EVENT_NAMES)[number], listener: (payload?: NativePlayerEvent) => void) => {
      record.listeners.set(event, listener);
      player.on(event, listener);
    };
    bind("playing", () => {
      if (!this.canPublish(record)) return;
      this.installSubtitles(record);
      if (record.pendingStartPositionSeconds !== undefined) {
        player.setTime(Math.round(record.pendingStartPositionSeconds * 1_000));
        record.pendingStartPositionSeconds = undefined;
      }
      this.patchSnapshot(record, {
        status: "playing",
        durationSeconds: toSeconds(safeRead(() => player.getLength(), 0)),
        positionSeconds: toSeconds(safeRead(() => player.getTime(), 0)),
        volume: clamp(safeRead(() => player.getVolume(), 100) / 100, 0, 1),
        muted: safeRead(() => player.getMute(), false),
        playbackRate: safeRead(() => player.getRate(), 1),
        audioTracks: safeReadTracks(player, "audio"),
        subtitleTracks: safeReadTracks(player, "subtitle")
      });
    });
    bind("paused", () => this.patchSnapshot(record, { status: "paused" }));
    bind("stopped", () => this.patchSnapshot(record, { status: "paused" }));
    bind("endReached", () => this.patchSnapshot(record, {
      status: "ended",
      positionSeconds: record.snapshot?.durationSeconds ?? record.snapshot?.positionSeconds ?? 0
    }));
    bind("timeChanged", (event) => this.patchSnapshot(record, {
      positionSeconds: toSeconds(event?.time ?? safeRead(() => player.getTime(), 0))
    }));
    bind("positionChanged", (event) => {
      if (event?.position === undefined || !record.snapshot) return;
      this.patchSnapshot(record, {
        positionSeconds: clamp(event.position, 0, 1) * record.snapshot.durationSeconds
      });
    });
    bind("lengthChanged", (event) => this.patchSnapshot(record, {
      durationSeconds: toSeconds(event?.length ?? safeRead(() => player.getLength(), 0))
    }));
    bind("buffering", () => this.patchSnapshot(record, { status: "buffering" }));
    bind("error", () => this.patchSnapshot(record, {
      status: "error",
      error: {
        code: "decoder",
        message: "libVLC 无法解码或读取当前媒体",
        recoverable: true,
        recoveryActions: ["retry", "transcode", "close"]
      }
    }));
    bind("audioTrackChanged", () => this.patchSnapshot(record, {
      audioTracks: safeReadTracks(player, "audio")
    }));
    bind("subtitleTrackChanged", () => this.patchSnapshot(record, {
      subtitleTracks: safeReadTracks(player, "subtitle")
    }));
  }

  /** 首次开始播放时安装外挂字幕，并记录来源 ID 到 VLC 轨道 ID 的映射。 */
  private installSubtitles(record: PlayerRecord): void {
    const player = record.player;
    if (!player || record.resolvedSubtitles.length === 0 || record.subtitleTrackIds.size > 0) return;
    const existingIds = new Set(safeRead(() => player.getSubtitleTracks(), []).map((track) => track.id));
    for (const subtitle of record.resolvedSubtitles) {
      if (!safeRead(() => player.addSubtitleFile(subtitle.uri), false)) continue;
      const addedTrack = safeRead(() => player.getSubtitleTracks(), [])
        .find((track) => !existingIds.has(track.id) && ![...record.subtitleTrackIds.values()].includes(track.id));
      if (addedTrack) record.subtitleTrackIds.set(subtitle.id, addedTrack.id);
    }
    const defaultSubtitle = record.resolvedSubtitles.find((subtitle) => subtitle.default);
    const defaultTrackId = defaultSubtitle ? record.subtitleTrackIds.get(defaultSubtitle.id) : undefined;
    if (defaultTrackId !== undefined) safeRead(() => player.setSubtitleTrack(defaultTrackId), undefined);
  }

  /** 切换音频或字幕轨道，允许用 VLC 数字 ID 或来源字幕 ID。 */
  private selectTrack(
    record: PlayerRecord,
    command: Extract<PlayerCommand, { type: "select-audio-track" | "select-subtitle-track" }>,
    kind: "audio" | "subtitle"
  ): PlayerCommandResult {
    const player = record.player!;
    const trackIdValue = command.trackId;
    if (kind === "subtitle" && trackIdValue === undefined) {
      player.setSubtitleTrack(-1);
    } else {
      const mappedTrackId = kind === "subtitle" && trackIdValue
        ? record.subtitleTrackIds.get(trackIdValue)
        : undefined;
      const trackId = mappedTrackId ?? Number(trackIdValue);
      if (!Number.isSafeInteger(trackId)) {
        return rejectCommand(command, createInvalidCommandError("轨道标识无效"));
      }
      if (kind === "audio") player.setAudioTrack(trackId);
      else player.setSubtitleTrack(trackId);
    }
    this.patchSnapshot(record, kind === "audio"
      ? { audioTracks: safeReadTracks(player, "audio") }
      : { subtitleTracks: safeReadTracks(player, "subtitle") });
    return { commandId: command.commandId, accepted: true };
  }

  /** 将统一画面比例映射到 libVLC 的比例与缩放 API。 */
  private setAspectRatio(
    record: PlayerRecord,
    command: Extract<PlayerCommand, { type: "set-aspect-ratio" }>
  ): PlayerCommandResult {
    const ratios: Record<PlayerAspectRatio, string> = {
      default: "",
      "16:9": "16:9",
      "4:3": "4:3",
      fill: "",
      fit: "",
      custom: command.value?.trim() ?? ""
    };
    if (!Object.hasOwn(ratios, command.aspectRatio) || (command.aspectRatio === "custom" && !ratios.custom)) {
      return rejectCommand(command, createInvalidCommandError("画面比例无效"));
    }
    record.player!.setScale(command.aspectRatio === "fill" ? 1 : 0);
    record.player!.setAspectRatio(ratios[command.aspectRatio]);
    this.patchSnapshot(record, { aspectRatio: command.aspectRatio });
    return { commandId: command.commandId, accepted: true };
  }

  /** 合并并发布快照；没有活动媒体会话时忽略迟到事件。 */
  private patchSnapshot(record: PlayerRecord, patch: Partial<PlayerSnapshot>): void {
    if (!this.canPublish(record) || !record.snapshot) return;
    record.sequence += 1;
    record.snapshot = {
      ...record.snapshot,
      ...patch,
      sessionId: record.snapshot.sessionId,
      sequence: record.sequence
    };
    this.options.publishSnapshot(record.ownerId, record.snapshot);
  }

  private canPublish(record: PlayerRecord): boolean {
    return !record.disposed && this.records.get(record.ownerId) === record;
  }

  private markRuntimeUnavailable(record: PlayerRecord, message: string): void {
    record.runtimeError = createRuntimeMissingError(message);
    record.capabilities = createUnavailablePlayerCapabilities("libvlc", "electron", message);
  }

  private async destroyNativePlayer(record: PlayerRecord): Promise<void> {
    const player = record.player;
    record.player = undefined;
    if (!player) return;
    for (const [event, listener] of record.listeners) player.off(event, listener);
    record.listeners.clear();
    await Promise.resolve(player.destroy()).catch((error: unknown) => {
      logger.warn("桌面 libVLC 原生实例释放失败", {
        ownerId: record.ownerId,
        errorType: error instanceof Error ? error.name : typeof error
      });
    });
  }

  private loadModule(): Promise<DesktopLibVlcModule> {
    this.modulePromise ??= this.options.loadModule?.() ?? import("electron-vlc-player")
      .then((module) => ({
        VlcPlayer: module.VlcPlayer as unknown as DesktopLibVlcModule["VlcPlayer"]
      }));
    return this.modulePromise;
  }
}

/** 按环境变量、应用资源和系统安装目录查找 libVLC 根目录。 */
export function resolveDesktopLibVlcDirectory(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  resourcesPath?: string;
  appPath?: string;
  environmentPath?: string;
  pathExists?: (path: string) => boolean;
} = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pathExists = options.pathExists ?? existsSync;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const appPath = options.appPath ?? process.cwd();
  const environmentPath = options.environmentPath ?? process.env.ANI_LIBVLC_DIR;
  const candidates = [
    environmentPath,
    join(resourcesPath, "libvlc", `${platform}-${arch}`),
    join(appPath, "resources", "libvlc", `${platform}-${arch}`),
    ...getSystemVlcCandidates(platform)
  ].filter((value): value is string => Boolean(value?.trim()));
  return candidates.find((candidate) => pathExists(candidate));
}

/** 返回桌面 libVLC 后端稳定公开的能力。 */
export function createDesktopLibVlcCapabilities(): PlayerCapabilities {
  return {
    backend: "libvlc",
    platform: "electron",
    availability: "available",
    canSeek: true,
    canSetVolume: true,
    canMute: true,
    playbackRates: [...PLAYBACK_RATES],
    supportsAudioTracks: true,
    supportsSubtitleTracks: true,
    supportsAspectRatio: true,
    supportsFullscreen: true,
    supportsPictureInPicture: false,
    supportsPlaylistNavigation: false,
    supportsDirectPlayback: true,
    supportsTranscodingFallback: true,
    supportsHdr: true
  };
}

function createPlayerRecord(ownerId: number): PlayerRecord {
  return {
    ownerId,
    capabilities: createUnavailablePlayerCapabilities("libvlc", "electron", "libVLC 正在初始化"),
    resolvedSubtitles: [],
    subtitleTrackIds: new Map(),
    loadGeneration: 0,
    sequence: 0,
    disposed: false,
    listeners: new Map()
  };
}

function getSystemVlcCandidates(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return [
      process.env.ProgramFiles ? join(process.env.ProgramFiles, "VideoLAN", "VLC") : "",
      process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "VideoLAN", "VLC") : ""
    ];
  }
  if (platform === "darwin") return ["/Applications/VLC.app/Contents/MacOS"];
  return ["/usr/lib/x86_64-linux-gnu", "/usr/lib64", "/usr/lib/aarch64-linux-gnu"];
}

function createSetSourceOptions(source: PlayerMediaSource) {
  return {
    autoplay: true,
    ...(source.mode === "hls" ? { mediaOptions: [":network-caching=1000"] } : {})
  };
}

function readTracks(tracks: NativeTrackInfo[], selectedId: number, kind: "audio" | "subtitle"): PlayerTrack[] {
  return tracks.map((track) => ({
    id: String(track.id),
    kind,
    label: track.name || `${kind === "audio" ? "音轨" : "字幕"} ${track.id}`,
    selected: track.id === selectedId
  }));
}

function safeReadTracks(player: DesktopNativeVlcPlayer, kind: "audio" | "subtitle"): PlayerTrack[] {
  return safeRead(() => kind === "audio"
    ? readTracks(player.getAudioTracks(), player.getAudioTrack(), kind)
    : readTracks(player.getSubtitleTracks(), player.getSubtitleTrack(), kind), []);
}

function isValidCommandEnvelope(command: PlayerCommand | undefined): command is PlayerCommand {
  return Boolean(
    command
    && /^[A-Za-z0-9._:-]{1,160}$/.test(command.commandId)
    && /^[A-Za-z0-9_-]{1,160}$/.test(command.sessionId)
    && typeof command.type === "string"
    && PLAYER_COMMAND_TYPES.has(command.type)
  );
}

function isValidPlayerSource(source: PlayerMediaSource | undefined): source is PlayerMediaSource {
  return Boolean(
    source
    && typeof source.taskId === "string"
    && /^[a-zA-Z0-9._:-]{1,160}$/.test(source.taskId)
    && typeof source.title === "string"
    && Boolean(source.title.trim())
    && typeof source.uri === "string"
    && source.uri.startsWith("ani-media://session/")
    && (source.mode === "direct" || source.mode === "hls")
    && Array.isArray(source.subtitles)
    && source.subtitles.every((subtitle) => Boolean(
      subtitle
      && typeof subtitle.id === "string"
      && typeof subtitle.label === "string"
      && typeof subtitle.uri === "string"
      && subtitle.uri.startsWith("ani-media://session/")
    ))
  );
}

function isFiniteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function safeRead<T>(reader: () => T, fallback: T): T {
  try {
    return reader();
  } catch {
    return fallback;
  }
}

function toSeconds(milliseconds: number): number {
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 1_000 : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rejectCommand(command: PlayerCommand | undefined, error: PlayerError): PlayerCommandResult {
  return {
    commandId: typeof command?.commandId === "string" ? command.commandId : "invalid-command",
    accepted: false,
    error
  };
}

function createRuntimeMissingError(message: string): PlayerError {
  return {
    code: "runtime-missing",
    message,
    recoverable: false,
    recoveryActions: ["close"]
  };
}

function createInvalidCommandError(message: string): PlayerError {
  return {
    code: "unknown",
    message,
    recoverable: false,
    recoveryActions: []
  };
}

function toPlayerError(error: unknown): PlayerError {
  return {
    code: "resource-unavailable",
    message: error instanceof Error ? error.message : "媒体资源不可用",
    recoverable: true,
    recoveryActions: ["retry", "transcode", "close"]
  };
}

function toRuntimeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/vlc_binding\.node|module could not be found|cannot find module/i.test(message)) {
    return "libVLC 原生绑定未编译或未随应用安装";
  }
  if (/libvlc|vlcDir|plugins/i.test(message)) {
    return "libVLC 运行库不完整或版本不兼容";
  }
  return "libVLC 原生运行时初始化失败";
}
