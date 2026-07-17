import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DownloadTask } from "@shared/domain";
import { inferDownloadTaskEpisodeNo } from "../../downloads/download-episode-resolver";
import { findExistingDownloadTask, isEngineTaskCovered } from "../app-repository";

test("同名种子按哈希匹配各自任务", () => {
  const existingTasks = [
    createTask("hash-01", 1),
    createTask("hash-02", 2),
    createTask("hash-03", 3)
  ];

  const incoming = createTask("hash-02");

  assert.equal(findExistingDownloadTask(existingTasks, incoming)?.episodeNo, 2);
  assert.equal(isEngineTaskCovered([incoming], existingTasks[1]), true);
  assert.equal(isEngineTaskCovered([incoming], existingTasks[0]), false);
});

test("重复标签和名称不覆盖稳定标识不同的任务", () => {
  const existingTasks = [
    createTask("hash-01", 1),
    createTask("hash-02", 1),
    createTask("hash-03", 1)
  ];

  assert.equal(findExistingDownloadTask(existingTasks, createTask("hash-new", 2)), undefined);
});

test("首次刷新优先用关联标签合并 pending 任务", () => {
  const correlationTag = "ani-tracker-396aba3c-a2e8-421a-896b-2a08536ce38e";
  const pending = {
    ...createTask("pending-task", 1),
    id: "pending-task",
    torrentHash: undefined,
    correlationTag,
    releaseId: "release-01",
    episodeId: "episode-anime-1-1"
  };
  const staleEngineTask = {
    ...createTask("real-hash"),
    correlationTag: `${correlationTag}\r\n------formdata-undici-boundary--`
  };
  const refreshedEngineTask = {
    ...createTask("real-hash"),
    correlationTag
  };

  assert.equal(findExistingDownloadTask([staleEngineTask, pending], refreshedEngineTask)?.id, pending.id);
  assert.equal(isEngineTaskCovered([refreshedEngineTask], pending), true);
  assert.equal(isEngineTaskCovered([refreshedEngineTask], staleEngineTask), true);
});

test("单一视频文件按 SxxExx 解析集数", () => {
  const task = createTask("hash-02");
  task.files = [createFile(0, "Series/Series S03E02 [1080p].mkv")];

  assert.equal(inferDownloadTaskEpisodeNo(task), 2);
});

test("批量种子包含多个集数时不推断单集", () => {
  const task = createTask("batch-hash");
  task.files = [
    createFile(0, "Series/Series S03E01 [1080p].mkv"),
    createFile(1, "Series/Series S03E02 [1080p].mkv")
  ];

  assert.equal(inferDownloadTaskEpisodeNo(task), undefined);
});

/** 创建用于验证下载任务匹配的最小任务。 */
function createTask(hash: string, episodeNo?: number): DownloadTask {
  return {
    id: hash,
    animeId: "anime-1",
    episodeNo,
    correlationTag: "ani-tracker-shared-tag",
    engine: "qbittorrent",
    torrentHash: hash,
    name: "Same torrent root name",
    status: "seeding",
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath: "/downloads/anime",
    files: [],
    createdAt: "2026-07-16T00:00:00.000Z"
  };
}

/** 创建用于集数解析的已选择视频文件。 */
function createFile(index: number, name: string): DownloadTask["files"][number] {
  return {
    id: `file-${index}`,
    index,
    name,
    size: 1024,
    progress: 1,
    priority: 1,
    selected: true
  };
}
