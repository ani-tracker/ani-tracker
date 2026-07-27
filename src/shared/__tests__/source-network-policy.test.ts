import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ANIBT_MIN_REQUEST_INTERVAL_MS,
  getSourceMinimumRequestIntervalMs,
  shouldUseSourceProxy
} from "../source-network-policy";

test("AniBT 在全部平台固定直连且最小间隔为 500 毫秒", () => {
  const source = {
    id: "anibt",
    name: "AniBT",
    baseUrl: "https://anibt.net/",
    useProxy: true
  };

  assert.equal(ANIBT_MIN_REQUEST_INTERVAL_MS, 500);
  assert.equal(getSourceMinimumRequestIntervalMs(source), 500);
  assert.equal(shouldUseSourceProxy(source), false);
});

test("普通来源继续使用 250 毫秒下限并允许代理", () => {
  const source = {
    id: "regular",
    name: "普通来源",
    baseUrl: "https://example.test/",
    useProxy: true
  };

  assert.equal(getSourceMinimumRequestIntervalMs(source), 250);
  assert.equal(shouldUseSourceProxy(source), true);
});
