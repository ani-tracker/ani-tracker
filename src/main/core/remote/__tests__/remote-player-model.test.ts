import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DownloadTask } from "@shared/domain";
import {
  buildRemotePlaylist,
  readPlaylistFileIndex,
  resolveInitialPlaylistItem
} from "../../../../renderer/src/features/remote/remote-player-model";

test("远程播放列表汇总同番剧完成视频并保持集数与文件名顺序", () => {
  const episodeTwo = createTask("task-2", "anime-1", 2, [
    createFile(2, "Show 02.mkv", 1),
    createFile(3, "Show 02.ass", 1),
    createFile(4, "Show 03.mkv", 0.5)
  ]);
  const items = buildRemotePlaylist([
    episodeTwo,
    createTask("task-other", "anime-2", 1, [createFile(0, "Other 01.mkv", 1)]),
    createTask("task-1", "anime-1", 1, [
      createFile(1, "Show 01 Part 10.mp4", 1),
      createFile(0, "Show 01 Part 2.mp4", 1)
    ])
  ], episodeTwo);

  assert.deepEqual(items.map((item) => [item.task.id, item.fileIndex, item.fileName]), [
    ["task-1", 0, "Show 01 Part 2.mp4"],
    ["task-1", 1, "Show 01 Part 10.mp4"],
    ["task-2", 2, "Show 02.mkv"]
  ]);
  assert.equal(resolveInitialPlaylistItem(items, "task-2", 2)?.id, "task-2:file:2");
  assert.equal(readPlaylistFileIndex("?file=2"), 2);
  assert.equal(readPlaylistFileIndex("?file=-1"), undefined);
});

/** 创建播放列表测试使用的下载任务。 */
function createTask(
  id: string,
  animeId: string,
  episodeNo: number,
  files: DownloadTask["files"]
): DownloadTask {
  return {
    id,
    animeId,
    episodeNo,
    engine: "qbittorrent",
    name: id,
    status: "completed",
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath: "C:\\Downloads",
    files,
    createdAt: "2026-07-18T00:00:00.000Z"
  };
}

/** 创建播放列表测试使用的下载文件。 */
function createFile(index: number, name: string, progress: number): DownloadTask["files"][number] {
  return {
    id: `file-${index}`,
    index,
    name,
    size: 1_024,
    progress,
    priority: 1,
    selected: true
  };
}
