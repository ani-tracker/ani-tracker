import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Anime } from "@shared/domain";
import type { AppRepository } from "../../repositories/app-repository";
import { RequestCircuitOpenError } from "../../network/request-circuit-breaker";
import { AnimeDiscoveryService } from "../anime-discovery-service";
import type {
  MonthlyAnimeMetadataProvider,
  SearchableAnimeMetadataProvider,
  SeasonalAnimeMetadataProvider
} from "../metadata-provider";

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
  assert.deepEqual(result.errors, ["blocked: Bangumi 正在熔断保护中"]);
});

test("关键词搜索并发合并本地缓存与可用在线来源并增量缓存", async () => {
  const local = createAnime("local-anime", "跨季度测试番", 2020, 4);
  local.externalIds = { bangumi: "100" };
  const online = createAnime("anilist-anime", "跨季度测试番", 2020, 4);
  online.externalIds = { anilist: "200" };
  let searchedKeyword = "";
  let cachedItems: Anime[] = [];
  const repository = {
    searchAnimeCatalog: async (keyword: string) => {
      searchedKeyword = keyword;
      return [local];
    },
    upsertAnimeCatalog: async (items: Anime[]) => {
      cachedItems = items;
      return { items, addedCount: items.length, existingCount: 0 };
    }
  } as unknown as AppRepository;
  const providers: Array<MonthlyAnimeMetadataProvider & SearchableAnimeMetadataProvider> = [
    {
      id: "anilist",
      getAnimeByMonth: async () => [],
      searchAnime: async () => [online]
    },
    {
      id: "bangumi",
      getAnimeByMonth: async () => [],
      searchAnime: async () => {
        throw new Error("网络不可用");
      }
    }
  ];

  const result = await new AnimeDiscoveryService(repository, providers).searchCatalog("  跨季度测试番  ");

  assert.equal(searchedKeyword, "跨季度测试番");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, local.id);
  assert.deepEqual(result.items[0].externalIds, { bangumi: "100", anilist: "200" });
  assert.deepEqual(cachedItems, result.items);
  assert.equal(result.source, "local+anilist");
  assert.deepEqual(result.errors, ["bangumi: 网络不可用"]);
});

test("AnimeDiscoveryService 季度采集仅调用一次季度来源", async () => {
  const repository = new FakeCatalogRepository();
  const monthlyCalls: number[] = [];
  let aniListCalls = 0;
  let mikanCalls = 0;
  const bangumi: MonthlyAnimeMetadataProvider = {
    id: "bangumi",
    async getAnimeByMonth(year, month) {
      monthlyCalls.push(month);
      return [createAnime(`bangumi-${month}`, `Bangumi ${month}`, year, month)];
    }
  };
  const aniList: SeasonalAnimeMetadataProvider = {
    id: "anilist",
    async getAnimeByMonth() {
      throw new Error("季度采集不应调用月度方法");
    },
    async getAnimeBySeason(year) {
      aniListCalls += 1;
      return [4, 5, 6].map((month) => createAnime(`anilist-${month}`, `AniList ${month}`, year, month));
    }
  };
  const mikan: SeasonalAnimeMetadataProvider = {
    id: "mikan",
    async getAnimeByMonth() {
      throw new Error("季度采集不应调用月度方法");
    },
    async getAnimeBySeason(year) {
      mikanCalls += 1;
      return [4, 5, 6].map((month) => createAnime(`mikan-${month}`, `Mikan ${month}`, year, month));
    }
  };

  const result = await new AnimeDiscoveryService(
    repository as unknown as AppRepository,
    [bangumi, aniList, mikan]
  ).collectSeason({ year: 2026, season: "spring" });

  assert.deepEqual(monthlyCalls, [4, 5, 6]);
  assert.equal(aniListCalls, 1);
  assert.equal(mikanCalls, 1);
  assert.equal(result.items.length, 9);
  assert.equal(result.addedCount, 9);
  assert.deepEqual(result.errors, []);
});

class FakeCatalogRepository {
  private readonly itemsByMonth = new Map<number, Anime[]>();

  async listAnimeCatalogByMonth(_year: number, month: number): Promise<Anime[]> {
    return [...(this.itemsByMonth.get(month) ?? [])];
  }

  async upsertAnimeCatalog(items: Anime[]) {
    let addedCount = 0;
    let existingCount = 0;
    for (const item of items) {
      const current = this.itemsByMonth.get(item.premiereMonth) ?? [];
      const index = current.findIndex((entry) => entry.id === item.id);
      if (index >= 0) {
        current[index] = item;
        existingCount += 1;
      } else {
        current.push(item);
        addedCount += 1;
      }
      this.itemsByMonth.set(item.premiereMonth, current);
    }
    return { items: [...this.itemsByMonth.values()].flat(), addedCount, existingCount };
  }

  async replaceAnimeCatalogMonth(_year: number, month: number, items: Anime[]) {
    const existingIds = new Set((this.itemsByMonth.get(month) ?? []).map((item) => item.id));
    this.itemsByMonth.set(month, [...items]);
    return {
      items: [...this.itemsByMonth.values()].flat(),
      addedCount: items.filter((item) => !existingIds.has(item.id)).length,
      existingCount: items.filter((item) => existingIds.has(item.id)).length
    };
  }
}

/** 创建季度采集测试使用的最小番剧记录。 */
function createAnime(id: string, title: string, year: number, month: number): Anime {
  return {
    id,
    title,
    aliases: [],
    premiereDate: `${year}-${String(month).padStart(2, "0")}-01`,
    premiereYear: year,
    premiereMonth: month,
    season: "spring",
    externalIds: {}
  };
}
