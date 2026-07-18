import type { SourceSyncRunResult, SourceSyncSchedulerStatus } from "@shared/contracts";
import { logger } from "../logger";
import type { AppRepository } from "../repositories/app-repository";
import { SourceSyncService } from "./source-sync-service";

const DEFAULT_DAILY_TIME = "09:00";

/** 每天定时执行来源增量同步，并在当天未同步时启动补跑。 */
export class SourceSyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private enabled = false;
  private inFlight = false;
  private dailyTime = DEFAULT_DAILY_TIME;
  private nextRunAt: string | undefined;
  private lastRunAt: string | undefined;
  private lastResult: SourceSyncRunResult | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly repository: AppRepository,
    private readonly syncService = new SourceSyncService(repository)
  ) {}

  async start(): Promise<SourceSyncSchedulerStatus> {
    const settings = await this.repository.getSettings();
    this.enabled = settings.sourceSync?.enabled ?? true;
    this.dailyTime = normalizeDailyTime(settings.sourceSync?.dailyTime);
    this.clearTimer();
    if (!this.enabled) {
      return this.getStatus();
    }
    this.scheduleNext();
    void this.runNow({ force: false, trigger: "startup" }).catch((error: unknown) => {
      logger.error("启动补跑下载源同步失败", { message: getErrorMessage(error) });
    });
    logger.info("下载源每日同步调度器已启动", { dailyTime: this.dailyTime, nextRunAt: this.nextRunAt });
    return this.getStatus();
  }

  async restart(): Promise<SourceSyncSchedulerStatus> {
    this.stop();
    return this.start();
  }

  stop(): SourceSyncSchedulerStatus {
    this.enabled = false;
    this.clearTimer();
    return this.getStatus();
  }

  async runNow(options: { force?: boolean; trigger?: "manual" | "startup" | "scheduled" } = {}): Promise<SourceSyncRunResult> {
    if (this.inFlight) {
      throw new Error("下载源增量同步正在运行");
    }
    this.inFlight = true;
    this.lastError = undefined;
    try {
      logger.info("下载源增量同步开始", { trigger: options.trigger ?? "manual", force: options.force ?? true });
      const result = await this.syncService.run({ force: options.force ?? true });
      this.lastRunAt = result.finishedAt;
      this.lastResult = result;
      return result;
    } catch (error) {
      this.lastError = getErrorMessage(error);
      throw error;
    } finally {
      this.inFlight = false;
      if (this.enabled) {
        this.scheduleNext();
      }
    }
  }

  getStatus(): SourceSyncSchedulerStatus {
    return {
      enabled: this.enabled,
      running: Boolean(this.timer),
      inFlight: this.inFlight,
      dailyTime: this.dailyTime,
      nextRunAt: this.nextRunAt,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError
    };
  }

  private scheduleNext(): void {
    this.clearTimer();
    const next = resolveNextRunAt(new Date(), this.dailyTime);
    this.nextRunAt = next.toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow({ force: false, trigger: "scheduled" }).catch((error: unknown) => {
        logger.error("定时下载源同步失败", { message: getErrorMessage(error) });
      });
    }, Math.max(1_000, next.getTime() - Date.now()));
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = undefined;
  }
}

export function normalizeDailyTime(value?: string): string {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? "") ? value! : DEFAULT_DAILY_TIME;
}

export function resolveNextRunAt(now: Date, dailyTime: string): Date {
  const [hours, minutes] = normalizeDailyTime(dailyTime).split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
