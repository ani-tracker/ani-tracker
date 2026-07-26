import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  matchesCandidateFansub,
  normalizeCandidateFansubNames,
  normalizeFansubMatchName
} from "@shared/fansub-name-matcher";
import type { FansubGroup } from "@shared/domain";

test("字幕组匹配移除全部空白并忽略字母大小写", () => {
  assert.equal(normalizeFansubMatchName("  Neko\tMoe\nKissaten "), "nekomoekissaten");
  assert.equal(matchesCandidateFansub(
    { fansubName: "NekoMoe Kissaten" },
    ["neko moe KISSATEN"]
  ), true);
  assert.equal(matchesCandidateFansub(
    { fansubName: "候 补 字幕组" },
    ["候补字幕组"]
  ), true);
});

test("中文等非大小写文本采用去空白后的完整匹配", () => {
  assert.equal(matchesCandidateFansub(
    { fansubName: "候补字幕组扩展" },
    ["候补字幕组"]
  ), false);
  assert.equal(matchesCandidateFansub({ fansubName: "任意字幕组" }, []), false);
});

test("候补字幕组支持已知别名并按统一规则去重", () => {
  const groups: FansubGroup[] = [{
    id: "fansub-neko",
    name: "NekoMoe Kissaten",
    aliases: ["喵萌奶茶屋"],
    sourceIds: []
  }];

  assert.equal(matchesCandidateFansub(
    { fansubGroupId: "fansub-neko", fansubName: "喵萌 奶茶屋" },
    ["NEKOMOE KISSATEN"],
    groups
  ), true);
  assert.deepEqual(
    normalizeCandidateFansubNames([" Neko Moe ", "nekomoe", "字幕 组", "字幕组", ""]),
    ["Neko Moe", "字幕 组"]
  );
});
