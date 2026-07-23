import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { EmbeddedTorrentCoreStatus } from "@shared/contracts";
import type { AppSettings } from "@shared/domain";
import { logger } from "../logger";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;

type CoreMethod =
  | "status"
  | "configure"
  | "addMagnet"
  | "addTorrentFile"
  | "listTasks"
  | "getTask"
  | "getFiles"
  | "setFilePriority"
  | "pause"
  | "resume"
  | "remove"
  | "shutdown";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CoreResponse {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

interface CoreRuntimeStatus {
  version?: string;
  taskCount?: number;
  listenPort?: number;
}

export interface EmbeddedTorrentCoreClient {
  execute<T>(method: CoreMethod, params: Record<string, unknown>, settings: AppSettings): Promise<T>;
}

export interface TorrentCoreBinaryResolverOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  resourceRoots?: string[];
  binaryPathOverride?: string;
}

export interface EmbeddedTorrentCoreServiceOptions {
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  resolveBinary?: (options?: TorrentCoreBinaryResolverOptions) => string | undefined;
}

/** 托管内置 libtorrent sidecar，并提供带超时的 NDJSON 请求通道。 */
export class EmbeddedTorrentCoreService implements EmbeddedTorrentCoreClient {
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly resolveBinary: (options?: TorrentCoreBinaryResolverOptions) => string | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: ReadLineInterface | null = null;
  private startPromise: Promise<EmbeddedTorrentCoreStatus> | null = null;
  private lastSettings: AppSettings | null = null;
  private activeBinaryPath: string | undefined;
  private activeDataDir: string | undefined;
  private configurationKey: string | undefined;
  private runtimeStatus: CoreRuntimeStatus = {};
  private requestSequence = 0;
  private stopping = false;
  private lastStartedAt: string | undefined;
  private lastStoppedAt: string | undefined;
  private lastError: string | undefined;

  constructor(options: EmbeddedTorrentCoreServiceOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.resolveBinary = options.resolveBinary ?? resolveBundledTorrentCoreBinary;
  }

  /** 根据默认引擎开关启动或停止 sidecar，并同步运行参数。 */
  async applySettings(settings: AppSettings): Promise<EmbeddedTorrentCoreStatus> {
    this.lastSettings = settings;
    if (settings.download.defaultTorrentEngine === "embedded" && settings.download.embedded.enabled) {
      return this.start(settings);
    }

    if (this.child) {
      await this.stop();
    }
    return this.getStatus(settings);
  }

  /** 确保核心运行后执行一条类型化命令。 */
  async execute<T>(method: CoreMethod, params: Record<string, unknown>, settings: AppSettings): Promise<T> {
    await this.start(settings);
    return this.send<T>(method, params);
  }

  /** 启动核心、验证协议可用并应用最新配置。 */
  async start(settings: AppSettings): Promise<EmbeddedTorrentCoreStatus> {
    this.lastSettings = settings;
    if (this.child) {
      await this.configure(settings);
      return this.refreshStatus(settings);
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startCore(settings).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  /** 请求核心保存状态并退出，超时后终止进程。 */
  async stop(): Promise<EmbeddedTorrentCoreStatus> {
    const child = this.child;
    if (!child) {
      return this.getStatus();
    }

    this.stopping = true;
    logger.info("Stopping embedded torrent core", { pid: child.pid });
    try {
      await this.send("shutdown", {});
      child.stdin.end();
    } catch (error) {
      logger.warn("Embedded torrent core graceful shutdown failed", {
        message: getErrorMessage(error)
      });
    }

    const exited = await waitForExit(child, this.stopTimeoutMs);
    if (!exited && child.exitCode === null) {
      logger.warn("Embedded torrent core stop timeout; sending SIGTERM", { pid: child.pid });
      child.kill();
      const terminated = await waitForExit(child, 2_000);
      if (!terminated && child.exitCode === null) {
        logger.warn("Embedded torrent core ignored SIGTERM; sending SIGKILL", { pid: child.pid });
        child.kill("SIGKILL");
        await waitForExit(child, 2_000);
      }
    }

    if (this.child === child) {
      this.clearChild(child);
    }
    this.stopping = false;
    this.lastStoppedAt = new Date().toISOString();
    return this.getStatus();
  }

  /** 重启核心并重新加载持久化 session。 */
  async restart(settings: AppSettings): Promise<EmbeddedTorrentCoreStatus> {
    await this.stop();
    return this.start(settings);
  }

  /** 读取进程状态；运行中会同时刷新核心版本和任务数。 */
  async refreshStatus(settings = this.lastSettings): Promise<EmbeddedTorrentCoreStatus> {
    if (!this.child) {
      return this.getStatus(settings);
    }
    try {
      this.runtimeStatus = normalizeRuntimeStatus(await this.send("status", {}));
      return this.getStatus(settings);
    } catch (error) {
      this.lastError = getErrorMessage(error);
      return this.getStatus(settings);
    }
  }

  /** 返回不触发进程操作的最新状态快照。 */
  getStatus(settings = this.lastSettings): EmbeddedTorrentCoreStatus {
    const binaryPath = this.activeBinaryPath ?? this.resolveBinary({
      binaryPathOverride: process.env.ANI_TORRENT_CORE_PATH
    });
    const dataDir = this.activeDataDir ?? (settings ? resolveTorrentCoreDataDir(settings) : undefined);
    return {
      enabled: settings?.download.defaultTorrentEngine === "embedded" && settings.download.embedded.enabled,
      running: Boolean(this.child),
      platform: process.platform,
      arch: process.arch,
      binaryPath,
      dataDir,
      pid: this.child?.pid,
      version: this.runtimeStatus.version,
      taskCount: this.runtimeStatus.taskCount,
      listenPort: this.runtimeStatus.listenPort ?? settings?.download.embedded.listenPort,
      lastStartedAt: this.lastStartedAt,
      lastStoppedAt: this.lastStoppedAt,
      lastError: this.lastError ?? (binaryPath ? undefined : "未找到内置 libtorrent 核心二进制")
    };
  }

  /** 创建 sidecar 子进程并完成首次握手。 */
  private async startCore(settings: AppSettings): Promise<EmbeddedTorrentCoreStatus> {
    const binaryPath = this.resolveBinary({
      binaryPathOverride: process.env.ANI_TORRENT_CORE_PATH
    });
    if (!binaryPath) {
      this.lastError = "未找到内置 libtorrent 核心二进制";
      logger.error("Embedded torrent core binary missing", {
        platform: process.platform,
        arch: process.arch
      });
      throw new Error(this.lastError);
    }

    const dataDir = resolveTorrentCoreDataDir(settings);
    await mkdir(dataDir, { recursive: true });
    logger.info("Starting embedded torrent core", { binaryPath, dataDir });

    const child = spawn(binaryPath, ["--data-dir", dataDir], {
      cwd: dirname(binaryPath),
      env: buildTorrentCoreLaunchEnvironment(binaryPath),
      windowsHide: true
    });
    this.child = child;
    this.activeBinaryPath = binaryPath;
    this.activeDataDir = dataDir;
    this.configurationKey = undefined;
    this.stopping = false;
    this.attachChild(child);

    try {
      this.runtimeStatus = normalizeRuntimeStatus(await this.send("status", {}));
      await this.configure(settings);
      this.lastStartedAt = new Date().toISOString();
      this.lastStoppedAt = undefined;
      this.lastError = undefined;
      logger.info("Embedded torrent core ready", {
        pid: child.pid,
        version: this.runtimeStatus.version,
        taskCount: this.runtimeStatus.taskCount
      });
      return this.getStatus(settings);
    } catch (error) {
      this.lastError = getErrorMessage(error);
      if (child.exitCode === null) {
        child.kill();
      }
      if (this.child === child) {
        this.clearChild(child);
      }
      throw error;
    }
  }

  /** 绑定 stdout 响应、stderr 日志及异常退出清理。 */
  private attachChild(child: ChildProcessWithoutNullStreams): void {
    this.stdoutLines = createInterface({ input: child.stdout });
    this.stdoutLines.on("line", (line) => this.handleResponseLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        logger.warn("Embedded torrent core stderr", { message });
      }
    });
    child.once("error", (error) => {
      this.lastError = error.message;
      logger.error("Embedded torrent core process error", { message: error.message });
      this.rejectPending(new Error(`内置下载核心进程错误：${error.message}`));
    });
    child.once("exit", (code, signal) => {
      const expectedStop = this.stopping;
      if (!expectedStop && code !== 0) {
        this.lastError = `内置下载核心退出：code=${code ?? "null"} signal=${signal ?? "null"}`;
      }
      this.lastStoppedAt = new Date().toISOString();
      this.rejectPending(new Error(this.lastError ?? "内置下载核心已退出"));
      if (this.child === child) {
        this.clearChild(child);
      }
      logger.warn("Embedded torrent core exited", { code, signal, expectedStop });
    });
  }

  /** 将应用设置转换为核心配置，并避免重复发送相同配置。 */
  private async configure(settings: AppSettings): Promise<void> {
    const params = buildCoreConfiguration(settings);
    const key = JSON.stringify(params);
    if (key === this.configurationKey) {
      return;
    }
    this.runtimeStatus = normalizeRuntimeStatus(await this.send("configure", params));
    this.configurationKey = key;
    logger.info("Embedded torrent core settings applied", {
      listenPort: params.listenPort,
      maxActiveDownloads: params.maxActiveDownloads,
      dhtEnabled: params.dhtEnabled,
      upnpEnabled: params.upnpEnabled
    });
  }

  /** 写入一条 NDJSON 请求，并按请求 ID 等待对应响应。 */
  private send<T>(method: CoreMethod, params: Record<string, unknown>): Promise<T> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error("内置下载核心未运行"));
    }

    const id = `core-${Date.now()}-${++this.requestSequence}`;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`内置下载核心请求超时：${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timer
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error(`内置下载核心请求写入失败：${error.message}`));
      });
    });
  }

  /** 解析一行核心响应并完成对应请求。 */
  private handleResponseLine(line: string): void {
    let response: CoreResponse;
    try {
      response = JSON.parse(line) as CoreResponse;
    } catch (error) {
      logger.warn("Embedded torrent core emitted invalid JSON", {
        message: getErrorMessage(error),
        line: line.slice(0, 500)
      });
      return;
    }

    const id = typeof response.id === "string" ? response.id : "";
    const pending = this.pending.get(id);
    if (!pending) {
      logger.warn("Embedded torrent core response has no pending request", { id });
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (response.ok === true || response.ok === "true") {
      pending.resolve(response.result);
      return;
    }
    const code = typeof response.error?.code === "string" ? response.error.code : "CORE_ERROR";
    const message = typeof response.error?.message === "string" ? response.error.message : "内置下载核心请求失败";
    pending.reject(new Error(`${message} (${code})`));
  }

  /** 拒绝全部未完成请求，防止进程退出后 Promise 悬挂。 */
  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  /** 清理指定子进程关联的本地运行状态。 */
  private clearChild(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) {
      return;
    }
    this.stdoutLines?.close();
    this.stdoutLines = null;
    this.child = null;
    this.configurationKey = undefined;
    this.runtimeStatus = {};
  }
}

/** 查找当前平台和架构对应的内置核心二进制。 */
export function resolveBundledTorrentCoreBinary(
  options: TorrentCoreBinaryResolverOptions = {}
): string | undefined {
  if (options.binaryPathOverride) {
    const override = isAbsolute(options.binaryPathOverride)
      ? options.binaryPathOverride
      : resolve(process.cwd(), options.binaryPathOverride);
    return existsSync(override) ? override : undefined;
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const roots = options.resourceRoots ?? getDefaultTorrentCoreResourceRoots();
  const binaryName = platform === "win32" ? "torrent-core.exe" : "torrent-core";
  for (const root of roots) {
    const candidates = [
      join(root, `${platform}-${arch}`, binaryName),
      join(root, platform, binaryName),
      join(root, binaryName)
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** 构造 sidecar 的动态库搜索环境。 */
export function buildTorrentCoreLaunchEnvironment(
  binaryPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const binaryDir = dirname(binaryPath);
  if (process.platform === "win32") {
    env.PATH = prependPath(binaryDir, env.PATH);
  } else if (process.platform === "darwin") {
    env.DYLD_LIBRARY_PATH = prependPath(binaryDir, env.DYLD_LIBRARY_PATH);
  } else {
    env.LD_LIBRARY_PATH = prependPath(binaryDir, env.LD_LIBRARY_PATH);
  }
  return env;
}

/** 将应用下载配置转换为 sidecar 协议参数。 */
export function buildCoreConfiguration(settings: AppSettings): Record<string, unknown> {
  const embedded = settings.download.embedded;
  const seedingLimits = embedded.seedingLimits ?? settings.download.qbittorrent.seedingLimits;
  return {
    listenPort: normalizeInteger(embedded.listenPort, 51413, 1024, 65535),
    dhtEnabled: embedded.dhtEnabled ?? true,
    upnpEnabled: embedded.upnpEnabled ?? true,
    maxActiveDownloads: normalizeInteger(embedded.maxActiveDownloads, 3, 1, 100),
    maxDownloadSpeed: normalizeInteger(embedded.maxDownloadSpeed, 0, 0, Number.MAX_SAFE_INTEGER),
    maxUploadSpeed: normalizeInteger(embedded.maxUploadSpeed, 0, 0, Number.MAX_SAFE_INTEGER),
    seedingLimits: {
      enabled: seedingLimits.enabled,
      ratioEnabled: seedingLimits.ratioEnabled,
      ratioLimit: Math.max(0.1, Number(seedingLimits.ratioLimit) || 1),
      timeEnabled: seedingLimits.timeEnabled,
      timeLimitMinutes: normalizeInteger(seedingLimits.timeLimitMinutes, 120, 1, Number.MAX_SAFE_INTEGER)
    }
  };
}

/** 返回内置核心独立的数据目录。 */
export function resolveTorrentCoreDataDir(settings: AppSettings): string {
  return join(settings.storage.userDataDir, "torrent-core");
}

function getDefaultTorrentCoreResourceRoots(): string[] {
  return [
    join(process.resourcesPath ?? "", "torrent-core"),
    join(process.cwd(), "out", "torrent-core"),
    join(process.cwd(), "resources", "torrent-core"),
    join(process.cwd(), "native", "torrent-core", "build", "release")
  ];
}

function normalizeRuntimeStatus(value: unknown): CoreRuntimeStatus {
  const record = asRecord(value);
  return {
    version: readOptionalString(record.version),
    taskCount: readOptionalNumber(record.taskCount),
    listenPort: readOptionalNumber(record.listenPort)
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function prependPath(value: string, current: string | undefined): string {
  return current ? `${value}${delimiter}${current}` : value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

export const embeddedTorrentCoreService = new EmbeddedTorrentCoreService();
