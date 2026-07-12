import type { TorrentEngine } from "@shared/contracts";
import type { AppSettings } from "@shared/domain";
import { EmbeddedTorrentEngine } from "./embedded-torrent-engine";
import { QbittorrentEngine } from "./qbittorrent-engine";

export function createTorrentEngine(settings: AppSettings): TorrentEngine {
  if (settings.download.defaultTorrentEngine === "qbittorrent") {
    return new QbittorrentEngine({
      baseUrl: settings.download.qbittorrent.baseUrl,
      username: settings.download.qbittorrent.username,
      password: settings.download.qbittorrent.password
    });
  }

  return new EmbeddedTorrentEngine();
}
