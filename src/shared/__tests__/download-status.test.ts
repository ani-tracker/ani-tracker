import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isActiveDownloadTask,
  isCompletedDownloadStatus,
  isCompletedDownloadTask,
  isFinishedDownloadTask,
  isSeedingDownloadTask
} from "../download-status";

test("做种和进度已满的任务统一归类为已完成", () => {
  assert.equal(isCompletedDownloadStatus("seeding"), true);
  assert.equal(isCompletedDownloadTask({ status: "seeding", progress: 1 }), true);
  assert.equal(isSeedingDownloadTask({ status: "seeding" }), true);
  assert.equal(isFinishedDownloadTask({ status: "seeding", progress: 1 }), false);
  assert.equal(isCompletedDownloadTask({ status: "downloading", progress: 1 }), true);
  assert.equal(isFinishedDownloadTask({ status: "downloading", progress: 1 }), true);
  assert.equal(isActiveDownloadTask({ status: "downloading", progress: 1 }), false);
});

test("异常任务不会仅因进度值已满被误判为完成", () => {
  assert.equal(isCompletedDownloadTask({ status: "error", progress: 1 }), false);
  assert.equal(isCompletedDownloadTask({ status: "missing_files", progress: 1 }), false);
  assert.equal(isActiveDownloadTask({ status: "downloading", progress: 0.99 }), true);
});

test("暂停做种会依据已选文件完成度归类为已完成", () => {
  const pausedSeedingTask = {
    status: "paused" as const,
    progress: 0.999,
    files: [
      { selected: true, progress: 1 },
      { selected: false, progress: 0 }
    ]
  };

  assert.equal(isCompletedDownloadTask(pausedSeedingTask), true);
  assert.equal(isActiveDownloadTask(pausedSeedingTask), false);
});

test("已选文件未完成时不会被总体进度误判为完成", () => {
  assert.equal(isCompletedDownloadTask({
    status: "paused",
    progress: 1,
    files: [{ selected: true, progress: 0.8 }]
  }), false);
});
