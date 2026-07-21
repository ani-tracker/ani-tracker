import { logger } from "../logger";

export const ANILIST_PAGE_LIMIT = 50;
export const ANILIST_REQUEST_LIMIT_PER_MINUTE = 90;
const ANILIST_RATE_WINDOW_MS = 60_000;

export interface AniListRequestSchedulerOptions {
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  requestLimit?: number;
  windowMs?: number;
}

/** 串行调度所有 AniList 请求，并同时遵循本地预算与服务端速率响应头。 */
export class AniListRequestScheduler {
  private tail: Promise<void> = Promise.resolve();
  private readonly requestTimestamps: number[] = [];
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly configuredLimit: number;
  private readonly windowMs: number;
  private serverLimit: number;
  private cooldownUntilMs = 0;

  constructor(options: AniListRequestSchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? wait;
    this.configuredLimit = normalizePositiveInteger(
      options.requestLimit,
      ANILIST_REQUEST_LIMIT_PER_MINUTE
    );
    this.windowMs = normalizePositiveInteger(options.windowMs, ANILIST_RATE_WINDOW_MS);
    this.serverLimit = this.configuredLimit;
  }

  /** 等待共享预算后执行一次 AniList 请求，并记录最新响应头。 */
  async schedule(operation: () => Promise<Response>): Promise<Response> {
    let resolveResult!: (response: Response) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<Response>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.waitForBudget();
          this.recordRequestStart();
          const response = await operation();
          this.updateFromResponse(response);
          resolveResult(response);
        } catch (error) {
          rejectResult(error);
        }
      });

    return result;
  }

  /** 等待冷却截止时间或滚动窗口释放请求名额。 */
  private async waitForBudget(): Promise<void> {
    this.pruneRequestTimestamps();
    const effectiveLimit = Math.max(1, Math.min(this.configuredLimit, this.serverLimit));
    const budgetAvailableAt = this.requestTimestamps.length >= effectiveLimit
      ? this.requestTimestamps[this.requestTimestamps.length - effectiveLimit] + this.windowMs
      : 0;
    const waitUntilMs = Math.max(this.cooldownUntilMs, budgetAvailableAt);
    const delayMs = Math.max(0, waitUntilMs - this.now());
    if (delayMs > 0) {
      logger.info("AniList 请求等待速率预算", {
        delayMs,
        effectiveLimit,
        queuedRequestCount: this.requestTimestamps.length
      });
      await this.sleep(delayMs);
      this.pruneRequestTimestamps();
    }
  }

  /** 记录实际开始的请求，网络失败同样占用服务端配额预算。 */
  private recordRequestStart(): void {
    this.requestTimestamps.push(this.now());
  }

  /** 根据 AniList 响应头收紧配额，并在 429 或余额耗尽时设置冷却。 */
  private updateFromResponse(response: Response): void {
    const nowMs = this.now();
    const reportedLimit = parseNonNegativeInteger(response.headers.get("x-ratelimit-limit"));
    if (reportedLimit && reportedLimit > 0) {
      this.serverLimit = Math.min(this.configuredLimit, reportedLimit);
    }

    const remaining = parseNonNegativeInteger(response.headers.get("x-ratelimit-remaining"));
    const resetAtMs = parseResetAtMs(response.headers.get("x-ratelimit-reset"));
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), nowMs);
    if (response.status === 429) {
      this.cooldownUntilMs = Math.max(
        this.cooldownUntilMs,
        resetAtMs ?? 0,
        retryAfterMs ? nowMs + retryAfterMs : nowMs + this.windowMs
      );
    } else if (remaining === 0) {
      this.cooldownUntilMs = Math.max(
        this.cooldownUntilMs,
        resetAtMs ?? nowMs + this.windowMs
      );
    }

    if (this.cooldownUntilMs > nowMs) {
      logger.warn("AniList 速率配额已进入冷却", {
        status: response.status,
        remaining,
        cooldownUntil: new Date(this.cooldownUntilMs).toISOString()
      });
    }
  }

  /** 清理滚动时间窗外的请求记录。 */
  private pruneRequestTimestamps(): void {
    const threshold = this.now() - this.windowMs;
    while (this.requestTimestamps.length && this.requestTimestamps[0] <= threshold) {
      this.requestTimestamps.shift();
    }
  }
}

export const defaultAniListRequestScheduler = new AniListRequestScheduler();

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** AniList 的 reset 为 Unix 秒时间戳，同时兼容毫秒时间戳。 */
function parseResetAtMs(value: string | null): number | undefined {
  const parsed = parseNonNegativeInteger(value);
  if (parsed === undefined) {
    return undefined;
  }
  return parsed >= 1_000_000_000_000 ? parsed : parsed * 1000;
}

/** 解析 Retry-After 秒数或 HTTP 日期。 */
function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : undefined;
}

function wait(delayMs: number): Promise<void> {
  return delayMs <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, delayMs));
}
