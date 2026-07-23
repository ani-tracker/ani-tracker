import type {
  AnimeDetailResult,
  AnimeWatchProgress,
  PlaybackCheckpoint,
  ReportPlaybackProgressInput,
  SavePlaybackCheckpointInput,
  SetAnimeWatchProgressInput
} from "@shared/contracts";
import type {
  Anime,
  DashboardData,
  DownloadTask,
  Episode,
  EpisodePreference,
  FansubGroup,
  MyAnime,
  NotificationRecord
} from "@shared/domain";
import {
  sanitizeAnimeDetailResult,
  sanitizeAnimeWatchProgress,
  sanitizeAnimeWatchProgressList,
  sanitizeAnimeList,
  sanitizeCount,
  sanitizeDashboard,
  sanitizeDownloadList,
  sanitizeEpisodeList,
  sanitizeEpisodePreferenceList,
  sanitizeFansubList,
  sanitizeMyAnimeList,
  sanitizeNotificationList,
  sanitizePlaybackCheckpoint
} from "./remote-dto";

export const REMOTE_RPC_METHOD_NAMES = [
  "getDashboard",
  "listNotifications",
  "getUnreadNotificationCount",
  "markNotificationRead",
  "markAllNotificationsRead",
  "listMyAnime",
  "listMyAnimeWatchProgress",
  "setAnimeWatchProgress",
  "reportPlaybackProgress",
  "savePlaybackCheckpoint",
  "listAnimeCatalog",
  "getAnimeDetail",
  "searchAnimeCatalog",
  "listFansubs",
  "listEpisodes",
  "listEpisodePreferences",
  "listDownloads",
  "refreshDownloads",
  "pauseDownload",
  "resumeDownload"
] as const;

export type RemoteRpcMethodName = (typeof REMOTE_RPC_METHOD_NAMES)[number];

export type RemoteRpcScope =
  | "dashboard.read"
  | "notifications.read"
  | "notifications.write"
  | "library.read"
  | "library.write"
  | "catalog.read"
  | "downloads.read"
  | "downloads.control";

export type RemoteRpcEffect = "read" | "write";
type MaybePromise<T> = T | Promise<T>;

/** 主线只可显式注入以下远程安全业务能力。 */
export interface RemoteRpcHandlers {
  getDashboard(): MaybePromise<DashboardData>;
  listNotifications(): MaybePromise<NotificationRecord[]>;
  getUnreadNotificationCount(): MaybePromise<number>;
  markNotificationRead(notificationId: string): MaybePromise<NotificationRecord[]>;
  markAllNotificationsRead(): MaybePromise<NotificationRecord[]>;
  listMyAnime(): MaybePromise<MyAnime[]>;
  listMyAnimeWatchProgress(): MaybePromise<AnimeWatchProgress[]>;
  setAnimeWatchProgress(input: SetAnimeWatchProgressInput): MaybePromise<AnimeWatchProgress>;
  reportPlaybackProgress(input: ReportPlaybackProgressInput): MaybePromise<boolean>;
  savePlaybackCheckpoint(input: SavePlaybackCheckpointInput): MaybePromise<PlaybackCheckpoint>;
  listAnimeCatalog(year?: number, month?: number): MaybePromise<Anime[]>;
  getAnimeDetail(animeId: string): MaybePromise<AnimeDetailResult>;
  searchAnimeCatalog(keyword: string): MaybePromise<Anime[]>;
  listFansubs(animeId?: string): MaybePromise<FansubGroup[]>;
  listEpisodes(animeId: string): MaybePromise<Episode[]>;
  listEpisodePreferences(animeId: string): MaybePromise<EpisodePreference[]>;
  listDownloads(): MaybePromise<DownloadTask[]>;
  refreshDownloads(): MaybePromise<DownloadTask[]>;
  pauseDownload(taskId: string): MaybePromise<DownloadTask[]>;
  resumeDownload(taskId: string): MaybePromise<DownloadTask[]>;
}

export interface RemoteRpcMethodDefinition {
  readonly name: RemoteRpcMethodName;
  readonly requiredScope: RemoteRpcScope;
  readonly effect: RemoteRpcEffect;
  readonly validateArgs: (args: readonly unknown[]) => unknown[];
  readonly sanitizeResult: (value: unknown) => unknown;
  readonly handler: (...args: unknown[]) => MaybePromise<unknown>;
}

export class RemoteRpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteRpcValidationError";
  }
}

/** 保存不可变的远程方法白名单，绝不读取或映射 ipcMain handler。 */
export class RemoteMethodRegistry {
  private readonly methods: ReadonlyMap<RemoteRpcMethodName, RemoteRpcMethodDefinition>;

  constructor(definitions: readonly RemoteRpcMethodDefinition[]) {
    const methods = new Map<RemoteRpcMethodName, RemoteRpcMethodDefinition>();
    for (const definition of definitions) {
      if (methods.has(definition.name)) {
        throw new Error(`远程方法重复注册：${definition.name}`);
      }
      methods.set(definition.name, Object.freeze(definition));
    }
    this.methods = methods;
  }

  /** 按固定方法名查询定义，未知名称不会回退到动态调用。 */
  get(method: string): RemoteRpcMethodDefinition | undefined {
    return this.methods.get(method as RemoteRpcMethodName);
  }

  /** 返回用于配对授权和审计展示的方法元数据。 */
  list(): ReadonlyArray<Pick<RemoteRpcMethodDefinition, "name" | "requiredScope" | "effect">> {
    return [...this.methods.values()].map(({ name, requiredScope, effect }) => ({ name, requiredScope, effect }));
  }
}

/** 使用显式依赖创建远程方法注册表。 */
export function createRemoteMethodRegistry(handlers: RemoteRpcHandlers): RemoteMethodRegistry {
  return new RemoteMethodRegistry([
    defineMethod("getDashboard", "dashboard.read", "read", noArgs, sanitizeDashboard, handlers.getDashboard),
    defineMethod(
      "listNotifications",
      "notifications.read",
      "read",
      noArgs,
      sanitizeNotificationList,
      handlers.listNotifications
    ),
    defineMethod(
      "getUnreadNotificationCount",
      "notifications.read",
      "read",
      noArgs,
      sanitizeCount,
      handlers.getUnreadNotificationCount
    ),
    defineMethod(
      "markNotificationRead",
      "notifications.write",
      "write",
      singleId,
      sanitizeNotificationList,
      handlers.markNotificationRead
    ),
    defineMethod(
      "markAllNotificationsRead",
      "notifications.write",
      "write",
      noArgs,
      sanitizeNotificationList,
      handlers.markAllNotificationsRead
    ),
    defineMethod("listMyAnime", "library.read", "read", noArgs, sanitizeMyAnimeList, handlers.listMyAnime),
    defineMethod(
      "listMyAnimeWatchProgress",
      "library.read",
      "read",
      noArgs,
      sanitizeAnimeWatchProgressList,
      handlers.listMyAnimeWatchProgress
    ),
    defineMethod(
      "setAnimeWatchProgress",
      "library.write",
      "write",
      watchProgressInput,
      sanitizeAnimeWatchProgress,
      handlers.setAnimeWatchProgress
    ),
    defineMethod(
      "reportPlaybackProgress",
      "library.write",
      "write",
      playbackProgressInput,
      booleanResult,
      handlers.reportPlaybackProgress
    ),
    defineMethod(
      "savePlaybackCheckpoint",
      "library.write",
      "write",
      playbackCheckpointInput,
      sanitizePlaybackCheckpoint,
      handlers.savePlaybackCheckpoint
    ),
    defineMethod(
      "listAnimeCatalog",
      "catalog.read",
      "read",
      optionalYearMonth,
      sanitizeAnimeList,
      handlers.listAnimeCatalog
    ),
    defineMethod("getAnimeDetail", "catalog.read", "read", singleId, sanitizeAnimeDetailResult, handlers.getAnimeDetail),
    defineMethod(
      "searchAnimeCatalog",
      "catalog.read",
      "read",
      singleKeyword,
      sanitizeAnimeList,
      handlers.searchAnimeCatalog
    ),
    defineMethod("listFansubs", "library.read", "read", optionalId, sanitizeFansubList, handlers.listFansubs),
    defineMethod("listEpisodes", "library.read", "read", singleId, sanitizeEpisodeList, handlers.listEpisodes),
    defineMethod(
      "listEpisodePreferences",
      "library.read",
      "read",
      singleId,
      sanitizeEpisodePreferenceList,
      handlers.listEpisodePreferences
    ),
    defineMethod("listDownloads", "downloads.read", "read", noArgs, sanitizeDownloadList, handlers.listDownloads),
    defineMethod(
      "refreshDownloads",
      "downloads.control",
      "write",
      noArgs,
      sanitizeDownloadList,
      handlers.refreshDownloads
    ),
    defineMethod(
      "pauseDownload",
      "downloads.control",
      "write",
      singleId,
      sanitizeDownloadList,
      handlers.pauseDownload
    ),
    defineMethod(
      "resumeDownload",
      "downloads.control",
      "write",
      singleId,
      sanitizeDownloadList,
      handlers.resumeDownload
    )
  ]);
}

function defineMethod(
  name: RemoteRpcMethodName,
  requiredScope: RemoteRpcScope,
  effect: RemoteRpcEffect,
  validateArgs: (args: readonly unknown[]) => unknown[],
  sanitizeResult: (value: unknown) => unknown,
  handler: (...args: never[]) => MaybePromise<unknown>
): RemoteRpcMethodDefinition {
  return {
    name,
    requiredScope,
    effect,
    validateArgs,
    sanitizeResult,
    handler: handler as (...args: unknown[]) => MaybePromise<unknown>
  };
}

function noArgs(args: readonly unknown[]): [] {
  assertArgumentCount(args, 0);
  return [];
}

function singleId(args: readonly unknown[]): [string] {
  assertArgumentCount(args, 1);
  return [parseId(args[0], "标识")];
}

function optionalId(args: readonly unknown[]): [string?] {
  if (args.length === 0) {
    return [];
  }
  assertArgumentCount(args, 1);
  if (args[0] === undefined || args[0] === null) {
    return [];
  }
  return [parseId(args[0], "番剧标识")];
}

function singleKeyword(args: readonly unknown[]): [string] {
  assertArgumentCount(args, 1);
  if (typeof args[0] !== "string") {
    throw new RemoteRpcValidationError("搜索关键词必须是字符串");
  }
  const keyword = args[0].trim();
  if (!keyword || keyword.length > 120 || hasControlCharacters(keyword)) {
    throw new RemoteRpcValidationError("搜索关键词长度必须为 1-120 个字符");
  }
  return [keyword];
}

/** 校验远程观看进度写入参数。 */
function watchProgressInput(args: readonly unknown[]): [SetAnimeWatchProgressInput] {
  assertArgumentCount(args, 1);
  const input = args[0];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RemoteRpcValidationError("观看进度参数格式无效");
  }
  const candidate = input as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.watchedEpisodeCount) ||
      (candidate.watchedEpisodeCount as number) < 0 ||
      (candidate.watchedEpisodeCount as number) > 10_000) {
    throw new RemoteRpcValidationError("观看进度必须是 0 到 10000 之间的整数");
  }
  return [{
    animeId: parseId(candidate.animeId, "番剧标识"),
    watchedEpisodeCount: candidate.watchedEpisodeCount as number
  }];
}

/** 校验远程播放器按任务上报的观看进度。 */
function playbackProgressInput(args: readonly unknown[]): [ReportPlaybackProgressInput] {
  assertArgumentCount(args, 1);
  const input = args[0];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RemoteRpcValidationError("播放进度参数格式无效");
  }
  const candidate = input as Record<string, unknown>;
  const allowedKeys = new Set(["taskId", "fileIndex", "percent"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    throw new RemoteRpcValidationError("播放进度参数包含未知字段");
  }
  if (typeof candidate.percent !== "number" || !Number.isFinite(candidate.percent) ||
      candidate.percent < 0 || candidate.percent > 100) {
    throw new RemoteRpcValidationError("播放进度必须是 0 到 100 之间的数值");
  }
  if (candidate.fileIndex !== undefined &&
      (!Number.isSafeInteger(candidate.fileIndex) || (candidate.fileIndex as number) < 0)) {
    throw new RemoteRpcValidationError("播放文件索引必须是非负整数");
  }
  return [{
    taskId: parseId(candidate.taskId, "下载任务标识"),
    ...(candidate.fileIndex === undefined ? {} : { fileIndex: candidate.fileIndex as number }),
    percent: candidate.percent
  }];
}

/** 校验远程播放器续播位置写入参数。 */
function playbackCheckpointInput(args: readonly unknown[]): [SavePlaybackCheckpointInput] {
  assertArgumentCount(args, 1);
  const input = args[0];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RemoteRpcValidationError("播放续播参数格式无效");
  }
  const candidate = input as Record<string, unknown>;
  const allowedKeys = new Set(["taskId", "fileIndex", "positionSeconds", "durationSeconds", "completed"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    throw new RemoteRpcValidationError("播放续播参数包含未知字段");
  }
  if (candidate.fileIndex !== undefined &&
      (!Number.isSafeInteger(candidate.fileIndex) || (candidate.fileIndex as number) < 0)) {
    throw new RemoteRpcValidationError("播放文件索引必须是非负整数");
  }
  for (const key of ["positionSeconds", "durationSeconds"] as const) {
    const value = candidate[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2_678_400) {
      throw new RemoteRpcValidationError("播放位置和时长必须是有效的非负秒数");
    }
  }
  if (candidate.completed !== undefined && typeof candidate.completed !== "boolean") {
    throw new RemoteRpcValidationError("播放完成状态必须是布尔值");
  }
  return [{
    taskId: parseId(candidate.taskId, "下载任务标识"),
    ...(candidate.fileIndex === undefined ? {} : { fileIndex: candidate.fileIndex as number }),
    positionSeconds: candidate.positionSeconds as number,
    durationSeconds: candidate.durationSeconds as number,
    completed: candidate.completed === true
  }];
}

/** 仅允许远程方法返回布尔处理结果。 */
function booleanResult(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new RemoteRpcValidationError("远程处理结果格式无效");
  }
  return value;
}

function optionalYearMonth(args: readonly unknown[]): [number?, number?] {
  if (args.length === 0) {
    return [];
  }
  assertArgumentCount(args, 2);
  const yearValue = args[0];
  const monthValue = args[1];
  if ((yearValue === undefined || yearValue === null) && (monthValue === undefined || monthValue === null)) {
    return [];
  }
  if (!Number.isInteger(yearValue) || (yearValue as number) < 1900 || (yearValue as number) > 2200) {
    throw new RemoteRpcValidationError("年份必须为 1900-2200 的整数");
  }
  if (!Number.isInteger(monthValue) || (monthValue as number) < 1 || (monthValue as number) > 12) {
    throw new RemoteRpcValidationError("月份必须为 1-12 的整数");
  }
  return [yearValue as number, monthValue as number];
}

function parseId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new RemoteRpcValidationError(`${label}必须是字符串`);
  }
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(normalized)) {
    throw new RemoteRpcValidationError(`${label}格式无效`);
  }
  return normalized;
}

function assertArgumentCount(args: readonly unknown[], expected: number): void {
  if (args.length !== expected) {
    throw new RemoteRpcValidationError(`参数数量无效，预期 ${expected} 个`);
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
