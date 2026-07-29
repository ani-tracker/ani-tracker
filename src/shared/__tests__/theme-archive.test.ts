import { strict as assert } from "node:assert";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { unpackThemeArchive } from "../theme-archive";

test("主题 ZIP 只解包根目录 JSON 与背景图", () => {
  const archive = zipSync({
    "image-theme.ani-theme.json": strToU8("{}"),
    "background-a1b2c3d4.webp": strToU8("image")
  });

  const entries = unpackThemeArchive(archive);

  assert.deepEqual(Object.keys(entries).sort(), [
    "background-a1b2c3d4.webp",
    "image-theme.ani-theme.json"
  ]);
});

test("主题 ZIP 拒绝目录穿越与额外文件", () => {
  const traversal = zipSync({
    "image-theme.ani-theme.json": strToU8("{}"),
    "../background-a1b2c3d4.webp": strToU8("image")
  });
  assert.throws(() => unpackThemeArchive(traversal), /不安全或不支持/);

  const extra = zipSync({
    "image-theme.ani-theme.json": strToU8("{}"),
    "background-a1b2c3d4.webp": strToU8("image"),
    "other-theme.ani-theme.json": strToU8("{}")
  });
  assert.throws(() => unpackThemeArchive(extra), /最多包含/);
});
