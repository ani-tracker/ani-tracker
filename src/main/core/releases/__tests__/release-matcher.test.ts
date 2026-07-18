import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { MyAnime, Release } from "@shared/domain";
import { evaluateAutomaticDownload, rankReleases } from "../release-matcher";

test("rankReleases 连集范围命中低于单集精确命中", () => {
  const anime = createMyAnime();
  const exact = createRelease("exact", "[字幕组] 测试番 - 02 [1080p][简体]");
  const range = createRelease("range", "[字幕组] 测试番 [01-02][1080p][简体]");
  const ranked = rankReleases([range, exact], {
    anime,
    episodeNo: 2
  });

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].release.id, "exact");
  assert.equal(ranked[1].release.id, "range");
  assert.ok(ranked[1].reasons.includes("集数范围覆盖"));
});

test("rankReleases 自动匹配排除旧季度和无目标集数的合集", () => {
  const anime = createMyAnime();
  anime.anime.title = "测试番 第四季";
  anime.anime.originalTitle = "Test Anime 4th Season";
  const current = createRelease("current", "[字幕组] 测试番 S04E02 [1080p]");
  const oldBatch = createRelease("old-batch", "[字幕组] 测试番 10-bit 1080p [S3 Fin]");
  const unknownBatch = createRelease("unknown-batch", "[字幕组] 测试番 完结全集 [1080p]");

  const ranked = rankReleases([oldBatch, unknownBatch, current], { anime, episodeNo: 2 });

  assert.deepEqual(ranked.map((item) => item.release.id), ["current"]);
});

test("rankReleases 将编码、位深和多语言覆盖作为独立偏好评分", () => {
  const anime = createMyAnime();
  anime.preferredCodec = "H.265/HEVC";
  anime.preferredBitDepth = 10;
  anime.preferredSubtitleLanguages = ["chs", "cht"];
  anime.preferredSubtitle = undefined;
  const preferred = createRelease("preferred", "[字幕组] 测试番 - 02 [1080p][HEVC][10bit][简繁]");
  const fallback = createRelease("fallback", "[字幕组] 测试番 - 02 [1080p][HEVC][8bit][简体]");

  const ranked = rankReleases([fallback, preferred], { anime, episodeNo: 2 });

  assert.equal(ranked[0].release.id, "preferred");
  assert.equal(ranked[0].preferenceScore - ranked[1].preferenceScore, 11);
  assert.equal(evaluateAutomaticDownload(ranked).accepted, true);
});

test("evaluateAutomaticDownload 拒绝近似并列的资源版本", () => {
  const anime = createMyAnime();
  anime.preferredSubtitleLanguages = [];
  anime.preferredSubtitle = undefined;
  const first = createRelease("first", "[字幕组] 测试番 - 02 [1080p][HEVC][简体]");
  const second = createRelease("second", "[字幕组] 测试番 - 02 [1080p][HEVC][繁体]");
  const ranked = rankReleases([first, second], { anime, episodeNo: 2 });

  const decision = evaluateAutomaticDownload(ranked);
  assert.equal(decision.accepted, false);
  assert.match(decision.reason, /领先不足/);
});

/** 创建匹配器测试用追番。 */
function createMyAnime(): MyAnime {
  const timestamp = "2026-07-16T00:00:00.000Z";
  return {
    id: "my-test",
    anime: {
      id: "anime-test",
      title: "测试番",
      aliases: [],
      premiereYear: 2026,
      premiereMonth: 7,
      externalIds: {}
    },
    status: "watching",
    autoDownload: true,
    preferredSubtitle: "chs",
    addedAt: timestamp,
    updatedAt: timestamp
  };
}

/** 创建匹配器测试用资源。 */
function createRelease(id: string, title: string): Release {
  return {
    id,
    title,
    sourceId: "rss",
    sourceName: "RSS",
    publishedAt: "2026-07-16T00:00:00.000Z"
  };
}
