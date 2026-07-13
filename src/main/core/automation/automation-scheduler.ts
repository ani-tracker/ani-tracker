import type { AutomationRunResult, AutomationSchedulerStatus } from "@shared/contracts";
import type { NotificationRecord } from "@shared/domain";
import { logger } from "../logger";
import type { AppRepository } from "../repositories/app-repository";
import { DesktopNotificationService } from "../platform/desktop-notification-service";
import { AutomationRunService, type AutomationRunServiceOptions } from "./automation-run-service";

const MIN_INTERVAL_MINUTES = 5;
const MANUAL_RUN_COOLDOWN_MS = 60_000;

interface AutomationRunOptions {
  trigger?: "manual" | "scheduled" | "tray";
  ignoreCooldown?: boolean;
}

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private enabled = false;
  private intervalMinutes = MIN_INTERVAL_MINUTES;
  private nextRunAt: string | undefined;
  private lastManualRunAtMs: number | undefined;
  private lastRunAt: string | undefined;
  private lastResult: AutomationRunResult | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly repository: AppRepository,
    private readonly notificationService = new DesktopNotificationService(),
    private readonly runServiceOptions: AutomationRunServiceOptions = {}
  ) {}

  async start(): Promise<AutomationSchedulerStatus> {
    const settings = await this.repository.getSettings();
    this.enabled = settings.automation.scheduledCheckEnabled;
    this.intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, settings.automation.checkIntervalMinutes);

    this.clearTimer();
    if (this.enabled) {
      this.scheduleNext();
    }

    logger.info("Automation scheduler started", {
      enabled: this.enabled,
      intervalMinutes: this.intervalMinutes,
      nextRunAt: this.nextRunAt
    });

    return this.getStatus();
  }

  async restart(): Promise<AutomationSchedulerStatus> {
    this.stop();
    return this.start();
  }

  stop(): AutomationSchedulerStatus {
    this.enabled = false;
    this.clearTimer();
    logger.info("Automation scheduler stopped");
    return this.getStatus();
  }

  async runNow(options: AutomationRunOptions = {}): Promise<AutomationRunResult> {
    if (this.inFlight) {
      throw new Error("自动扫描正在运行");
    }

    const trigger = options.trigger ?? "manual";
    if (!options.ignoreCooldown && trigger !== "scheduled") {
      const cooldownMs = this.getManualCooldownRemainingMs();
      if (cooldownMs > 0) {
        const seconds = Math.ceil(cooldownMs / 1000);
        const message = `扫描过于频繁，请 ${seconds} 秒后再试`;
        this.lastError = message;
        logger.warn("Automation run skipped by manual cooldown", {
          trigger,
          cooldownUntil: this.getManualCooldownUntil()
        });
        throw new Error(message);
      }

      this.lastManualRunAtMs = Date.now();
    }

    this.inFlight = true;
    this.lastError = undefined;

    try {
      logger.info("Automation run started", { trigger });
      const result = await new AutomationRunService(this.repository, this.runServiceOptions).runOnce();
      const settings = await this.repository.getSettings();
      this.lastRunAt = result.finishedAt;
      this.lastResult = result;
      await this.repository.addNotifications(createAutomationNotifications(result));
      this.notificationService.notifyAutomationResult(result, settings);
      logger.info("Automation run finished", {
        trigger,
        checkedEpisodes: result.checkedEpisodes,
        downloaded: result.downloaded.length,
        skipped: result.skipped.length,
        errors: result.errors.length
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动扫描失败";
      const settings = await this.repository.getSettings();
      this.lastError = message;
      this.notificationService.notifySchedulerError(message, settings);
      logger.error("Automation run failed", { message });
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
      manualCooldownUntil: this.getManualCooldownUntil(),
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError
    };
  }

  private scheduleNext(): void {
    this.clearTimer();
    const delayMs = this.intervalMinutes * 60 * 1000;
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    logger.info("Automation scheduler next run scheduled", {
      nextRunAt: this.nextRunAt,
      intervalMinutes: this.intervalMinutes
    });
    this.timer = setTimeout(() => {
      void this.runScheduled();
    }, delayMs);
  }

  private async runScheduled(): Promise<void> {
    this.timer = null;
    this.nextRunAt = undefined;

    try {
      await this.runNow({
        trigger: "scheduled",
        ignoreCooldown: true
      });
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

  private getManualCooldownRemainingMs(): number {
    if (!this.lastManualRunAtMs) {
      return 0;
    }

    return Math.max(0, this.lastManualRunAtMs + MANUAL_RUN_COOLDOWN_MS - Date.now());
  }

  private getManualCooldownUntil(): string | undefined {
    const remainingMs = this.getManualCooldownRemainingMs();
    if (!remainingMs || !this.lastManualRunAtMs) {
      return undefined;
    }

    return new Date(this.lastManualRunAtMs + MANUAL_RUN_COOLDOWN_MS).toISOString();
  }
}

function createAutomationNotifications(result: AutomationRunResult): NotificationRecord[] {
  const createdAt = result.finishedAt;
  const records: NotificationRecord[] = [];

  for (const item of result.downloaded) {
    records.push({
      id: `notification-${createdAt}-${item.downloadTaskId}`,
      kind: "automation",
      title: `已添加下载：${item.animeTitle}`,
      body: `第 ${item.episodeNo} 集已匹配资源「${item.releaseTitle}」。`,
      severity: "success",
      animeId: item.animeId,
      episodeId: item.episodeId,
      downloadTaskId: item.downloadTaskId,
      createdAt
    });
  }

  for (const item of result.errors) {
    records.push({
      id: `notification-${createdAt}-error-${item.episodeId ?? item.animeId ?? records.length}`,
      kind: "automation",
      title: item.animeTitle ? `扫描失败：${item.animeTitle}` : "自动扫描失败",
      body: item.episodeNo ? `第 ${item.episodeNo} 集：${item.message}` : item.message,
      severity: "error",
      animeId: item.animeId,
      episodeId: item.episodeId,
      createdAt
    });
  }

  if (!records.length && result.checkedEpisodes > 0) {
    records.push({
      id: `notification-${createdAt}-summary`,
      kind: "automation",
      title: "自动扫描完成",
      body: `已检查 ${result.checkedEpisodes} 集，没有新增下载任务。`,
      severity: "info",
      createdAt
    });
  }

  return records;
}
