import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  AppSettings,
  FansubGroup,
  MyAnime,
  NotificationRecord,
  Release,
  ReleaseSourceConfig
} from "@shared/domain";
import type { AnimeReleaseQuery } from "@shared/contracts";
import type { AppRepository } from "../../repositories/app-repository";
import {
  AnimeFollowPreparationService,
  FOLLOW_PREPARATION_CACHE_TTL_MS
} from "../anime-follow-preparation-service";

test("AnimeFollowPreparationService 预热资源并写入精确来源通知", async () => {
  const repository = new FakePreparationRepository();
  let receivedQuery: AnimeReleaseQuery | undefined;
  const service = new AnimeFollowPreparationService(repository as unknown as AppRepository, {
    createHttpClient: createUnusedHttpClient,
    createBindingService: () => ({
      getState: async (animeId) => ({ animeId, bindings: [], candidates: [], errors: [] })
    }),
    createResourceService: () => ({
      searchAnime: async (_anime, query) => {
        receivedQuery = query;
        return {
          query: { ...query, keyword: "测试番" },
          releases: [createRelease()],
          sourceResults: [],
          searchedSourceIds: ["source-a"],
          errors: [{ sourceId: "source-a", message: "请求超时" }]
        };
      }
    }),
    now: () => new Date("2026-07-22T00:00:00.000Z")
  });

  await service.prepare(createMyAnime("anime-prepare"));

  assert.equal(receivedQuery?.cacheTtlMs, FOLLOW_PREPARATION_CACHE_TTL_MS);
  assert.equal(repository.observedReleases.length, 1);
  assert.equal(repository.notifications.length, 1);
  assert.match(repository.notifications[0].body, /测试下载源（source-a）：请求超时/);
});

test("AnimeFollowPreparationService 复用同一番剧的进行中任务", async () => {
  const repository = new FakePreparationRepository();
  let searchCount = 0;
  let cachePrimeCount = 0;
  let releaseSearch!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  const service = new AnimeFollowPreparationService(repository as unknown as AppRepository, {
    createHttpClient: createUnusedHttpClient,
    createBindingService: () => ({
      getState: async (animeId) => ({ animeId, bindings: [], candidates: [], errors: [] })
    }),
    createResourceService: () => ({
      searchAnime: async (_anime, query) => {
        searchCount += 1;
        await gate;
        return {
          query: { ...query, keyword: "测试番" },
          releases: [],
          sourceResults: [],
          searchedSourceIds: [],
          errors: []
        };
      },
      primeAnimeSearchCache: async () => {
        cachePrimeCount += 1;
      }
    })
  });
  const item = createMyAnime("anime-dedupe");

  const first = service.prepareInBackground(item);
  const second = service.prepareInBackground(item);
  assert.equal(first, second);
  releaseSearch();
  await Promise.all([first, second]);

  assert.equal(searchCount, 1);
  assert.equal(cachePrimeCount, 1);
});

class FakePreparationRepository {
  readonly notifications: NotificationRecord[] = [];
  readonly observedReleases: Release[] = [];

  async getSettings(): Promise<AppSettings> {
    return { network: { metadataProxy: { mode: "off", timeoutMs: 15_000 } } } as AppSettings;
  }

  async listSources(): Promise<ReleaseSourceConfig[]> {
    return [{ id: "source-a", name: "测试下载源", kind: "rss", enabled: true }];
  }

  async listFansubs(): Promise<FansubGroup[]> {
    return [];
  }

  async observeAnimeFansubs(_animeId: string, releases: Release[]): Promise<FansubGroup[]> {
    this.observedReleases.push(...releases);
    return [];
  }

  async addNotifications(records: NotificationRecord[]): Promise<NotificationRecord[]> {
    this.notifications.push(...records);
    return this.notifications;
  }
}

/** 创建后台准备测试使用的追番记录。 */
function createMyAnime(animeId: string): MyAnime {
  const timestamp = "2026-07-22T00:00:00.000Z";
  return {
    id: `my-${animeId}`,
    anime: {
      id: animeId,
      title: "测试番",
      aliases: [],
      premiereYear: 2026,
      premiereMonth: 7,
      externalIds: {}
    },
    status: "watching",
    autoDownload: false,
    addedAt: timestamp,
    updatedAt: timestamp
  };
}

/** 创建字幕组观察测试使用的最小发布记录。 */
function createRelease(): Release {
  return {
    id: "release-1",
    title: "[测试字幕组] 测试番 - 01 [1080p]",
    sourceId: "source-a",
    sourceName: "测试下载源",
    publishedAt: "2026-07-22T00:00:00.000Z"
  };
}

function createUnusedHttpClient() {
  return {
    fetch: async (): Promise<Response> => {
      throw new Error("测试不应发起网络请求");
    }
  };
}
