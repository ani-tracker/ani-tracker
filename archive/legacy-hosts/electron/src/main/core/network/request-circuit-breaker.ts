import type { RequestCircuitState } from "@shared/domain";
import { logger } from "../logger";

const FORBIDDEN_BACKOFF_MS = [10 * 60_000, 20 * 60_000, 30 * 60_000] as const;
const RATE_LIMIT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const TRANSIENT_BACKOFF_MS = [30_000, 2 * 60_000, 30 * 60_000] as const;
const CIRCUIT_FAILURE_COUNT = 3;
const CIRCUIT_BACKOFF_MS = 30 * 60_000;

export interface RequestCircuitTarget {
  key: string;
  group: string;
  name: string;
  shareByHost?: boolean;
}

export interface RequestCircuitStateStore {
  listRequestCircuitStates(): Promise<RequestCircuitState[]>;
  upsertRequestCircuitState(state: RequestCircuitState): Promise<RequestCircuitState[]>;
}

export type RequestCircuitOutcome =
  | { kind: "response"; response: Response; failureCount: number; nowMs: number }
  | { kind: "error"; error: unknown; failureCount: number; nowMs: number };

/** 定义响应和异常如何映射为熔断退避时间。 */
export interface RequestCircuitBreakerPolicy {
  resolveBackoffMs(outcome: RequestCircuitOutcome): number | undefined;
}

export interface RequestCircuitBreakerOptions {
  now?: () => number;
  policy?: RequestCircuitBreakerPolicy;
}

export interface RequestCircuitExecutionOptions {
  requestKey?: string;
  stateStore?: RequestCircuitStateStore;
}

/** 表示请求在发出前被熔断器拒绝。 */
export class RequestCircuitOpenError extends Error {
  constructor(
    message: string,
    readonly target: RequestCircuitTarget,
    readonly retryAt?: string
  ) {
    super(message);
    this.name = "RequestCircuitOpenError";
  }
}

/** 通用 HTTP 熔断策略，保持原下载源对 403、429 和瞬时故障的退避规则。 */
export const defaultHttpCircuitBreakerPolicy: RequestCircuitBreakerPolicy = {
  resolveBackoffMs(outcome) {
    if (outcome.kind === "error") {
      return resolveTransientBackoffMs(outcome.failureCount);
    }

    const { response, failureCount, nowMs } = outcome;
    if (response.status === 403 || response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), nowMs);
      const schedule = response.status === 403 ? FORBIDDEN_BACKOFF_MS : RATE_LIMIT_BACKOFF_MS;
      const index = Math.min(schedule.length - 1, Math.max(0, failureCount - 1));
      const configured = failureCount >= CIRCUIT_FAILURE_COUNT
        ? Math.max(CIRCUIT_BACKOFF_MS, schedule[index])
        : schedule[index];
      return Math.max(configured, retryAfterMs);
    }

    return response.status >= 500 ? resolveTransientBackoffMs(failureCount) : undefined;
  }
};

/** 在业务无关的作用域中执行请求去重、熔断判断和半开探测。 */
export class RequestCircuitBreaker {
  private readonly states = new Map<string, RequestCircuitState>();
  private readonly inFlightRequests = new Map<string, Promise<Response>>();
  private readonly halfOpenProbes = new Set<string>();
  private readonly stateMutationQueues = new Map<string, Promise<void>>();
  private readonly storeStateKeys = new WeakMap<object, Set<string>>();
  private readonly now: () => number;
  private readonly policy: RequestCircuitBreakerPolicy;

  /** 创建可注入时钟和退避策略的请求熔断器。 */
  constructor(options: RequestCircuitBreakerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.policy = options.policy ?? defaultHttpCircuitBreakerPolicy;
  }

  /** 执行受保护请求；相同 requestKey 的并发请求只访问网络一次。 */
  async execute(
    target: RequestCircuitTarget,
    input: string | URL,
    operation: () => Promise<Response>,
    options: RequestCircuitExecutionOptions = {}
  ): Promise<Response> {
    const dedupeKey = options.requestKey ? `${target.key}:${options.requestKey}` : undefined;
    const existing = dedupeKey ? this.inFlightRequests.get(dedupeKey) : undefined;
    if (existing) {
      logger.info("相同网络请求已合并", { target: target.key, host: safeHost(input.toString()) });
      return (await existing).clone();
    }

    const request = this.executeOnce(target, input.toString(), operation, options.stateStore);
    if (dedupeKey) {
      this.inFlightRequests.set(dedupeKey, request);
    }
    try {
      return (await request).clone();
    } finally {
      if (dedupeKey) {
        this.inFlightRequests.delete(dedupeKey);
      }
    }
  }

  /** 返回目标当前状态，供限频和状态展示复用。 */
  async getState(
    target: RequestCircuitTarget,
    stateStore?: RequestCircuitStateStore
  ): Promise<RequestCircuitState> {
    const states = await this.loadStates(stateStore);
    return states.find((state) => state.key === target.key) ?? createEmptyState(target);
  }

  /** 执行单次熔断校验、请求和状态更新。 */
  private async executeOnce(
    target: RequestCircuitTarget,
    url: string,
    operation: () => Promise<Response>,
    stateStore?: RequestCircuitStateStore
  ): Promise<Response> {
    const host = safeHost(url);
    const relatedStates = await this.getRelatedStates(target, host, stateStore);
    const blockedUntilMs = relatedStates.reduce(
      (latest, state) => Math.max(latest, parseTime(state.backoffUntil)),
      0
    );
    if (blockedUntilMs > this.now()) {
      const seconds = Math.max(1, Math.ceil((blockedUntilMs - this.now()) / 1000));
      throw new RequestCircuitOpenError(
        `${target.name} 正在熔断保护中，请 ${seconds} 秒后重试`,
        target,
        new Date(blockedUntilMs).toISOString()
      );
    }

    const halfOpen = relatedStates.some((state) => state.failureCount > 0 && Boolean(state.backoffUntil));
    const probeKey = `${target.group}:${host}`;
    if (halfOpen && this.halfOpenProbes.has(probeKey)) {
      throw new RequestCircuitOpenError(`${target.name} 正在执行熔断恢复探测，请稍后重试`, target);
    }
    if (halfOpen) {
      this.halfOpenProbes.add(probeKey);
    }

    const startedAtMs = this.now();
    try {
      const response = await operation();
      const result = await this.enqueueStateMutation(target.key, () =>
        this.recordResponse(target, host, response, startedAtMs, stateStore)
      );
      if (halfOpen && result === "success") {
        await this.resetRelatedStates(relatedStates, target.key, startedAtMs, stateStore);
      }
      return response;
    } catch (error) {
      if (!(error instanceof RequestCircuitOpenError)) {
        await this.enqueueStateMutation(target.key, () => this.recordError(target, host, error, stateStore));
      }
      throw error;
    } finally {
      if (halfOpen) {
        this.halfOpenProbes.delete(probeKey);
      }
    }
  }

  /** 根据 HTTP 响应更新成功或失败状态。 */
  private async recordResponse(
    target: RequestCircuitTarget,
    host: string,
    response: Response,
    startedAtMs: number,
    stateStore?: RequestCircuitStateStore
  ): Promise<"failure" | "success" | "stale"> {
    const current = await this.getState(target, stateStore);
    const nowMs = this.now();
    const failureCount = current.failureCount + 1;
    const backoffMs = this.policy.resolveBackoffMs({
      kind: "response",
      response,
      failureCount,
      nowMs
    });
    if (backoffMs === undefined) {
      if (parseTime(current.backoffUntil) > startedAtMs) {
        logger.info("较早发出的成功请求未覆盖新熔断状态", {
          target: target.key,
          host
        });
        return "stale";
      }
      await this.saveState({
        ...current,
        group: target.group,
        requestHost: host,
        lastRequestAt: new Date(nowMs).toISOString(),
        failureCount: 0,
        backoffUntil: undefined
      }, stateStore);
      return "success";
    }

    await this.saveFailureState(target, current, host, failureCount, backoffMs, stateStore);
    logger.warn("网络请求熔断器已开启", {
      target: target.key,
      host,
      status: response.status,
      failureCount,
      backoffMs
    });
    return "failure";
  }

  /** 根据网络异常更新退避状态。 */
  private async recordError(
    target: RequestCircuitTarget,
    host: string,
    error: unknown,
    stateStore?: RequestCircuitStateStore
  ): Promise<void> {
    const current = await this.getState(target, stateStore);
    const failureCount = current.failureCount + 1;
    const backoffMs = this.policy.resolveBackoffMs({
      kind: "error",
      error,
      failureCount,
      nowMs: this.now()
    });
    if (backoffMs === undefined) {
      return;
    }
    await this.saveFailureState(target, current, host, failureCount, backoffMs, stateStore);
    logger.warn("网络异常已触发请求退避", {
      target: target.key,
      host,
      failureCount,
      backoffMs,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  /** 持久化一次失败及其退避截止时间。 */
  private async saveFailureState(
    target: RequestCircuitTarget,
    current: RequestCircuitState,
    host: string,
    failureCount: number,
    backoffMs: number,
    stateStore?: RequestCircuitStateStore
  ): Promise<void> {
    const nowMs = this.now();
    await this.saveState({
      ...current,
      group: target.group,
      requestHost: host,
      lastRequestAt: new Date(nowMs).toISOString(),
      failureCount,
      backoffUntil: new Date(nowMs + backoffMs).toISOString()
    }, stateStore);
  }

  /** 读取目标及同组同域的关联熔断状态。 */
  private async getRelatedStates(
    target: RequestCircuitTarget,
    host: string,
    stateStore?: RequestCircuitStateStore
  ): Promise<RequestCircuitState[]> {
    const states = await this.loadStates(stateStore);
    const related = states.filter((state) =>
      state.key === target.key
      || (target.shareByHost === true && state.group === target.group && state.requestHost === host)
    );
    return related.length ? related : [createEmptyState(target)];
  }

  /** 合并持久化状态，并在外部清空后同步清理缓存。 */
  private async loadStates(stateStore?: RequestCircuitStateStore): Promise<RequestCircuitState[]> {
    if (stateStore) {
      try {
        const persistedStates = await stateStore.listRequestCircuitStates();
        const persistedKeys = new Set(persistedStates.map((state) => state.key));
        const previousKeys = this.storeStateKeys.get(stateStore as object) ?? new Set<string>();
        for (const key of previousKeys) {
          if (!persistedKeys.has(key)) {
            this.states.delete(key);
          }
        }
        for (const state of persistedStates) {
          this.states.set(state.key, state);
        }
        this.storeStateKeys.set(stateStore as object, persistedKeys);
      } catch (error) {
        logger.warn("网络熔断状态读取失败，改用进程内状态", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return [...this.states.values()];
  }

  /** 保存进程内状态，并尽力同步到持久化仓库。 */
  private async saveState(state: RequestCircuitState, stateStore?: RequestCircuitStateStore): Promise<void> {
    this.states.set(state.key, state);
    if (!stateStore) {
      return;
    }
    try {
      await stateStore.upsertRequestCircuitState(state);
      const keys = this.storeStateKeys.get(stateStore as object) ?? new Set<string>();
      keys.add(state.key);
      this.storeStateKeys.set(stateStore as object, keys);
    } catch (error) {
      logger.warn("网络熔断状态保存失败，已保留进程内状态", {
        target: state.key,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** 半开探测成功后重置未被新请求更新的关联状态。 */
  private async resetRelatedStates(
    states: RequestCircuitState[],
    currentKey: string,
    probeStartedAtMs: number,
    stateStore?: RequestCircuitStateStore
  ): Promise<void> {
    for (const state of states) {
      if (state.key === currentKey || state.failureCount === 0) {
        continue;
      }
      await this.enqueueStateMutation(state.key, async () => {
        const latest = (await this.loadStates(stateStore)).find((item) => item.key === state.key) ?? state;
        if (parseTime(latest.backoffUntil) > probeStartedAtMs) {
          logger.info("半开探测未清除较新的同域熔断状态", {
            target: state.key,
            backoffUntil: latest.backoffUntil
          });
          return;
        }
        await this.saveState({ ...latest, failureCount: 0, backoffUntil: undefined }, stateStore);
      });
    }
  }

  /** 串行更新单个目标状态，避免并发响应丢失失败次数或覆盖新状态。 */
  private async enqueueStateMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.stateMutationQueues.get(key) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    this.stateMutationQueues.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      resolveCurrent();
      if (this.stateMutationQueues.get(key) === current) {
        this.stateMutationQueues.delete(key);
      }
    }
  }
}

export const defaultRequestCircuitBreaker = new RequestCircuitBreaker();

/** 判断仓库是否提供通用熔断状态持久化能力。 */
export function supportsRequestCircuitStateStore(value: unknown): value is RequestCircuitStateStore {
  const candidate = value as Partial<RequestCircuitStateStore> | null | undefined;
  return typeof candidate?.listRequestCircuitStates === "function"
    && typeof candidate.upsertRequestCircuitState === "function";
}

/** 为 fetch 选项生成稳定去重键，仅序列化可安全比较的请求体。 */
export function buildHttpRequestKey(input: string | URL, options: RequestInit = {}): string {
  const headers = [...new Headers(options.headers).entries()].sort(([left], [right]) => left.localeCompare(right));
  const body = typeof options.body === "string"
    ? options.body
    : options.body instanceof URLSearchParams
      ? options.body.toString()
      : undefined;
  return JSON.stringify([options.method ?? "GET", input.toString(), headers, body]);
}

/** 创建尚无失败记录的目标状态。 */
function createEmptyState(target: RequestCircuitTarget): RequestCircuitState {
  return { key: target.key, group: target.group, failureCount: 0 };
}

/** 按连续失败次数计算瞬时故障退避时间。 */
function resolveTransientBackoffMs(failureCount: number): number {
  if (failureCount >= CIRCUIT_FAILURE_COUNT) {
    return CIRCUIT_BACKOFF_MS;
  }
  return TRANSIENT_BACKOFF_MS[Math.min(TRANSIENT_BACKOFF_MS.length - 1, Math.max(0, failureCount - 1))];
}

/** 解析 Retry-After 秒数或 HTTP 日期。 */
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

/** 安全提取请求域名，非法地址统一归入 unknown。 */
function safeHost(value: string): string {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "unknown";
  }
}

/** 将可选 ISO 时间转换为时间戳。 */
function parseTime(value?: string): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}
