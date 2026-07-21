import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DownloadTask, Episode, MediaFile } from "@shared/domain";
import { PlaybackStatusService } from "../playback-status-service";

test("PlaybackStatusService marks the associated episode watched at 90 percent once", async () => {
  const episode: Episode = {
    id: "episode-1",
    animeId: "anime-1",
    episodeNo: 1,
    status: "downloaded"
  };
  const mediaFile: MediaFile = {
    id: "media-1",
    animeId: "anime-1",
    episodeId: "episode-1",
    downloadTaskId: "task-1",
    filePath: "/downloads/anime/episode-1.mkv",
    fileName: "episode-1.mkv",
    size: 1024,
    normalizedVideoCodec: "H.265/HEVC",
    audioCodecs: [],
    subtitleTracks: []
  };
  const updates: Episode[] = [];
  const service = new PlaybackStatusService({
    listMediaFiles: async () => [mediaFile],
    listDownloads: async () => [],
    listEpisodes: async () => [episode],
    upsertEpisode: async (updatedEpisode) => {
      updates.push(updatedEpisode);
      return [updatedEpisode];
    }
  });

  await service.handleProgress({ filePath: mediaFile.filePath, percent: 89.9 });
  await service.handleProgress({ filePath: mediaFile.filePath, percent: 90 });
  await service.handleProgress({ filePath: mediaFile.filePath, percent: 95 });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "watched");
});

test("PlaybackStatusService falls back to download task association", async () => {
  const episode: Episode = {
    id: "episode-2",
    animeId: "anime-1",
    episodeNo: 2,
    status: "downloaded"
  };
  const task: DownloadTask = {
    id: "task-2",
    animeId: "anime-1",
    episodeId: "episode-2",
    episodeNo: 2,
    engine: "qbittorrent",
    name: "episode-2",
    status: "completed",
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath: "/downloads/anime",
    files: [
      {
        id: "file-2",
        index: 0,
        name: "episode-2.mkv",
        size: 1024,
        progress: 1,
        priority: 1,
        selected: true
      }
    ],
    createdAt: "2026-07-16T00:00:00.000Z"
  };
  let updatedStatus: Episode["status"] | undefined;
  const service = new PlaybackStatusService({
    listMediaFiles: async () => [],
    listDownloads: async () => [task],
    listEpisodes: async () => [episode],
    upsertEpisode: async (updatedEpisode) => {
      updatedStatus = updatedEpisode.status;
      return [updatedEpisode];
    }
  });

  await service.handleProgress({ filePath: "/downloads/anime/episode-2.mkv", percent: 90 });

  assert.equal(updatedStatus, "watched");
});

test("PlaybackStatusService resolves remote progress by task and file index", async () => {
  const episode: Episode = {
    id: "episode-3",
    animeId: "anime-1",
    episodeNo: 3,
    status: "downloaded"
  };
  const task: DownloadTask = {
    id: "task-3",
    animeId: "anime-1",
    episodeId: "episode-3",
    episodeNo: 3,
    engine: "qbittorrent",
    name: "episode-3",
    status: "completed",
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath: "/downloads/anime",
    files: [{
      id: "file-3",
      index: 2,
      name: "episode-3.mkv",
      size: 1024,
      progress: 1,
      priority: 1,
      selected: true
    }],
    createdAt: "2026-07-21T00:00:00.000Z"
  };
  const updates: Episode[] = [];
  const service = new PlaybackStatusService({
    listMediaFiles: async () => [],
    listDownloads: async () => [task],
    listEpisodes: async () => [episode],
    upsertEpisode: async (updatedEpisode) => {
      updates.push(updatedEpisode);
      return [updatedEpisode];
    }
  });

  assert.equal(await service.handleTaskProgress({ taskId: task.id, fileIndex: 2, percent: 89.9 }), false);
  assert.equal(await service.handleTaskProgress({ taskId: task.id, fileIndex: 2, percent: 90 }), true);
  assert.equal(await service.handleTaskProgress({ taskId: task.id, fileIndex: 2, percent: 99 }), false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "watched");
});
