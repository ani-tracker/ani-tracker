import type { ReleaseSourceConfig, ReleaseSourceSyncState, RequestCircuitState } from "@shared/domain";
import {
  getSourceMinimumRequestIntervalMs,
  MAX_SOURCE_REQUEST_INTERVAL_MS,
  MIN_SOURCE_REQUEST_INTERVAL_MS
} from "@shared/source-network-policy";
import { logger } from "../logger";
import {
  MetadataHttpClient,
  type MetadataFetchOptions
} from "../metadata/metadata-http-client";
import type { AppRepository } from "../repositories/app-repository";
import {
  buildHttpRequestKey,
  defaultRequestCircuitBreaker,
  RequestCircuitBreaker,
  type RequestCircuitStateStore,
  type RequestCircuitTarget,
  supportsRequestCircuitStateStore
} from "../network/request-circuit-breaker";
import type { ReleaseHttpClient } from "./mikan-source";

const RELEASE_SOURCE_CIRCUIT_GROUP = "release-source";

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
  circuitBreaker?: RequestCircuitBreaker;
}

/** 按域名串行调度下载源请求，并持久化站点熔断状态。 */
export class SourceRequestScheduler {
  private readonly hostQueues = new Map<string, HostQueueState>();
  private readonly inFlightRequests = new Map<string, Promise<Response>>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly circuitBreaker: RequestCircuitBreaker;

  constructor(options: SourceRequestSchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? wait;
    this.circuitBreaker = options.circuitBreaker ?? new RequestCircuitBreaker({ now: this.now });
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
          const target = createReleaseSourceCircuitTarget(config);
          const circuitStateStore = resolveCircuitStateStore(stateStore);
          const sourceState = await this.circuitBreaker.getState(target, circuitStateStore);
          const intervalMs = normalizeRequestInterval(config, url);
          const persistedNextAt = parseTime(sourceState.lastRequestAt) + intervalMs;
          const waitUntil = Math.max(queue.nextAllowedAtMs, persistedNextAt);
          await this.sleep(Math.max(0, waitUntil - this.now()));

          const jitterMs = Math.round(intervalMs * 0.2 * clampRandom(this.random()));
          queue.nextAllowedAtMs = this.now() + intervalMs + jitterMs;
          const response = await this.circuitBreaker.execute(target, url, operation, {
            stateStore: circuitStateStore
          });
          resolveResult(response);
        } catch (error) {
          rejectResult(error);
        }
      });

    return result;
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

/** 读取下载源对应的通用熔断状态，并兼容尚未迁移的状态仓库。 */
export async function getReleaseSourceCircuitState(
  sourceId: string,
  sourceName: string,
  stateStore: SourceRequestStateStore | RequestCircuitStateStore,
  circuitBreaker = defaultRequestCircuitBreaker
): Promise<RequestCircuitState> {
  return circuitBreaker.getState(
    createReleaseSourceCircuitTarget({ id: sourceId, name: sourceName } as ReleaseSourceConfig),
    resolveCircuitStateStore(stateStore)
  );
}

/** 规范化来源间隔，并强制执行站点级访问频率下限。 */
function normalizeRequestInterval(config: ReleaseSourceConfig, requestUrl: string): number {
  const siteMinimumMs = getSourceMinimumRequestIntervalMs(config, requestUrl);
  if (!Number.isFinite(config.requestIntervalMs)) {
    return siteMinimumMs === MIN_SOURCE_REQUEST_INTERVAL_MS ? 0 : siteMinimumMs;
  }
  return Math.max(
    siteMinimumMs,
    Math.min(MAX_SOURCE_REQUEST_INTERVAL_MS, Math.round(config.requestIntervalMs!))
  );
}

/** 判断仓库是否支持旧下载源状态接口。 */
function supportsSourceRequestStateStore(value: AppRepository | undefined): value is AppRepository {
  return Boolean(value)
    && typeof value!.listSourceSyncStates === "function"
    && typeof value!.upsertSourceSyncState === "function";
}

/** 为下载源请求生成包含来源标识的去重键。 */
function buildRequestKey(sourceId: string, url: string, options: MetadataFetchOptions): string {
  return JSON.stringify([sourceId, buildHttpRequestKey(url, options)]);
}

/** 为下载源创建通用熔断目标标识。 */
function createReleaseSourceCircuitTarget(config: Pick<ReleaseSourceConfig, "id" | "name">): RequestCircuitTarget {
  return {
    key: `${RELEASE_SOURCE_CIRCUIT_GROUP}:${config.id}`,
    group: RELEASE_SOURCE_CIRCUIT_GROUP,
    name: config.name,
    shareByHost: true
  };
}

const legacyStateStoreAdapters = new WeakMap<object, RequestCircuitStateStore>();

/** 将旧下载源同步状态仓库适配到通用熔断状态接口。 */
function resolveCircuitStateStore(
  stateStore?: SourceRequestStateStore | RequestCircuitStateStore
): RequestCircuitStateStore | undefined {
  if (!stateStore) {
    return undefined;
  }
  if (supportsRequestCircuitStateStore(stateStore)) {
    return stateStore;
  }

  const key = stateStore as object;
  const cached = legacyStateStoreAdapters.get(key);
  if (cached) {
    return cached;
  }
  const legacyStore = stateStore as SourceRequestStateStore;
  const adapter: RequestCircuitStateStore = {
    listRequestCircuitStates: async () => (await legacyStore.listSourceSyncStates()).map(mapLegacySourceState),
    upsertRequestCircuitState: async (state) => {
      const sourceId = state.key.replace(`${RELEASE_SOURCE_CIRCUIT_GROUP}:`, "");
      const previous = (await legacyStore.listSourceSyncStates()).find((item) => item.sourceId === sourceId)
        ?? createEmptyState(sourceId);
      await legacyStore.upsertSourceSyncState({
        ...previous,
        requestHost: state.requestHost,
        lastRequestAt: state.lastRequestAt,
        requestFailureCount: state.failureCount,
        backoffUntil: state.backoffUntil
      });
      return (await legacyStore.listSourceSyncStates()).map(mapLegacySourceState);
    }
  };
  legacyStateStoreAdapters.set(key, adapter);
  return adapter;
}

/** 将旧下载源请求状态映射为通用熔断状态。 */
function mapLegacySourceState(state: ReleaseSourceSyncState): RequestCircuitState {
  return {
    key: `${RELEASE_SOURCE_CIRCUIT_GROUP}:${state.sourceId}`,
    group: RELEASE_SOURCE_CIRCUIT_GROUP,
    requestHost: state.requestHost,
    lastRequestAt: state.lastRequestAt,
    failureCount: state.requestFailureCount,
    backoffUntil: state.backoffUntil
  };
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
