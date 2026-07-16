import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { MyAnime, Release } from "@shared/domain";
import { rankReleases } from "../release-matcher";

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
