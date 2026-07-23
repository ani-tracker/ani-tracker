import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseByteRange } from "../desktop-media-protocol";

test("parseByteRange 解析完整、开放和后缀字节范围", () => {
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-15", 100), { start: 85, end: 99 });
  assert.deepEqual(parseByteRange("bytes=95-120", 100), { start: 95, end: 99 });
});

test("parseByteRange 拒绝空值、多段和越界范围", () => {
  assert.equal(parseByteRange("bytes=-", 100), undefined);
  assert.equal(parseByteRange("bytes=0-1,5-6", 100), undefined);
  assert.equal(parseByteRange("bytes=100-", 100), undefined);
  assert.equal(parseByteRange("bytes=20-10", 100), undefined);
  assert.equal(parseByteRange("bytes=0-1", 0), undefined);
});
