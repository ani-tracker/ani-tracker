import type { AppDataFile } from "@shared/persistence/app-data";
import type { DashboardData } from "@shared/domain";
import { defaultSourceConfigs } from "../sources/default-source-configs";
import { APP_DATA_VERSION } from "@shared/persistence/app-data";
import { createDefaultSettingsProvider, type DefaultSettingsProvider } from "../platform/default-settings-provider";

export function createSeedData(settingsProvider: DefaultSettingsProvider = createDefaultSettingsProvider()): AppDataFile {
  return {
    version: APP_DATA_VERSION,
    settings: settingsProvider.getSettings(),
    animeCatalog: [],
    myAnime: [],
    episodes: [],
    episodePreferences: [],
    fansubGroups: [],
    sources: defaultSourceConfigs,
    downloads: [],
    mediaFiles: [],
    notifications: [],
    dashboard: createEmptyDashboard(),
    updatedAt: new Date().toISOString()
  };
}

/** 创建不含演示业务数据的首次启动首页状态。 */
function createEmptyDashboard(): DashboardData {
  return {
    dailyReminder: {
      date: new Date().toISOString().slice(0, 10),
      total: 0,
      upcoming: 0,
      aired: 0,
      downloading: 0,
      downloaded: 0,
      items: []
    },
    todayEpisodes: [],
    pendingActions: [],
    activeDownloads: [],
    recentCompleted: [],
    weeklySchedule: [],
    sourceHealth: []
  };
}
