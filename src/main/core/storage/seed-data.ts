import type { AppDataFile } from "@shared/persistence/app-data";
import {
  appSettings,
  dashboard,
  downloadTasks,
  episodePreferences,
  episodes,
  fansubGroups,
  myAnime,
  recentCompleted,
  sourceConfigs
} from "../mock-data";
import { APP_DATA_VERSION } from "@shared/persistence/app-data";

export function createSeedData(): AppDataFile {
  return {
    version: APP_DATA_VERSION,
    settings: appSettings,
    myAnime,
    episodes,
    episodePreferences,
    fansubGroups,
    sources: sourceConfigs,
    downloads: downloadTasks,
    mediaFiles: recentCompleted,
    dashboard,
    updatedAt: new Date().toISOString()
  };
}
