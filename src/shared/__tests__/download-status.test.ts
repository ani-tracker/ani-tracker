import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isActiveDownloadTask,
  isCompletedDownloadStatus,
  isCompletedDownloadTask
} from "../download-status";

test("做种和进度已满的任务统一归类为已完成", () => {
  assert.equal(isCompletedDownloadStatus("seeding"), true);
  assert.equal(isCompletedDownloadTask({ status: "seeding", progress: 1 }), true);
  assert.equal(isCompletedDownloadTask({ status: "downloading", progress: 1 }), true);
  assert.equal(isActiveDownloadTask({ status: "downloading", progress: 1 }), false);
});

test("异常任务不会仅因进度值已满被误判为完成", () => {
  assert.equal(isCompletedDownloadTask({ status: "error", progress: 1 }), false);
  assert.equal(isCompletedDownloadTask({ status: "missing_files", progress: 1 }), false);
  assert.equal(isActiveDownloadTask({ status: "downloading", progress: 0.99 }), true);
});
