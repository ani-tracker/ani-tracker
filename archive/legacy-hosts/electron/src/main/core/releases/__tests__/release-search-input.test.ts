import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchesAnimeSearchKeyword, isAnimeSearchTerm } from "../../../../shared/anime-release-search";
import { parseReleaseSearchInput, releaseMatchesEpisode } from "../../../../shared/release-search-input";
import type { Anime, Release } from "../../../../shared/domain";

test("parseReleaseSearchInput 识别常见集数格式并保留有效关键词", () => {
  assert.deepEqual(parseReleaseSearchInput("葬送的芙莉莲 第12集"), {
    keyword: "葬送的芙莉莲",
    episodeNo: 12
  });
  assert.deepEqual(parseReleaseSearchInput("Frieren EP12"), { keyword: "Frieren", episodeNo: 12 });
  assert.deepEqual(parseReleaseSearchInput("Frieren E12.5"), { keyword: "Frieren", episodeNo: 12.5 });
  assert.deepEqual(parseReleaseSearchInput("Frieren S02E04"), { keyword: "Frieren S02", episodeNo: 4 });
  assert.deepEqual(parseReleaseSearchInput("葬送的芙莉莲 12"), {
    keyword: "葬送的芙莉莲",
    episodeNo: 12
  });
});

test("parseReleaseSearchInput 不把年份、清晰度、编码、声道和纯数字标题误判为集数", () => {
  for (const keyword of [
    "2024",
    "1080p",
    "10bit",
    "86",
    "新番 2024",
    "动画 720",
    "动画 1080p",
    "动画 H.264",
    "动画 AAC 2.0"
  ]) {
    assert.deepEqual(parseReleaseSearchInput(keyword), { keyword });
  }
});

test("追番关键词联想匹配标题、原名和别名，并区分部分匹配与完整关联", () => {
  const anime = createAnime();

  assert.equal(matchesAnimeSearchKeyword(anime, "芙莉莲"), true);
  assert.equal(matchesAnimeSearchKeyword(anime, "Frieren"), true);
  assert.equal(matchesAnimeSearchKeyword(anime, "Sousou"), true);
  assert.equal(matchesAnimeSearchKeyword(anime, "无关作品"), false);
  assert.equal(isAnimeSearchTerm(anime, "Frieren"), true);
  assert.equal(isAnimeSearchTerm(anime, "Frieren 12"), false);
});

test("releaseMatchesEpisode 同时支持单集和合集范围", () => {
  assert.equal(releaseMatchesEpisode(createRelease({ episodeNo: 12 }), 12), true);
  assert.equal(releaseMatchesEpisode(createRelease({ episodeNo: 11 }), 12), false);
  assert.equal(releaseMatchesEpisode(createRelease({ episodeRange: { start: 1, end: 12 } }), 12), true);
  assert.equal(releaseMatchesEpisode(createRelease({ episodeRange: { start: 1, end: 11 } }), 12), false);
  assert.equal(releaseMatchesEpisode(createRelease({ episodeNo: 11 }), undefined), true);
});

/** 创建用于联想匹配测试的番剧数据。 */
function createAnime(): Anime {
  return {
    id: "anime-1",
    title: "葬送的芙莉莲",
    originalTitle: "Sousou no Frieren",
    aliases: [
      { id: "alias-1", animeId: "anime-1", alias: "Frieren", language: "en", priority: 1 }
    ],
    premiereYear: 2023,
    premiereMonth: 9,
    externalIds: {}
  };
}

/** 创建用于集数范围测试的最小资源数据。 */
function createRelease(patch: Partial<Release>): Release {
  return {
    id: "release-1",
    sourceId: "source-1",
    sourceName: "测试源",
    title: "测试资源",
    publishedAt: "2026-07-18T00:00:00.000Z",
    ...patch
  };
}
