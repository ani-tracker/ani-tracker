import type { TorrentEngine } from "@shared/contracts";
import type { AppSettings } from "@shared/domain";
import { EmbeddedTorrentEngine } from "./embedded-torrent-engine";
import { QbittorrentEngine, type TorrentHttpClient } from "./qbittorrent-engine";
import { MetadataHttpClient } from "../metadata/metadata-http-client";

export interface TorrentEngineFactoryOptions {
  qbittorrentBaseUrl?: string;
  torrentHttpClient?: TorrentHttpClient;
}

/** 根据应用设置创建下载引擎，并让 torrent 文件下载复用元数据代理。 */
export function createTorrentEngine(settings: AppSettings, options: TorrentEngineFactoryOptions = {}): TorrentEngine {
  if (settings.download.defaultTorrentEngine === "qbittorrent") {
    return new QbittorrentEngine({
      baseUrl: options.qbittorrentBaseUrl ?? settings.download.qbittorrent.baseUrl,
      username: settings.download.qbittorrent.username,
      password: settings.download.qbittorrent.password,
      torrentHttpClient: options.torrentHttpClient ?? new MetadataHttpClient(settings.network.metadataProxy)
    });
  }

  return new EmbeddedTorrentEngine();
}
