import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BUILTIN_PLAYER_PROFILE_ID,
  resolvePlaybackFileIndex,
  usesBuiltinPlayer
} from "../player-selection";

test("usesBuiltinPlayer 仅识别内置播放器保留标识", () => {
  assert.equal(usesBuiltinPlayer({ defaultPlayerProfileId: BUILTIN_PLAYER_PROFILE_ID }), true);
  assert.equal(usesBuiltinPlayer({ defaultPlayerProfileId: "auto" }), false);
  assert.equal(usesBuiltinPlayer({ defaultPlayerProfileId: "mpv" }), false);
  assert.equal(usesBuiltinPlayer({}), false);
});

test("resolvePlaybackFileIndex 兼容 Unix 和 Windows 下载路径", () => {
  const task = {
    savePath: "D:\\Anime\\Season 2",
    files: [
      { name: "Show/episode-01.mkv", index: 3 },
      { name: "Show/episode-02.mkv", index: 4 }
    ]
  };

  assert.equal(resolvePlaybackFileIndex({
    filePath: "D:\\Anime\\Season 2\\Show\\episode-02.mkv"
  }, task), 4);
  assert.equal(resolvePlaybackFileIndex({
    filePath: "d:/anime/season 2/show/EPISODE-01.MKV"
  }, task), 3);
  assert.equal(resolvePlaybackFileIndex({ filePath: "/other/video.mkv", fileIndex: 9 }, task), 9);
  assert.equal(resolvePlaybackFileIndex({ filePath: "/other/video.mkv" }, task), undefined);
});
