import type { TorrentEngine } from "@shared/contracts";
import type { AppSettings, TorrentEngineKind } from "@shared/domain";
import { EmbeddedTorrentEngine } from "./embedded-torrent-engine";
import type { EmbeddedTorrentCoreClient } from "./embedded-torrent-core-service";
import { QbittorrentEngine } from "./qbittorrent-engine";
import type { TorrentHttpClient } from "./torrent-file-downloader";
import { MetadataHttpClient } from "../metadata/metadata-http-client";

export interface TorrentEngineFactoryOptions {
  qbittorrentBaseUrl?: string;
  torrentHttpClient?: TorrentHttpClient;
  embeddedTorrentClient?: EmbeddedTorrentCoreClient;
}

/** 根据应用设置创建下载引擎，并让 torrent 文件下载复用元数据代理。 */
export function createTorrentEngine(settings: AppSettings, options: TorrentEngineFactoryOptions = {}): TorrentEngine {
  return createTorrentEngineForKind(settings, settings.download.defaultTorrentEngine, options);
}

/** 按任务记录的引擎类型创建控制适配器，避免设置切换后误路由旧任务。 */
export function createTorrentEngineForKind(
  settings: AppSettings,
  kind: TorrentEngineKind,
  options: TorrentEngineFactoryOptions = {}
): TorrentEngine {
  if (kind === "qbittorrent") {
    return new QbittorrentEngine({
      baseUrl: options.qbittorrentBaseUrl ?? settings.download.qbittorrent.baseUrl,
      username: settings.download.qbittorrent.username,
      password: settings.download.qbittorrent.password,
      torrentHttpClient: options.torrentHttpClient ?? new MetadataHttpClient(settings.network.metadataProxy)
    });
  }

  return new EmbeddedTorrentEngine({
    settings,
    client: options.embeddedTorrentClient
  });
}
