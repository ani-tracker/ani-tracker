import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DownloadTask, Episode, TorrentFile } from "../domain";
import {
  findEpisodeDownloadLink,
  summarizeAnimeDownloads,
} from "../download-episode-links";

test("汇总合集文件的单集级下载进度", () => {
  const task = collectionTask([
    torrentFile(0, 1, 1),
    torrentFile(1, 2, 0.5),
    torrentFile(2, 3, 0),
  ]);

  assert.deepEqual(summarizeAnimeDownloads([task], "anime-1"), {
    linked: 3,
    completed: 1,
    active: 2,
  });
});

test("优先返回合集文件关联及文件进度", () => {
  const task = collectionTask([torrentFile(0, 1, 0.75)]);
  const episode: Episode = {
    id: "episode-1",
    animeId: "anime-1",
    episodeNo: 1,
    status: "downloading",
  };

  const link = findEpisodeDownloadLink([task], episode);
  assert.equal(link?.file?.index, 0);
  assert.equal(link?.progress, 0.75);
});

test("乱序合集按单集关联返回对应文件进度", () => {
  const task = collectionTask([
    torrentFile(0, 12, 0.223),
    torrentFile(11, 1, 0.239),
  ]);
  const episode1: Episode = {
    id: "episode-1",
    animeId: "anime-1",
    episodeNo: 1,
    status: "downloading",
  };
  const episode12: Episode = {
    id: "episode-12",
    animeId: "anime-1",
    episodeNo: 12,
    status: "downloading",
  };

  const episode1Link = findEpisodeDownloadLink([task], episode1);
  const episode12Link = findEpisodeDownloadLink([task], episode12);
  assert.equal(episode1Link?.file?.index, 11);
  assert.equal(episode1Link?.progress, 0.239);
  assert.equal(episode12Link?.file?.index, 0);
  assert.equal(episode12Link?.progress, 0.223);
});

function collectionTask(files: TorrentFile[]): DownloadTask {
  return {
    id: "task-collection",
    animeId: "anime-1",
    engine: "embedded",
    name: "Anime 01-12",
    status: "downloading",
    progress: 0.5,
    downloadSpeed: 1024,
    uploadSpeed: 0,
    savePath: "C:/Anime",
    files,
    createdAt: "2026-07-26T00:00:00.000Z",
  };
}

function torrentFile(
  index: number,
  episodeNo: number,
  progress: number,
): TorrentFile {
  return {
    id: `file-${index}`,
    index,
    name: `Anime - ${String(episodeNo).padStart(2, "0")}.mkv`,
    episodeId: `episode-${episodeNo}`,
    episodeNo,
    size: 1024,
    progress,
    priority: 1,
    selected: true,
  };
}
