import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatMediaDisplayTitle, inferMediaContent } from "../media-content";

test("SP 目录覆盖普通数字集数", () => {
  assert.deepEqual(inferMediaContent("Anime/SP/Anime - 01.mkv", 1), {
    contentKind: "special",
    specialNo: "SP01"
  });
});

test("显式 NCOP 标记生成片头编号", () => {
  assert.deepEqual(inferMediaContent("Anime/Anime NCOP2.mkv"), {
    contentKind: "opening",
    specialNo: "NCOP02"
  });
});

test("完整 OVA 标题目录不误判为通用 OVA 节点", () => {
  assert.deepEqual(inferMediaContent("Anime OVA New Story/Anime - 01.mkv", 1), {
    contentKind: "episode"
  });
});

test("播放器列表使用番剧名和文件级集数作为主标题", () => {
  assert.equal(
    formatMediaDisplayTitle("转生史莱姆 第四季", { contentKind: "episode" }, 14),
    "转生史莱姆 第四季 · E14"
  );
});
