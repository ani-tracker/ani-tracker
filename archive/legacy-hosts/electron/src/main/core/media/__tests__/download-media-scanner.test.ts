import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { MediaProbeContext, MediaProbeService } from "@shared/contracts";
import type { AppSettings, DownloadTask, MediaFile } from "@shared/domain";
import { DownloadMediaScanner } from "../download-media-scanner";

test("合集扫描把文件级单集关联传给媒体探测", async () => {
  const contexts: MediaProbeContext[] = [];
  const probeService: MediaProbeService = {
    async probe(filePath, context = {}) {
      contexts.push(context);
      return createMediaFile(filePath, context);
    },
    async extractFromChain() {
      return { confidence: 0, source: "test" };
    }
  };
  const task: DownloadTask = {
    id: "collection-task",
    animeId: "anime-1",
    engine: "qbittorrent",
    name: "[字幕组] 测试番 [01-02 合集]",
    status: "seeding",
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath: "/downloads/anime",
    files: [{
      id: "collection-task:0",
      index: 0,
      name: "Series/Series - 01.mkv",
      episodeId: "episode-anime-1-1",
      episodeNo: 1,
      size: 1024,
      progress: 1,
      priority: 1,
      selected: true
    }],
    createdAt: "2026-07-25T00:00:00.000Z"
  };

  const scanner = new DownloadMediaScanner(probeService, {
    media: { videoExtensions: [".mkv"] }
  } as AppSettings);
  const result = await scanner.scanTask(task);

  assert.equal(contexts[0]?.episodeId, "episode-anime-1-1");
  assert.equal(result.mediaFiles[0]?.episodeId, "episode-anime-1-1");
});

/** 创建媒体扫描测试需要的最小探测结果。 */
function createMediaFile(filePath: string, context: MediaProbeContext): MediaFile {
  return {
    id: "media-1",
    animeId: context.animeId ?? "",
    episodeId: context.episodeId,
    downloadTaskId: context.downloadTaskId,
    filePath,
    fileName: "Series - 01.mkv",
    size: context.size ?? 0,
    normalizedVideoCodec: "Unknown",
    audioCodecs: [],
    subtitleTracks: []
  };
}
