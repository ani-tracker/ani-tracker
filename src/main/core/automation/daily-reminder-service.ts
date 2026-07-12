import type { DashboardData, NotificationRecord } from "@shared/domain";
import { logger } from "../logger";
import { DesktopNotificationService } from "../platform/desktop-notification-service";
import type { AppRepository } from "../repositories/app-repository";

export class DailyReminderService {
  constructor(
    private readonly repository: AppRepository,
    private readonly notificationService = new DesktopNotificationService()
  ) {}

  async runOnce(): Promise<NotificationRecord | null> {
    const dashboard = await this.repository.getDashboard();
    const summary = dashboard.dailyReminder;

    if (!summary.total) {
      logger.info("Daily reminder skipped because there are no followed episodes today", {
        date: summary.date
      });
      return null;
    }

    const notificationId = `notification-daily-reminder-${summary.date}`;
    const existing = await this.repository.listNotifications();
    if (existing.some((item) => item.id === notificationId)) {
      logger.info("Daily reminder skipped because it already exists", {
        date: summary.date
      });
      return null;
    }

    const record: NotificationRecord = {
      id: notificationId,
      kind: "reminder",
      title: "今日追番提醒",
      body: buildReminderBody(summary),
      severity: summary.aired > 0 || summary.downloading > 0 ? "success" : "info",
      createdAt: new Date().toISOString()
    };
    await this.repository.addNotifications([record]);

    const settings = await this.repository.getSettings();
    this.notificationService.notifyReminder(record, settings);
    logger.info("Daily reminder created", {
      date: summary.date,
      total: summary.total,
      aired: summary.aired,
      downloading: summary.downloading,
      downloaded: summary.downloaded
    });

    return record;
  }
}

function buildReminderBody(summary: DashboardData["dailyReminder"]): string {
  const parts = [`今日 ${summary.total} 部追番更新`];

  if (summary.upcoming) {
    parts.push(`${summary.upcoming} 部待播`);
  }
  if (summary.aired) {
    parts.push(`${summary.aired} 部待处理`);
  }
  if (summary.downloading) {
    parts.push(`${summary.downloading} 部下载中`);
  }
  if (summary.downloaded) {
    parts.push(`${summary.downloaded} 部已完成`);
  }

  return parts.join("，");
}
