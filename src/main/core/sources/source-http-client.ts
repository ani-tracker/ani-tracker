import type { ReleaseSourceConfig, ReleaseSourceSyncState } from "@shared/domain";
import { logger } from "../logger";
import {
  MetadataHttpClient,
  type MetadataFetchOptions
} from "../metadata/metadata-http-client";
import type { AppRepository } from "../repositories/app-repository";
import type { ReleaseHttpClient } from "./mikan-source";

const MAX_REQUEST_INTERVAL_MS = 60_000;
const ACCESS_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const TRANSIENT_BACKOFF_MS = [30_000, 2 * 60_000, 30 * 60_000] as const;
const CIRCUIT_FAILURE_COUNT = 3;
const CIRCUIT_BACKOFF_MS = 30 * 60_000;

interface HostQueueState {
  tail: Promise<void>;
  nextAllowedAtMs: number;
}

export interface SourceRequestStateStore {
  listSourceSyncStates(): Promise<ReleaseSourceSyncState[]>;
  upsertSourceSyncState(state: ReleaseSourceSyncState): Promise<ReleaseSourceSyncState[]>;
}

export interface SourceRequestSchedulerOptions {
  now?: () => number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

/** 按域名串行调度下载源请求，并持久化站点退避状态。 */
export class SourceRequestScheduler {
  private readonly hostQueues = new Map<string, HostQueueState>();
  private readonly inFlightRequests = new Map<string, Promise<Response>>();
  private readonly sourceStates = new Map<string, ReleaseSourceSyncState>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(options: SourceRequestSchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? wait;
  }

  async schedule(
    config: ReleaseSourceConfig,
    input: string | URL,
    options: MetadataFetchOptions,
    operation: () => Promise<Response>,
    stateStore?: SourceRequestStateStore
  ): Promise<Response> {
    const url = input.toString();
    const requestKey = buildRequestKey(config.id, url, options);
    const existing = this.inFlightRequests.get(requestKey);
    if (existing) {
      logger.info("下载源相同请求已合并", { sourceId: config.id, host: safeHost(url) });
      return (await existing).clone();
    }

    const request = this.enqueue(config, url, operation, stateStore);
    this.inFlightRequests.set(requestKey, request);
    try {
      return (await request).clone();
    } finally {
      this.inFlightRequests.delete(requestKey);
    }
  }

  private async enqueue(
    config: ReleaseSourceConfig,
    url: string,
    operation: () => Promise<Response>,
    stateStore?: SourceRequestStateStore
  ): Promise<Response> {
    const host = safeHost(url);
    const queue = this.hostQueues.get(host) ?? { tail: Promise.resolve(), nextAllowedAtMs: 0 };
    this.hostQueues.set(host, queue);

    let resolveResult!: (response: Response) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<Response>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    queue.tail = queue.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          const sourceState = await this.loadState(config.id, stateStore);
          await this.assertNotBlocked(config, sourceState, host, stateStore);
          const intervalMs = normalizeRequestInterval(config.requestIntervalMs);
          const persistedNextAt = parseTime(sourceState.lastRequestAt) + intervalMs;
          const waitUntil = Math.max(queue.nextAllowedAtMs, persistedNextAt);
          await this.sleep(Math.max(0, waitUntil - this.now()));

          const jitterMs = Math.round(intervalMs * 0.2 * clampRandom(this.random()));
          queue.nextAllowedAtMs = this.now() + intervalMs + jitterMs;
          const response = await operation();
          await this.recordResponse(config, host, response, stateStore);
          resolveResult(response);
        } catch (error) {
          try {
            await this.recordFailure(config, host, error, stateStore);
          } catch (stateError) {
            logger.warn("下载源请求失败状态保存失败", {
              sourceId: config.id,
              message: stateError instanceof Error ? stateError.message : String(stateError)
            });
          } finally {
            rejectResult(error);
          }
        }
      });

    return result;
  }

  private async loadState(sourceId: string, stateStore?: SourceRequestStateStore): Promise<ReleaseSourceSyncState> {
    if (stateStore) {
      const persisted = (await stateStore.listSourceSyncStates()).find((state) => state.sourceId === sourceId);
      if (persisted) {
        this.sourceStates.set(sourceId, persisted);
        return persisted;
      }
    }
    return this.sourceStates.get(sourceId) ?? createEmptyState(sourceId);
  }

  private async assertNotBlocked(
    config: ReleaseSourceConfig,
    state: ReleaseSourceSyncState,
    host: string,
    stateStore?: SourceRequestStateStore
  ): Promise<void> {
    const states = stateStore ? await stateStore.listSourceSyncStates() : [...this.sourceStates.values()];
    const hostBlockedUntilMs = states
      .filter((item) => item.requestHost === host)
      .reduce((latest, item) => Math.max(latest, parseTime(item.backoffUntil)), 0);
    const blockedUntilMs = Math.max(parseTime(state.backoffUntil), hostBlockedUntilMs);
    if (blockedUntilMs <= this.now()) {
      return;
    }
    const seconds = Math.max(1, Math.ceil((blockedUntilMs - this.now()) / 1000));
    throw new Error(`${config.name} 正在退避保护中，请 ${seconds} 秒后重试`);
  }

  private async recordResponse(
    config: ReleaseSourceConfig,
    host: string,
    response: Response,
    stateStore?: SourceRequestStateStore
  ): Promise<void> {
    const current = await this.loadState(config.id, stateStore);
    const nowIso = new Date(this.now()).toISOString();
    if (response.status === 403 || response.status === 429) {
      const failureCount = current.requestFailureCount + 1;
      const backoffMs = resolveAccessBackoffMs(response, failureCount, this.now());
      await this.saveState({
        ...current,
        requestHost: host,
        lastRequestAt: nowIso,
        requestFailureCount: failureCount,
        backoffUntil: new Date(this.now() + backoffMs).toISOString()
      }, stateStore);
      logger.warn("下载源触发访问保护", {
        sourceId: config.id,
        status: response.status,
        failureCount,
        backoffMs
      });
      return;
    }

    if (response.status >= 500) {
      const failureCount = current.requestFailureCount + 1;
      const backoffMs = resolveTransientBackoffMs(failureCount);
      await this.saveState({
        ...current,
        requestHost: host,
        lastRequestAt: nowIso,
        requestFailureCount: failureCount,
        backoffUntil: new Date(this.now() + backoffMs).toISOString()
      }, stateStore);
      return;
    }

    await this.saveState({
      ...current,
      requestHost: host,
      lastRequestAt: nowIso,
      requestFailureCount: 0,
      backoffUntil: undefined
    }, stateStore);
  }

  private async recordFailure(
    config: ReleaseSourceConfig,
    host: string,
    error: unknown,
    stateStore?: SourceRequestStateStore
  ): Promise<void> {
    if (error instanceof Error && error.message.includes("正在退避保护中")) {
      return;
    }
    const current = await this.loadState(config.id, stateStore);
    const failureCount = current.requestFailureCount + 1;
    const backoffMs = resolveTransientBackoffMs(failureCount);
    await this.saveState({
      ...current,
      requestHost: host,
      lastRequestAt: new Date(this.now()).toISOString(),
      requestFailureCount: failureCount,
      backoffUntil: new Date(this.now() + backoffMs).toISOString()
    }, stateStore);
  }

  private async saveState(state: ReleaseSourceSyncState, stateStore?: SourceRequestStateStore): Promise<void> {
    this.sourceStates.set(state.sourceId, state);
    if (stateStore) {
      await stateStore.upsertSourceSyncState(state);
    }
  }
}

const directHttpClient = new MetadataHttpClient({ mode: "off", timeoutMs: 15_000 });
export const defaultSourceRequestScheduler = new SourceRequestScheduler();

/** 为单个下载源创建带代理选择和访问保护的 HTTP 客户端。 */
export function createSourceHttpClient(
  config: ReleaseSourceConfig,
  proxyHttpClient: ReleaseHttpClient,
  repository?: AppRepository,
  scheduler = defaultSourceRequestScheduler
): ReleaseHttpClient {
  const transport = config.useProxy === false ? directHttpClient : proxyHttpClient;
  const stateStore = supportsSourceRequestStateStore(repository) ? repository : undefined;
  return {
    fetch: (input, options = {}) => scheduler.schedule(
      config,
      input,
      options,
      () => transport.fetch(input, options),
      stateStore
    )
  };
}

function createEmptyState(sourceId: string): ReleaseSourceSyncState {
  return { sourceId, requestFailureCount: 0 };
}

function normalizeRequestInterval(value?: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(250, Math.min(MAX_REQUEST_INTERVAL_MS, Math.round(value!)));
}

function supportsSourceRequestStateStore(value: AppRepository | undefined): value is AppRepository {
  return Boolean(value)
    && typeof value!.listSourceSyncStates === "function"
    && typeof value!.upsertSourceSyncState === "function";
}

function resolveAccessBackoffMs(response: Response, failureCount: number, nowMs: number): number {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), nowMs);
  const index = Math.min(ACCESS_BACKOFF_MS.length - 1, Math.max(0, failureCount - 1));
  const configured = failureCount >= CIRCUIT_FAILURE_COUNT
    ? Math.max(CIRCUIT_BACKOFF_MS, ACCESS_BACKOFF_MS[index])
    : ACCESS_BACKOFF_MS[index];
  return Math.max(configured, retryAfterMs);
}

function resolveTransientBackoffMs(failureCount: number): number {
  if (failureCount >= CIRCUIT_FAILURE_COUNT) {
    return CIRCUIT_BACKOFF_MS;
  }
  return TRANSIENT_BACKOFF_MS[Math.min(TRANSIENT_BACKOFF_MS.length - 1, Math.max(0, failureCount - 1))];
}

function parseRetryAfter(value: string | null, nowMs: number): number {
  if (!value) {
    return 0;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : 0;
}

function buildRequestKey(sourceId: string, url: string, options: MetadataFetchOptions): string {
  const headers = [...new Headers(options.headers).entries()].sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([sourceId, options.method ?? "GET", url, headers]);
}

function safeHost(value: string): string {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "unknown";
  }
}

function parseTime(value?: string): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampRandom(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
