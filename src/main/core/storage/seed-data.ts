import type { AppDataFile } from "@shared/persistence/app-data";
import {
  animeCatalog,
  dashboard,
  downloadTasks,
  episodePreferences,
  episodes,
  fansubGroups,
  myAnime,
  notifications,
  recentCompleted,
  sourceConfigs
} from "../mock-data";
import { APP_DATA_VERSION } from "@shared/persistence/app-data";
import { createDefaultSettingsProvider, type DefaultSettingsProvider } from "../platform/default-settings-provider";

export function createSeedData(settingsProvider: DefaultSettingsProvider = createDefaultSettingsProvider()): AppDataFile {
  return {
    version: APP_DATA_VERSION,
    settings: settingsProvider.getSettings(),
    animeCatalog,
    myAnime,
    episodes,
    episodePreferences,
    fansubGroups,
    sources: sourceConfigs,
    downloads: downloadTasks,
    mediaFiles: recentCompleted,
    notifications,
    dashboard,
    updatedAt: new Date().toISOString()
  };
}
