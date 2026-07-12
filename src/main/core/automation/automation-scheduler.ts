import type { AutomationRunResult, AutomationSchedulerStatus } from "@shared/contracts";
import type { AppRepository } from "../repositories/app-repository";
import { DesktopNotificationService } from "../platform/desktop-notification-service";
import { AutomationRunService } from "./automation-run-service";

const MIN_INTERVAL_MINUTES = 5;

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private enabled = false;
  private intervalMinutes = MIN_INTERVAL_MINUTES;
  private nextRunAt: string | undefined;
  private lastRunAt: string | undefined;
  private lastResult: AutomationRunResult | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly repository: AppRepository,
    private readonly notificationService = new DesktopNotificationService()
  ) {}

  async start(): Promise<AutomationSchedulerStatus> {
    const settings = await this.repository.getSettings();
    this.enabled = settings.automation.scheduledCheckEnabled;
    this.intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, settings.automation.checkIntervalMinutes);

    this.clearTimer();
    if (this.enabled) {
      this.scheduleNext();
    }

    return this.getStatus();
  }

  async restart(): Promise<AutomationSchedulerStatus> {
    this.stop();
    return this.start();
  }

  stop(): AutomationSchedulerStatus {
    this.enabled = false;
    this.clearTimer();
    return this.getStatus();
  }

  async runNow(): Promise<AutomationRunResult> {
    if (this.inFlight) {
      throw new Error("自动扫描正在运行");
    }

    this.inFlight = true;
    this.lastError = undefined;

    try {
      const result = await new AutomationRunService(this.repository).runOnce();
      const settings = await this.repository.getSettings();
      this.lastRunAt = result.finishedAt;
      this.lastResult = result;
      this.notificationService.notifyAutomationResult(result, settings);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动扫描失败";
      const settings = await this.repository.getSettings();
      this.lastError = message;
      this.notificationService.notifySchedulerError(message, settings);
      throw error;
    } finally {
      this.inFlight = false;
      if (this.enabled) {
        this.scheduleNext();
      }
    }
  }

  getStatus(): AutomationSchedulerStatus {
    return {
      enabled: this.enabled,
      running: Boolean(this.timer),
      inFlight: this.inFlight,
      intervalMinutes: this.intervalMinutes,
      nextRunAt: this.nextRunAt,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError
    };
  }

  private scheduleNext(): void {
    this.clearTimer();
    const delayMs = this.intervalMinutes * 60 * 1000;
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      void this.runScheduled();
    }, delayMs);
  }

  private async runScheduled(): Promise<void> {
    try {
      await this.runNow();
    } catch {
      if (this.enabled && !this.timer) {
        this.scheduleNext();
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = undefined;
  }
}
