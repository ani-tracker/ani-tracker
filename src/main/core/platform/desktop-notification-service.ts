import { Notification } from "electron";
import type { AutomationRunResult } from "@shared/contracts";
import type { AppSettings, NotificationRecord } from "@shared/domain";

export class DesktopNotificationService {
  notifyAutomationResult(result: AutomationRunResult, settings: AppSettings): void {
    if (!settings.automation.notifyOnNewEpisode || !Notification.isSupported()) {
      return;
    }

    const downloadedCount = result.downloaded.length;
    const errorCount = result.errors.length;
    if (downloadedCount === 0 && errorCount === 0) {
      return;
    }

    const bodyParts = [];
    if (downloadedCount > 0) {
      bodyParts.push(`已添加 ${downloadedCount} 个下载任务`);
    }
    if (errorCount > 0) {
      bodyParts.push(`${errorCount} 个任务失败`);
    }

    new Notification({
      title: "追番更新扫描完成",
      body: bodyParts.join("，")
    }).show();
  }

  notifySchedulerError(message: string, settings: AppSettings): void {
    if (!settings.automation.notifyOnNewEpisode || !Notification.isSupported()) {
      return;
    }

    new Notification({
      title: "追番更新扫描失败",
      body: message
    }).show();
  }

  notifyReminder(record: NotificationRecord, settings: AppSettings): void {
    if (!settings.automation.notifyOnNewEpisode || !Notification.isSupported()) {
      return;
    }

    new Notification({
      title: record.title,
      body: record.body
    }).show();
  }
}
