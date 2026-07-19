import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Anime } from "@shared/domain";
import type { AppRepository } from "../../repositories/app-repository";
import { AnimeDiscoveryService } from "../anime-discovery-service";
import type { MonthlyAnimeMetadataProvider } from "../metadata-provider";

test("强制刷新无采集结果时保留原月份缓存", async () => {
  const cached: Anime = {
    id: "cached-july-anime",
    title: "七月缓存番",
    aliases: [],
    premiereYear: 2026,
    premiereMonth: 7,
    externalIds: {}
  };
  let replaceCallCount = 0;
  const repository = {
    listAnimeCatalogByMonth: async () => [cached],
    replaceAnimeCatalogMonth: async () => {
      replaceCallCount += 1;
      return { items: [], addedCount: 0, existingCount: 0 };
    },
    clearAnimeCatalog: async () => {
      throw new Error("无采集结果时不应清空缓存");
    }
  } as unknown as AppRepository;
  const provider: MonthlyAnimeMetadataProvider = {
    id: "empty-provider",
    getAnimeByMonth: async () => []
  };

  const result = await new AnimeDiscoveryService(repository, [provider]).collectMonth({
    year: 2026,
    month: 7,
    forceRefresh: true
  });

  assert.deepEqual(result.items, [cached]);
  assert.equal(result.addedCount, 0);
  assert.equal(result.existingCount, 1);
  assert.equal(replaceCallCount, 0);
  assert.deepEqual(result.errors, ["empty-provider: 未返回新番数据"]);
});
