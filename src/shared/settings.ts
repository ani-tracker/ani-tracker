import type { AppSettings } from "./domain";
import { normalizeCandidateFansubNames } from "./fansub-name-matcher";
import { normalizeAppearanceSettings } from "./theme";

/** 深度合并设置分组，避免局部更新覆盖同组其他字段。 */
export function mergeSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const embeddedSeedingLimits = current.download.embedded.seedingLimits
    ?? current.download.qbittorrent.seedingLimits;
  return {
    ...current,
    ...patch,
    appearance: normalizeAppearanceSettings({
      ...current.appearance,
      ...patch.appearance,
      customThemePacks: patch.appearance?.customThemePacks ?? current.appearance.customThemePacks
    }),
    download: {
      ...current.download,
      ...patch.download,
      embedded: {
        ...current.download.embedded,
        ...patch.download?.embedded,
        seedingLimits: {
          ...embeddedSeedingLimits,
          ...patch.download?.embedded?.seedingLimits
        }
      },
      qbittorrent: {
        ...current.download.qbittorrent,
        ...patch.download?.qbittorrent,
        seedingLimits: {
          ...current.download.qbittorrent.seedingLimits,
          ...patch.download?.qbittorrent?.seedingLimits
        },
        managed: {
          ...current.download.qbittorrent.managed,
          ...patch.download?.qbittorrent?.managed
        }
      }
    },
    storage: {
      ...current.storage,
      ...patch.storage
    },
    automation: {
      ...current.automation,
      ...patch.automation,
      candidateFansubNames: normalizeCandidateFansubNames(
        patch.automation?.candidateFansubNames ?? current.automation.candidateFansubNames ?? []
      )
    },
    sourceSync: {
      enabled: patch.sourceSync?.enabled ?? current.sourceSync?.enabled ?? true,
      dailyTime: patch.sourceSync?.dailyTime ?? current.sourceSync?.dailyTime ?? "09:00"
    },
    media: {
      ...current.media,
      ...patch.media
    },
    desktop: {
      ...current.desktop,
      ...patch.desktop
    },
    network: {
      ...current.network,
      ...patch.network,
      metadataProxy: {
        ...current.network.metadataProxy,
        ...patch.network?.metadataProxy
      },
      remoteAccess: {
        ...current.network.remoteAccess,
        ...patch.network?.remoteAccess,
        port: normalizeRemoteAccessPort(patch.network?.remoteAccess?.port, current.network.remoteAccess.port)
      }
    },
    players: mergePlayerProfiles(current.players, patch.players)
  };
}

/** 按播放器标识合并平台默认项和用户路径，避免升级后缺少新增选项。 */
function mergePlayerProfiles(current: AppSettings["players"], patch?: AppSettings["players"]): AppSettings["players"] {
  if (!patch) {
    return current;
  }

  const patchById = new Map(patch.map((profile) => [profile.id, profile]));
  const merged = current.map((profile) => ({ ...profile, ...patchById.get(profile.id) }));
  const currentIds = new Set(current.map((profile) => profile.id));
  return [...merged, ...patch.filter((profile) => !currentIds.has(profile.id))];
}

/** 仅接受非特权有效端口，非法补丁保留当前配置。 */
function normalizeRemoteAccessPort(value: number | undefined, current: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 1024 && value <= 65_535 ? value : current;
}
