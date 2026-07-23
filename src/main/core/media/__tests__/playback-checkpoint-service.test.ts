import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PlaybackCheckpoint } from "@shared/contracts";
import {
  PlaybackCheckpointService,
  normalizePlaybackCheckpointInput,
  resolvePlaybackResumePosition
} from "../playback-checkpoint-service";

test("PlaybackCheckpointService 在首次跨过 90% 时只上报一次", async () => {
  let checkpoint: PlaybackCheckpoint | undefined;
  let watchedCalls = 0;
  const service = new PlaybackCheckpointService({
    getPlaybackCheckpoint: async () => checkpoint,
    upsertPlaybackCheckpoint: async (next) => {
      checkpoint = next;
      return next;
    }
  }, {
    handleTaskProgress: async () => {
      watchedCalls += 1;
      return true;
    }
  }, () => new Date("2026-07-24T00:00:00.000Z"));

  await service.save({ taskId: "task-1", fileIndex: 0, positionSeconds: 890, durationSeconds: 1_000 });
  assert.equal(watchedCalls, 0);
  await service.save({ taskId: "task-1", fileIndex: 0, positionSeconds: 900, durationSeconds: 1_000 });
  await service.save({ taskId: "task-1", fileIndex: 0, positionSeconds: 950, durationSeconds: 1_000 });

  assert.equal(watchedCalls, 1);
  assert.equal(checkpoint?.watchedReported, true);
  assert.equal(checkpoint?.updatedAt, "2026-07-24T00:00:00.000Z");
});

test("续播位置跳过开头、已完成和片尾保护区", () => {
  const base: PlaybackCheckpoint = {
    taskId: "task-1",
    positionSeconds: 120,
    durationSeconds: 1_400,
    completed: false,
    watchedReported: false,
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
  assert.equal(resolvePlaybackResumePosition(base), 120);
  assert.equal(resolvePlaybackResumePosition({ ...base, positionSeconds: 4 }), undefined);
  assert.equal(resolvePlaybackResumePosition({ ...base, positionSeconds: 1_380 }), undefined);
  assert.equal(resolvePlaybackResumePosition({ ...base, completed: true }), undefined);
});

test("续播输入拒绝非法索引、任务标识和异常秒数", () => {
  assert.throws(
    () => normalizePlaybackCheckpointInput(undefined as unknown as Parameters<typeof normalizePlaybackCheckpointInput>[0]),
    /播放续播参数格式无效/
  );
  assert.throws(() => normalizePlaybackCheckpointInput({
    taskId: "../task",
    positionSeconds: 10,
    durationSeconds: 100
  }));
  assert.throws(() => normalizePlaybackCheckpointInput({
    taskId: "task-1",
    fileIndex: -1,
    positionSeconds: 10,
    durationSeconds: 100
  }));
  assert.throws(() => normalizePlaybackCheckpointInput({
    taskId: "task-1",
    positionSeconds: Number.NaN,
    durationSeconds: 100
  }));
});
