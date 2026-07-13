import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { QbittorrentManagedStatus } from "@shared/contracts";
import type { AppSettings } from "@shared/domain";
import { logger } from "../logger";

const MIN_MANAGED_WEBUI_PORT = 10_000;
const DEFAULT_MANAGED_WEBUI_PORT = 18_080;

interface QbittorrentLaunchPlan {
  binaryPath?: string;
  profileDir: string;
  webUiUrl: string;
  webUiPort: number;
  startupTimeoutMs: number;
}

interface QbittorrentBinaryResolverOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  resourceRoots?: string[];
  binaryPathOverride?: string;
}

export class QbittorrentManagedService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lastSettings: AppSettings | null = null;
  private activePlan: QbittorrentLaunchPlan | null = null;
  private stoppingPid: number | null = null;
  private lastStartedAt: string | undefined;
  private lastStoppedAt: string | undefined;
  private lastError: string | undefined;

  async applySettings(settings: AppSettings): Promise<QbittorrentManagedStatus> {
    this.lastSettings = settings;

    if (settings.download.qbittorrent.managed.enabled && settings.download.qbittorrent.autoConnect) {
      return this.start(settings);
    }

    if (this.child) {
      await this.stop();
    }

    return this.getStatus(settings);
  }

  async start(settings: AppSettings): Promise<QbittorrentManagedStatus> {
    this.lastSettings = settings;

    if (!settings.download.qbittorrent.managed.enabled) {
      this.lastError = "托管 qBittorrent 未启用";
      return this.getStatus(settings);
    }

    if (this.child) {
      return this.getStatus(settings);
    }

    const plan = await buildLaunchPlan(settings);

    if (!plan.binaryPath) {
      this.lastError = "未找到项目内置的 qBittorrent-nox 无头二进制";
      logger.warn("Bundled qBittorrent-nox binary missing", {
        platform: process.platform,
        arch: process.arch
      });
      return this.getStatus(settings);
    }

    await mkdir(plan.profileDir, { recursive: true });
    const args = buildQbittorrentArgs(plan);
    logger.info("Starting managed qBittorrent", {
      binaryPath: plan.binaryPath,
      webUiUrl: plan.webUiUrl,
      profileDir: plan.profileDir
    });

    const env = buildQbittorrentLaunchEnvironment(plan.binaryPath);
    const child = spawn(plan.binaryPath, args, {
      cwd: dirname(plan.binaryPath),
      env,
      windowsHide: true
    });
    this.child = child;
    this.activePlan = plan;
    this.lastStartedAt = new Date().toISOString();
    this.lastStoppedAt = undefined;
    this.lastError = undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      logger.info("Managed qBittorrent stdout", { message: formatProcessOutput(chunk) });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logger.warn("Managed qBittorrent stderr", { message: formatProcessOutput(chunk) });
    });
    child.once("error", (error) => {
      this.lastError = error.message;
      logger.error("Managed qBittorrent failed to start", { message: error.message });
    });
    child.once("exit", (code, signal) => {
      const pid = child.pid ?? 0;
      const expectedStop = this.stoppingPid === pid;
      if (this.child === child) {
        this.child = null;
      }
      if (this.activePlan === plan) {
        this.activePlan = null;
      }
      if (expectedStop) {
        this.stoppingPid = null;
      } else if (code !== 0) {
        this.lastError = `qBittorrent 进程退出：code=${code ?? "null"} signal=${signal ?? "null"}`;
      }
      this.lastStoppedAt = new Date().toISOString();
      logger.warn("Managed qBittorrent exited", { code, signal, expectedStop });
    });

    const ready = await waitForWebUi(plan.webUiUrl, plan.startupTimeoutMs);
    if (!ready) {
      this.lastError = `qBittorrent WebUI 未在 ${plan.startupTimeoutMs}ms 内就绪`;
      logger.warn("Managed qBittorrent WebUI startup timeout", {
        webUiUrl: plan.webUiUrl,
        timeoutMs: plan.startupTimeoutMs
      });
    }

    return this.getStatus(settings);
  }

  async stop(): Promise<QbittorrentManagedStatus> {
    const child = this.child;
    if (!child) {
      return this.getStatus();
    }

    this.stoppingPid = child.pid ?? 0;
    logger.info("Stopping managed qBittorrent", { pid: child.pid });
    child.kill();

    const exited = await Promise.race([
      onceExit(child).then(() => true),
      sleep(5_000).then(() => false)
    ]);

    if (!exited) {
      logger.warn("Managed qBittorrent did not exit after SIGTERM; sending SIGKILL", { pid: child.pid });
      child.kill("SIGKILL");
      await Promise.race([onceExit(child), sleep(2_000)]);
    }

    if (this.child === child) {
      this.child = null;
    }
    this.activePlan = null;
    this.stoppingPid = null;
    this.lastStoppedAt = new Date().toISOString();

    return this.getStatus();
  }

  getStatus(settings = this.lastSettings): QbittorrentManagedStatus {
    const plan = this.child && this.activePlan ? this.activePlan : settings ? buildStatusLaunchPlan(settings) : null;

    return {
      enabled: settings?.download.qbittorrent.managed.enabled ?? false,
      autoStart: settings?.download.qbittorrent.autoConnect ?? false,
      running: Boolean(this.child),
      webUiUrl: plan?.webUiUrl ?? `http://127.0.0.1:${DEFAULT_MANAGED_WEBUI_PORT}/`,
      platform: process.platform,
      arch: process.arch,
      binaryPath: plan?.binaryPath,
      profileDir: plan?.profileDir,
      pid: this.child?.pid,
      lastStartedAt: this.lastStartedAt,
      lastStoppedAt: this.lastStoppedAt,
      lastError: this.lastError
    };
  }

  getRuntimeBaseUrl(settings: AppSettings): string {
    if (this.child && this.activePlan) {
      return this.activePlan.webUiUrl;
    }

    return settings.download.qbittorrent.baseUrl;
  }
}

export function resolveBundledQbittorrentBinary(options: QbittorrentBinaryResolverOptions = {}): string | undefined {
  if (options.binaryPathOverride) {
    const binaryPath = isAbsolute(options.binaryPathOverride)
      ? options.binaryPathOverride
      : resolve(process.cwd(), options.binaryPathOverride);
    return existsSync(binaryPath) ? binaryPath : undefined;
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const roots = options.resourceRoots ?? getDefaultQbittorrentResourceRoots();
  const platformDirs = [`${platform}-${arch}`, platform];
  const binaryNames = getQbittorrentBinaryNames(platform);

  for (const root of roots) {
    for (const platformDir of platformDirs) {
      for (const binaryName of binaryNames) {
        const binaryPath = join(root, platformDir, binaryName);
        if (existsSync(binaryPath)) {
          return binaryPath;
        }
      }
    }
  }

  return undefined;
}

export function buildQbittorrentLaunchEnvironment(
  binaryPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const pluginPath = resolveBundledQtPluginPath(binaryPath);
  if (existsSync(pluginPath)) {
    env.QT_PLUGIN_PATH = prependEnvPath(pluginPath, env.QT_PLUGIN_PATH);
  }

  const opensslModulesPath = resolveBundledOpenSslModulesPath(binaryPath);
  if (existsSync(opensslModulesPath)) {
    env.OPENSSL_MODULES = opensslModulesPath;
  }

  return env;
}

async function buildLaunchPlan(settings: AppSettings): Promise<QbittorrentLaunchPlan> {
  const plan = buildStatusLaunchPlan(settings);
  const webUiUrl = new URL(plan.webUiUrl);
  const requestedPort = getWebUiPort(webUiUrl);
  const webUiPort = await resolveManagedWebUiPort(requestedPort);
  webUiUrl.port = String(webUiPort);

  return {
    ...plan,
    webUiUrl: webUiUrl.href,
    webUiPort
  };
}

function buildStatusLaunchPlan(settings: AppSettings): QbittorrentLaunchPlan {
  const managed = settings.download.qbittorrent.managed;
  const webUiUrl = normalizeManagedBaseUrl(settings.download.qbittorrent.baseUrl);

  return {
    binaryPath: resolveBundledQbittorrentBinary({
      binaryPathOverride: managed.binaryPath
    }),
    profileDir: managed.profileDir ?? join(settings.storage.userDataDir, "qbittorrent"),
    webUiUrl: webUiUrl.href,
    webUiPort: getWebUiPort(webUiUrl),
    startupTimeoutMs: managed.startupTimeoutMs
  };
}

function buildQbittorrentArgs(plan: QbittorrentLaunchPlan): string[] {
  return [
    `--webui-port=${plan.webUiPort}`,
    `--profile=${plan.profileDir}`,
    "--confirm-legal-notice"
  ];
}

function getDefaultQbittorrentResourceRoots(): string[] {
  const processWithResourcesPath = process as NodeJS.Process & { resourcesPath?: string };
  return unique(
    [
      processWithResourcesPath.resourcesPath ? join(processWithResourcesPath.resourcesPath, "qbittorrent") : undefined,
      join(process.cwd(), "out", "qbittorrent"),
      join(process.cwd(), "resources", "qbittorrent")
    ].filter((item): item is string => Boolean(item))
  );
}

function getQbittorrentBinaryNames(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return ["qbittorrent-nox.exe"];
  }

  if (platform === "darwin") {
    return [
      "qbittorrent-nox",
      "qbittorrent-nox.app/Contents/MacOS/qbittorrent-nox",
      "qBittorrent-nox.app/Contents/MacOS/qbittorrent-nox"
    ];
  }

  return ["qbittorrent-nox"];
}

function resolveMacAppContentsDir(binaryPath: string): string | undefined {
  const executableDir = dirname(binaryPath);
  if (basename(executableDir) !== "MacOS") {
    return undefined;
  }

  const contentsDir = dirname(executableDir);
  if (basename(contentsDir) !== "Contents") {
    return undefined;
  }

  const appDir = dirname(contentsDir);
  if (!basename(appDir).endsWith(".app")) {
    return undefined;
  }

  return contentsDir;
}

function resolveBundledQtPluginPath(binaryPath: string): string {
  const contentsDir = resolveMacAppContentsDir(binaryPath);
  if (contentsDir) {
    return join(contentsDir, "PlugIns");
  }

  return dirname(binaryPath);
}

function resolveBundledOpenSslModulesPath(binaryPath: string): string {
  const contentsDir = resolveMacAppContentsDir(binaryPath);
  if (contentsDir) {
    return join(contentsDir, "Frameworks", "ossl-modules");
  }

  return join(dirname(binaryPath), "ossl-modules");
}

function prependEnvPath(path: string, currentValue: string | undefined): string {
  return currentValue ? `${path}${delimiter}${currentValue}` : path;
}

function normalizeBaseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    return new URL(`http://127.0.0.1:${DEFAULT_MANAGED_WEBUI_PORT}`);
  }
}

function normalizeManagedBaseUrl(value: string): URL {
  const url = normalizeBaseUrl(value);
  const port = getWebUiPort(url);

  if (port < MIN_MANAGED_WEBUI_PORT) {
    url.hostname = "127.0.0.1";
    url.protocol = "http:";
    url.port = String(DEFAULT_MANAGED_WEBUI_PORT);
  }

  return url;
}

function getWebUiPort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }

  return url.protocol === "https:" ? 443 : 80;
}

async function resolveManagedWebUiPort(requestedPort: number): Promise<number> {
  const preferredPort = requestedPort >= MIN_MANAGED_WEBUI_PORT ? requestedPort : DEFAULT_MANAGED_WEBUI_PORT;
  if (await isPortAvailable(preferredPort)) {
    return preferredPort;
  }

  for (let port = MIN_MANAGED_WEBUI_PORT; port <= 65_535; port += 1) {
    if (port === preferredPort) {
      continue;
    }

    if (await isPortAvailable(port)) {
      logger.info("Managed qBittorrent selected fallback WebUI port", {
        requestedPort,
        selectedPort: port
      });
      return port;
    }
  }

  throw new Error("没有找到 10000 以上可用的 qBittorrent WebUI 端口");
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    let settled = false;
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (available: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolvePort(available);
    };

    socket.setTimeout(300);
    socket.once("connect", () => finish(false));
    socket.once("timeout", () => finish(true));
    socket.once("error", () => finish(true));
  });
}

async function waitForWebUi(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status < 500) {
        return true;
      }
    } catch {
      // Retry until timeout; qBittorrent may need a few seconds to create its profile.
    } finally {
      clearTimeout(timer);
    }

    await sleep(500);
  }

  return false;
}

function onceExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }

    child.once("exit", () => resolveExit());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function formatProcessOutput(chunk: Buffer): string {
  return chunk.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 500);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
