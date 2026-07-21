import type { Session } from "electron";
import type { MetadataProxySettings } from "@shared/domain";
import { logger } from "../logger";

const DIRECT_METADATA_SESSION_PARTITION = "metadata-direct";
const PROXY_METADATA_SESSION_PARTITION = "metadata-proxy";
const DEFAULT_METADATA_TIMEOUT_MS = 15_000;

type MetadataTransport = "electron-session" | "node-fetch";

interface MetadataTransportExecutor {
  name: MetadataTransport;
  fetch(input: string, options: RequestInit): Promise<Response>;
}

interface MetadataSessionState {
  session: Session;
  proxyKey?: string;
}

export interface MetadataSessionProfile {
  partition: string;
  proxyConfig: Electron.ProxyConfig;
}

export interface MetadataHttpRuntime {
  getSession(proxySettings: MetadataProxySettings): Promise<Session | null>;
  fallbackFetch(input: string, options: RequestInit): Promise<Response>;
}

export interface MetadataFetchOptions extends RequestInit {
  source?: string;
  timeoutMs?: number;
}

const directProxySettings: MetadataProxySettings = {
  mode: "off",
  timeoutMs: DEFAULT_METADATA_TIMEOUT_MS
};

const metadataSessionStates = new Map<string, MetadataSessionState>();
const metadataSessionConfigurationQueues = new Map<string, Promise<void>>();
let electronSessionUnavailable = false;
let loggedElectronFallback = false;

const defaultMetadataHttpRuntime: MetadataHttpRuntime = {
  getSession: getMetadataSession,
  fallbackFetch: (input, options) => fetch(input, options)
};

export class MetadataHttpClient {
  constructor(
    private readonly proxySettings: MetadataProxySettings = directProxySettings,
    private readonly runtime: MetadataHttpRuntime = defaultMetadataHttpRuntime
  ) {}

  /** 使用配置的 Chromium Session 或 Node 回退传输执行网络请求。 */
  async fetch(input: string | URL, options: MetadataFetchOptions = {}): Promise<Response> {
    const url = input.toString();
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? this.proxySettings.timeoutMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    const { source, timeoutMs: _timeoutMs, signal: _signal, ...requestOptions } = options;
    let transport: MetadataTransport = "node-fetch";

    try {
      const executor = await this.resolveTransport();
      transport = executor.name;
      const response = await executor.fetch(url, {
        ...requestOptions,
        signal: controller.signal
      });

      logger.info("元数据网络请求完成", {
        source: source ?? "metadata",
        host: safeHost(url),
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        proxyMode: this.proxySettings.mode,
        transport,
        server: response.headers.get("server") ?? undefined,
        retryAfter: response.headers.get("retry-after") ?? undefined
      });

      return response;
    } catch (error) {
      logger.warn("元数据网络请求失败", {
        source: source ?? "metadata",
        host: safeHost(url),
        elapsedMs: Date.now() - startedAt,
        proxyMode: this.proxySettings.mode,
        transport,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 优先使用 Electron Chromium 网络栈，不可用时回退 Node fetch。 */
  private async resolveTransport(): Promise<MetadataTransportExecutor> {
    const session = await this.runtime.getSession(this.proxySettings);
    if (session) {
      return {
        name: "electron-session",
        fetch: (input, options) => session.fetch(input, options)
      };
    }

    return {
      name: "node-fetch",
      fetch: this.runtime.fallbackFetch
    };
  }
}

export const defaultMetadataHttpClient = new MetadataHttpClient();

/** 按代理模式选择隔离的 Electron Session 并应用网络配置。 */
async function getMetadataSession(proxySettings: MetadataProxySettings): Promise<Session | null> {
  const profile = resolveMetadataSessionProfile(proxySettings);
  if (!profile) {
    return null;
  }

  const sessionState = await getElectronMetadataSession(profile.partition);
  const session = sessionState?.session;
  if (!session) {
    if (!loggedElectronFallback) {
      loggedElectronFallback = true;
      logger.warn("Electron 网络会话不可用，已回退 Node fetch", {
        proxyMode: proxySettings.mode
      });
    }
    return null;
  }

  await configureMetadataSession(sessionState, profile, proxySettings);

  return session;
}

/** 获取并缓存指定分区的 Electron Session。 */
async function getElectronMetadataSession(partition: string): Promise<MetadataSessionState | null> {
  const cached = metadataSessionStates.get(partition);
  if (cached) {
    return cached;
  }
  if (electronSessionUnavailable) {
    return null;
  }

  try {
    const electron = await import("electron");
    const electronSession = electron.session;
    if (!electronSession?.fromPartition) {
      electronSessionUnavailable = true;
      return null;
    }

    const state = { session: electronSession.fromPartition(partition) };
    metadataSessionStates.set(partition, state);
    return state;
  } catch {
    electronSessionUnavailable = true;
    return null;
  }
}

/** 串行应用同一 Session 的代理设置，避免并发请求重复重置连接。 */
async function configureMetadataSession(
  state: MetadataSessionState,
  profile: MetadataSessionProfile,
  proxySettings: MetadataProxySettings
): Promise<void> {
  const proxyKey = JSON.stringify(profile.proxyConfig);
  const previous = metadataSessionConfigurationQueues.get(profile.partition) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    if (state.proxyKey === proxyKey) {
      return;
    }
    await state.session.setProxy(profile.proxyConfig);
    await state.session.closeAllConnections();
    state.proxyKey = proxyKey;
    logger.info("元数据网络会话配置已应用", {
      partition: profile.partition,
      proxyMode: proxySettings.mode,
      proxyRules: proxySettings.mode === "manual" ? redactProxyRule(proxySettings.url) : undefined
    });
  });
  metadataSessionConfigurationQueues.set(profile.partition, current);
  try {
    await current;
  } finally {
    if (metadataSessionConfigurationQueues.get(profile.partition) === current) {
      metadataSessionConfigurationQueues.delete(profile.partition);
    }
  }
}

/** 将代理配置映射到互相隔离的 Electron Session。 */
export function resolveMetadataSessionProfile(
  proxySettings: MetadataProxySettings
): MetadataSessionProfile | null {
  if (proxySettings.mode === "off") {
    return {
      partition: DIRECT_METADATA_SESSION_PARTITION,
      proxyConfig: { mode: "direct" }
    };
  }

  if (proxySettings.mode === "system") {
    return {
      partition: PROXY_METADATA_SESSION_PARTITION,
      proxyConfig: { mode: "system" }
    };
  }

  if (proxySettings.mode !== "manual") {
    return null;
  }

  const proxyRules = proxySettings.url?.trim();
  if (!proxyRules) {
    return null;
  }

  return {
    partition: PROXY_METADATA_SESSION_PARTITION,
    proxyConfig: {
      mode: "fixed_servers",
      proxyRules,
      proxyBypassRules: "127.0.0.1,localhost,<local>"
    }
  };
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_METADATA_TIMEOUT_MS;
  }

  return Math.max(1_000, Math.min(60_000, Math.round(value)));
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "unknown";
  }
}

function redactProxyRule(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return value.replace(/\/\/([^:@/]+):([^@/]+)@/g, "//***:***@");
  }
}
