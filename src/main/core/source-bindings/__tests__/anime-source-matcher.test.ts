import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Anime } from "@shared/domain";
import { calculateTitleSimilarity, scoreAnimeSourceCandidate } from "../anime-source-matcher";

const anime: Anime = {
  id: "anime-1",
  title: "凡人修仙传 年番",
  originalTitle: "A Record of a Mortal's Journey to Immortality",
  aliases: [],
  premiereYear: 2026,
  premiereMonth: 7,
  externalIds: {}
};

test("来源候选标题、季度和集数完全匹配时获得满分", () => {
  const result = scoreAnimeSourceCandidate(anime, {
    sourceId: "anibt",
    sourceName: "AniBT",
    sourceAnimeId: "528828",
    title: "凡人修仙传 年番",
    aliases: [],
    premiereYear: 2026,
    premiereMonth: 8,
    episodeCount: 160
  }, 160);

  assert.equal(result.score, 100);
  assert.deepEqual(result.reasons, ["标题 100%", "季度 100%", "集数 100%"]);
});

test("相似续作标题不会压过完全匹配标题", () => {
  const exact = calculateTitleSimilarity("出租女友 第五季", "出租女友 第五季");
  const wrong = calculateTitleSimilarity("凡人修仙传 第五季", "出租女友 第五季");
  assert.equal(exact, 1);
  assert.ok(wrong < 0.6);
});
