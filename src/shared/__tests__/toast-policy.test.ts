import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveToastDuration, resolveToastPresentation } from "../toast-policy";

test("移动提示固定在中部且同时只展示一条", () => {
  assert.deepEqual(resolveToastPresentation("android"), {
    mobile: true,
    position: "middle-center",
    closeButton: false,
    visibleToasts: 1,
    swipeDirections: ["bottom"]
  });
  assert.equal(resolveToastPresentation("ios").position, "middle-center");
});

test("桌面提示保持右上角和关闭按钮", () => {
  assert.deepEqual(resolveToastPresentation("desktop"), {
    mobile: false,
    position: "top-right",
    closeButton: true
  });
});

test("移动错误和可操作提示停留时间更长", () => {
  assert.equal(resolveToastDuration("android", "success", false), 3_000);
  assert.equal(resolveToastDuration("android", "error", false), 6_000);
  assert.equal(resolveToastDuration("ios", "success", true), 6_000);
  assert.equal(resolveToastDuration("desktop", "error", false), undefined);
});
