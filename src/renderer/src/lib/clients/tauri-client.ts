import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppClient } from "@shared/app-client";
import type {
  AnimeDetailResult,
  AnimeDiscoverySearchResult,
  AnimeWatchProgress,
  AppWindowState,
  PlaybackCheckpoint,
  ReportPlaybackProgressInput,
  SavePlaybackCheckpointInput,
  SetAnimeWatchProgressInput
} from "@shared/contracts";
import type {
  Anime,
  AppSettings,
  DashboardData,
  Episode,
  EpisodePreference,
  FansubGroup,
  MyAnime,
  NotificationRecord,
  ReleaseSourceConfig
} from "@shared/domain";

const WINDOW_STATE_CHANGED_EVENT = "window-state-changed";

interface TauriCommandError {
  code?: string;
  message?: string;
}

type TauriClientPlatform = "tauri-desktop" | "android" | "ios";

/** 将 Tauri 拒绝值转换为可展示错误。 */
function normalizeTauriError(method: string, error: unknown): Error {
  if (error && typeof error === "object") {
    const commandError = error as TauriCommandError;
    if (commandError.message) {
      return new Error(commandError.message);
    }
  }
  return new Error(`Tauri 命令 ${method} 执行失败：${String(error)}`);
}

/** 封装 P1 已开放的 Tauri 平台命令与事件。 */
class TauriClientCore {
  /** 保存当前 Tauri 宿主对应的平台标识。 */
  constructor(readonly platform: TauriClientPlatform) {}

  /** 读取 Tauri 主窗口状态。 */
  async getWindowState(): Promise<AppWindowState> {
    return invoke<AppWindowState>("get_window_state").catch((error) => {
      throw normalizeTauriError("get_window_state", error);
    });
  }

  /** 最小化 Tauri 主窗口。 */
  async minimizeWindow(): Promise<void> {
    return invoke<void>("minimize_window").catch((error) => {
      throw normalizeTauriError("minimize_window", error);
    });
  }

  /** 切换 Tauri 主窗口最大化状态。 */
  async toggleMaximizeWindow(): Promise<AppWindowState> {
    return invoke<AppWindowState>("toggle_maximize_window").catch((error) => {
      throw normalizeTauriError("toggle_maximize_window", error);
    });
  }

  /** 关闭 Tauri 主窗口。 */
  async closeWindow(): Promise<void> {
    return invoke<void>("close_window").catch((error) => {
      throw normalizeTauriError("close_window", error);
    });
  }

  /** 订阅 Tauri 主窗口最大化状态变化。 */
  onWindowStateChanged(listener: (state: AppWindowState) => void): () => void {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<AppWindowState>(WINDOW_STATE_CHANGED_EVENT, (event) => listener(event.payload))
      .then((disposeListener) => {
        if (disposed) {
          disposeListener();
          return;
        }
        unlisten = disposeListener;
      })
      .catch((error) => {
        console.error("[tauri-client] 窗口状态订阅失败", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }

  /** 使用系统默认程序打开外部 HTTP 或 HTTPS 链接。 */
  async openExternal(url: string): Promise<void> {
    return invoke<void>("open_external", { url }).catch((error) => {
      throw normalizeTauriError("open_external", error);
    });
  }

  /** 从 Rust SQLite Repository 读取首页聚合数据。 */
  async getDashboard(): Promise<DashboardData> {
    return invoke<DashboardData>("get_dashboard").catch((error) => {
      throw normalizeTauriError("get_dashboard", error);
    });
  }

  /** 从 Rust SQLite Repository 读取当前平台设置。 */
  async getSettings(): Promise<AppSettings> {
    return invoke<AppSettings>("get_settings").catch((error) => {
      throw normalizeTauriError("get_settings", error);
    });
  }

  /** 递归合并应用设置，并由 Rust 保护宿主路径。 */
  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return invoke<AppSettings>("update_settings", { patch }).catch((error) => {
      throw normalizeTauriError("update_settings", error);
    });
  }

  /** 恢复当前 Tauri 平台默认设置。 */
  async resetSettingsToDefaults(): Promise<AppSettings> {
    return invoke<AppSettings>("reset_settings_to_defaults").catch((error) => {
      throw normalizeTauriError("reset_settings_to_defaults", error);
    });
  }

  /** 从 Rust SQLite Repository 读取提醒中心通知。 */
  async listNotifications(): Promise<NotificationRecord[]> {
    return invoke<NotificationRecord[]>("list_notifications").catch((error) => {
      throw normalizeTauriError("list_notifications", error);
    });
  }

  /** 从 Rust SQLite Repository 读取未读通知数量。 */
  async getUnreadNotificationCount(): Promise<number> {
    return invoke<number>("get_unread_notification_count").catch((error) => {
      throw normalizeTauriError("get_unread_notification_count", error);
    });
  }

  /** 从 Rust SQLite Repository 读取我的追番。 */
  async listMyAnime(): Promise<MyAnime[]> {
    return invoke<MyAnime[]>("list_my_anime").catch((error) => {
      throw normalizeTauriError("list_my_anime", error);
    });
  }

  /** 通过 Rust 事务新增或更新追番规则。 */
  async upsertMyAnime(item: MyAnime): Promise<MyAnime[]> {
    return invoke<MyAnime[]>("upsert_my_anime", { item }).catch((error) => {
      throw normalizeTauriError("upsert_my_anime", error);
    });
  }

  /** 删除追番及其单集业务数据。 */
  async removeMyAnime(itemId: string): Promise<MyAnime[]> {
    return invoke<MyAnime[]>("remove_my_anime", { itemId }).catch((error) => {
      throw normalizeTauriError("remove_my_anime", error);
    });
  }

  /** 读取全部追番观看进度。 */
  async listMyAnimeWatchProgress(): Promise<AnimeWatchProgress[]> {
    return invoke<AnimeWatchProgress[]>("list_my_anime_watch_progress").catch((error) => {
      throw normalizeTauriError("list_my_anime_watch_progress", error);
    });
  }

  /** 原子调整一部追番的已看集数。 */
  async setAnimeWatchProgress(input: SetAnimeWatchProgressInput): Promise<AnimeWatchProgress> {
    return invoke<AnimeWatchProgress>("set_anime_watch_progress", { input }).catch((error) => {
      throw normalizeTauriError("set_anime_watch_progress", error);
    });
  }

  /** 将达到阈值的播放进度回写为单集已看状态。 */
  async reportPlaybackProgress(input: ReportPlaybackProgressInput): Promise<boolean> {
    return invoke<boolean>("report_playback_progress", { input }).catch((error) => {
      throw normalizeTauriError("report_playback_progress", error);
    });
  }

  /** 保存当前下载文件的续播检查点。 */
  async savePlaybackCheckpoint(input: SavePlaybackCheckpointInput): Promise<PlaybackCheckpoint> {
    return invoke<PlaybackCheckpoint>("save_playback_checkpoint", { input }).catch((error) => {
      throw normalizeTauriError("save_playback_checkpoint", error);
    });
  }

  /** 读取指定番剧单集。 */
  async listEpisodes(animeId: string): Promise<Episode[]> {
    return invoke<Episode[]>("list_episodes", { animeId }).catch((error) => {
      throw normalizeTauriError("list_episodes", error);
    });
  }

  /** 新增或更新单集。 */
  async upsertEpisode(episode: Episode): Promise<Episode[]> {
    return invoke<Episode[]>("upsert_episode", { episode }).catch((error) => {
      throw normalizeTauriError("upsert_episode", error);
    });
  }

  /** 读取指定番剧的单集级规则。 */
  async listEpisodePreferences(animeId: string): Promise<EpisodePreference[]> {
    return invoke<EpisodePreference[]>("list_episode_preferences", { animeId }).catch((error) => {
      throw normalizeTauriError("list_episode_preferences", error);
    });
  }

  /** 新增或更新单集级规则。 */
  async upsertEpisodePreference(preference: EpisodePreference): Promise<EpisodePreference[]> {
    return invoke<EpisodePreference[]>("upsert_episode_preference", { preference }).catch((error) => {
      throw normalizeTauriError("upsert_episode_preference", error);
    });
  }

  /** 删除单集级规则。 */
  async removeEpisodePreference(episodeId: string): Promise<EpisodePreference[]> {
    return invoke<EpisodePreference[]>("remove_episode_preference", { episodeId }).catch((error) => {
      throw normalizeTauriError("remove_episode_preference", error);
    });
  }

  /** 按可选年月读取 Rust SQLite 番剧目录。 */
  async listAnimeCatalog(year?: number, month?: number): Promise<Anime[]> {
    return invoke<Anime[]>("list_anime_catalog", { year, month }).catch((error) => {
      throw normalizeTauriError("list_anime_catalog", error);
    });
  }

  /** 按标题、原名和别名搜索本地番剧目录。 */
  async searchAnimeCatalog(keyword: string): Promise<AnimeDiscoverySearchResult> {
    return invoke<AnimeDiscoverySearchResult>("search_anime_catalog", { keyword }).catch((error) => {
      throw normalizeTauriError("search_anime_catalog", error);
    });
  }

  /** 读取番剧详情页所需的本地聚合数据。 */
  async getAnimeDetail(animeId: string): Promise<AnimeDetailResult> {
    return invoke<AnimeDetailResult>("get_anime_detail", { animeId }).catch((error) => {
      throw normalizeTauriError("get_anime_detail", error);
    });
  }

  /** 读取全部或指定番剧的字幕组。 */
  async listFansubs(animeId?: string): Promise<FansubGroup[]> {
    return invoke<FansubGroup[]>("list_fansubs", { animeId }).catch((error) => {
      throw normalizeTauriError("list_fansubs", error);
    });
  }

  /** 从公共 Repository 端口读取下载源配置。 */
  async listSources(): Promise<ReleaseSourceConfig[]> {
    return invoke<ReleaseSourceConfig[]>("list_sources").catch((error) => {
      throw normalizeTauriError("list_sources", error);
    });
  }

  /** 启用或停用一个下载源。 */
  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<ReleaseSourceConfig[]> {
    return invoke<ReleaseSourceConfig[]>("set_source_enabled", { sourceId, enabled }).catch((error) => {
      throw normalizeTauriError("set_source_enabled", error);
    });
  }

  /** 新增或更新一个下载源。 */
  async upsertSource(source: ReleaseSourceConfig): Promise<ReleaseSourceConfig[]> {
    return invoke<ReleaseSourceConfig[]>("upsert_source", { source }).catch((error) => {
      throw normalizeTauriError("upsert_source", error);
    });
  }
}

/** 创建仅暴露已迁移命令的 Tauri AppClient。 */
export function createTauriClient(platform: TauriClientPlatform): AppClient {
  const client = new TauriClientCore(platform);
  return new Proxy(client as unknown as AppClient, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value === "function") {
        return value.bind(target);
      }
      if (value !== undefined || typeof property !== "string") {
        return value;
      }

      return async () => {
        console.warn("[tauri-client] 调用了尚未迁移的业务方法", { method: property });
        throw new Error(`Tauri 业务方法尚未迁移：${property}`);
      };
    }
  });
}
