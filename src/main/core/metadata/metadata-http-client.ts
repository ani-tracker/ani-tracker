import type { Session } from "electron";
import type { MetadataProxySettings } from "@shared/domain";
import { logger } from "../logger";

const METADATA_SESSION_PARTITION = "metadata-proxy";
const DEFAULT_METADATA_TIMEOUT_MS = 5_000;

export interface MetadataFetchOptions extends RequestInit {
  source?: string;
  timeoutMs?: number;
}

const directProxySettings: MetadataProxySettings = {
  mode: "off",
  timeoutMs: DEFAULT_METADATA_TIMEOUT_MS
};

let metadataSession: Session | null | undefined;
let metadataSessionProxyKey = "";
let loggedElectronFallback = false;

export class MetadataHttpClient {
  constructor(private readonly proxySettings: MetadataProxySettings = directProxySettings) {}

  async fetch(input: string | URL, options: MetadataFetchOptions = {}): Promise<Response> {
    const url = input.toString();
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? this.proxySettings.timeoutMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    const { source, timeoutMs: _timeoutMs, signal: _signal, ...requestOptions } = options;

    try {
      const response = await this.fetchWithTransport(url, {
        ...requestOptions,
        signal: controller.signal
      });

      logger.info("元数据网络请求完成", {
        source: source ?? "metadata",
        host: safeHost(url),
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        proxyMode: this.proxySettings.mode
      });

      return response;
    } catch (error) {
      logger.warn("元数据网络请求失败", {
        source: source ?? "metadata",
        host: safeHost(url),
        elapsedMs: Date.now() - startedAt,
        proxyMode: this.proxySettings.mode,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchWithTransport(url: string, options: RequestInit): Promise<Response> {
    const session = await getMetadataSession(this.proxySettings);
    if (session) {
      return session.fetch(url, options);
    }

    return fetch(url, options);
  }
}

export const defaultMetadataHttpClient = new MetadataHttpClient();

async function getMetadataSession(proxySettings: MetadataProxySettings): Promise<Session | null> {
  if (proxySettings.mode === "off") {
    return null;
  }

  const proxyConfig = buildProxyConfig(proxySettings);
  if (!proxyConfig) {
    return null;
  }

  const session = await getElectronMetadataSession();
  if (!session) {
    if (!loggedElectronFallback) {
      loggedElectronFallback = true;
      logger.warn("Electron metadata session unavailable; metadata proxy is ignored outside Electron runtime", {
        proxyMode: proxySettings.mode
      });
    }
    return null;
  }

  const proxyKey = JSON.stringify(proxyConfig);
  if (metadataSessionProxyKey !== proxyKey) {
    await session.setProxy(proxyConfig);
    await session.closeAllConnections();
    metadataSessionProxyKey = proxyKey;
    logger.info("元数据代理配置已应用", {
      proxyMode: proxySettings.mode,
      proxyRules: proxySettings.mode === "manual" ? redactProxyRule(proxySettings.url) : undefined
    });
  }

  return session;
}

async function getElectronMetadataSession(): Promise<Session | null> {
  if (metadataSession !== undefined) {
    return metadataSession;
  }

  try {
    const electron = await import("electron");
    const electronSession = electron.session;
    if (!electronSession?.fromPartition) {
      metadataSession = null;
      return metadataSession;
    }

    metadataSession = electronSession.fromPartition(METADATA_SESSION_PARTITION);
    return metadataSession;
  } catch {
    metadataSession = null;
    return metadataSession;
  }
}

function buildProxyConfig(proxySettings: MetadataProxySettings): Electron.ProxyConfig | null {
  if (proxySettings.mode === "system") {
    return { mode: "system" };
  }

  if (proxySettings.mode !== "manual") {
    return null;
  }

  const proxyRules = proxySettings.url?.trim();
  if (!proxyRules) {
    return null;
  }

  return {
    mode: "fixed_servers",
    proxyRules,
    proxyBypassRules: "127.0.0.1,localhost,<local>"
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
