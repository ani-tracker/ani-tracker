import type { AppClient } from "@shared/app-client";

const REMOTE_METHODS = new Set([
  "getDashboard",
  "listNotifications",
  "getUnreadNotificationCount",
  "markNotificationRead",
  "markAllNotificationsRead",
  "listMyAnime",
  "upsertMyAnime",
  "removeMyAnime",
  "listMyAnimeWatchProgress",
  "setAnimeWatchProgress",
  "reportPlaybackProgress",
  "savePlaybackCheckpoint",
  "listAnimeCatalog",
  "getAnimeDetail",
  "searchAnimeCatalog",
  "listFansubs",
  "listEpisodes",
  "upsertEpisode",
  "listEpisodePreferences",
  "upsertEpisodePreference",
  "removeEpisodePreference",
  "previewEpisodeReleases",
  "searchReleases",
  "searchAnimeReleases",
  "searchRssSubscriptionReleases",
  "getAnimeSourceBindingState",
  "confirmAnimeSourceBinding",
  "reportAnimeSourceCandidateMismatch",
  "removeAnimeSourceCandidateMismatch",
  "setAnimeSourceExcluded",
  "removeAnimeSourceBinding",
  "listDownloads",
  "refreshDownloads",
  "pauseDownload",
  "resumeDownload",
  "removeDownload",
  "setDownloadFilePriority",
  "addDownloadUrl",
  "addReleaseDownload",
  "listSources",
  "setSourceEnabled",
  "upsertSource",
  "getSourceSyncStatus",
  "getSettings",
  "updateSettings",
  "getAutomationSchedulerStatus",
  "getQbittorrentManagedStatus",
  "startQbittorrentManaged",
  "stopQbittorrentManaged",
  "getEmbeddedTorrentStatus",
  "startEmbeddedTorrent",
  "stopEmbeddedTorrent",
  "restartEmbeddedTorrent"
]);

export type RemoteClientInvoker = (method: string, args: unknown[]) => Promise<unknown>;

/** 创建只开放远程白名单方法的 HTTP 客户端。 */
export function createRemoteClient(invoke: RemoteClientInvoker): AppClient {
  return new Proxy({ platform: "remote" } as AppClient, {
    get(target, property) {
      if (property === "platform") {
        return target.platform;
      }
      if (typeof property !== "string") {
        return undefined;
      }
      if (!REMOTE_METHODS.has(property)) {
        return async () => {
          throw new Error("当前远程客户端未开放此功能");
        };
      }
      return (...args: unknown[]) => invoke(property, args);
    }
  });
}
