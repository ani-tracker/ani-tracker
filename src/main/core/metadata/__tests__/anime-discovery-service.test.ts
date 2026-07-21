import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Anime } from "@shared/domain";
import type { AppRepository } from "../../repositories/app-repository";
import { RequestCircuitOpenError } from "../../network/request-circuit-breaker";
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

test("单个元数据来源熔断时继续合并其他来源结果", async () => {
  const available: Anime = {
    id: "available-anime",
    title: "可用来源番剧",
    aliases: [],
    premiereYear: 2026,
    premiereMonth: 7,
    externalIds: {}
  };
  const repository = {
    listAnimeCatalogByMonth: async () => [],
    upsertAnimeCatalog: async (items: Anime[]) => ({ items, addedCount: items.length, existingCount: 0 })
  } as unknown as AppRepository;
  const providers: MonthlyAnimeMetadataProvider[] = [
    {
      id: "blocked",
      getAnimeByMonth: async () => {
        throw new RequestCircuitOpenError("Bangumi 正在熔断保护中", {
          key: "metadata:bangumi",
          group: "metadata",
          name: "Bangumi"
        });
      }
    },
    {
      id: "available",
      getAnimeByMonth: async () => [available]
    }
  ];

  const result = await new AnimeDiscoveryService(repository, providers).collectMonth({
    year: 2026,
    month: 7
  });

  assert.deepEqual(result.items, [available]);
  assert.equal(result.source, "available");
});
