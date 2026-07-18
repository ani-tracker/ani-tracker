import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SubtitleLanguage, SubtitlePreference } from "@shared/domain";
import { formatSubtitleLanguages, normalizeSubtitleLanguages } from "@shared/release-metadata";

test("formatSubtitleLanguages 将历史非法字幕值显示为未知", () => {
  const invalidPreference = "unknown" as SubtitlePreference;

  assert.equal(formatSubtitleLanguages(undefined, invalidPreference), "字幕未知");
});

test("normalizeSubtitleLanguages 忽略历史数组中的非法字幕值", () => {
  const storedValues = ["chs", "unknown", "eng"] as SubtitleLanguage[];

  assert.deepEqual(normalizeSubtitleLanguages(storedValues), ["chs", "eng"]);
});
