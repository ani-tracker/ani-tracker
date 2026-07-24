import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AniListMetadataProvider } from "../anilist-metadata-provider";
import {
  ANILIST_PAGE_LIMIT,
  ANILIST_REQUEST_LIMIT_PER_MINUTE,
  AniListRequestScheduler
} from "../anilist-request-scheduler";

test("AniList 月度采集每页固定 50 并按 pageInfo 拉取后续页", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const httpClient = {
    async fetch(_input: string | URL, options?: RequestInit) {
      const body = JSON.parse(String(options?.body)) as { variables: Record<string, unknown> };
      requests.push(body.variables);
      const page = Number(body.variables.page);
      return Response.json({
        data: {
          Page: {
            pageInfo: {
              currentPage: page,
              hasNextPage: page === 1,
              lastPage: 2
            },
            media: [{
              id: page,
              title: { native: `测试番 ${page}` },
              startDate: { year: 2026, month: 7, day: page }
            }]
          }
        }
      });
    }
  };
  const scheduler = new AniListRequestScheduler();
  const provider = new AniListMetadataProvider(httpClient, scheduler);

  const items = await provider.getAnimeByMonth(2026, 7);

  assert.deepEqual(requests.map((variables) => variables.page), [1, 2]);
  assert.ok(requests.every((variables) => variables.perPage === ANILIST_PAGE_LIMIT));
  assert.deepEqual(items.map((item) => item.externalIds.anilist), ["1", "2"]);
});

test("AniList 详情保留下一集编号和时间作为单集同步锚点", async () => {
  const airingAt = Math.trunc(Date.parse("2030-07-15T12:00:00.000Z") / 1000);
  const httpClient = {
    async fetch(_input: string | URL, options?: RequestInit) {
      const body = JSON.parse(String(options?.body)) as { query: string };
      assert.match(body.query, /nextAiringEpisode \{ airingAt episode \}/);
      return Response.json({
        data: {
          Media: {
            id: 100,
            title: { native: "锚点测试番" },
            startDate: { year: 2030, month: 7, day: 1 },
            episodes: 12,
            nextAiringEpisode: { airingAt, episode: 3 }
          }
        }
      });
    }
  };
  const provider = new AniListMetadataProvider(httpClient, new AniListRequestScheduler());

  const item = await provider.getAnimeDetail("100", {
    id: "anime-anchor",
    title: "锚点测试番",
    aliases: [],
    premiereYear: 2030,
    premiereMonth: 7,
    externalIds: { anilist: "100" }
  });

  assert.equal(item.detail?.nextAiringAt, "2030-07-15T12:00:00.000Z");
  assert.equal(item.detail?.nextAiringEpisodeNo, 3);
});

test("AniList 关键词搜索使用 search 参数并保留真实首播季度", async () => {
  let requestBody: { query: string; variables: Record<string, unknown> } | undefined;
  const httpClient = {
    async fetch(_input: string | URL, options?: RequestInit) {
      requestBody = JSON.parse(String(options?.body)) as typeof requestBody;
      return Response.json({
        data: {
          Page: {
            media: [{
              id: 300,
              title: { native: "旧番测试", romaji: "Old Anime Test" },
              startDate: { year: 2012, month: 10, day: 5 },
              season: "FALL"
            }]
          }
        }
      });
    }
  };
  const provider = new AniListMetadataProvider(httpClient, new AniListRequestScheduler());

  const [item] = await provider.searchAnime("Old Anime Test");

  assert.match(requestBody?.query ?? "", /search: \$search/);
  assert.equal(requestBody?.variables.search, "Old Anime Test");
  assert.equal(item.premiereYear, 2012);
  assert.equal(item.season, "fall");
});

test("AniList 请求调度器遵循每分钟共享请求预算", async () => {
  let nowMs = Date.parse("2026-07-22T00:00:00.000Z");
  const delays: number[] = [];
  const scheduler = new AniListRequestScheduler({
    now: () => nowMs,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      nowMs += delayMs;
    },
    requestLimit: 2
  });

  await scheduler.schedule(async () => new Response("first"));
  await scheduler.schedule(async () => new Response("second"));
  await scheduler.schedule(async () => new Response("third"));

  assert.deepEqual(delays, [60_000]);
  assert.equal(ANILIST_REQUEST_LIMIT_PER_MINUTE, 90);
});

test("AniList 请求调度器读取 remaining、reset 和 Retry-After 冷却", async () => {
  let nowMs = Date.parse("2026-07-22T00:00:00.000Z");
  const delays: number[] = [];
  const scheduler = new AniListRequestScheduler({
    now: () => nowMs,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      nowMs += delayMs;
    }
  });

  await scheduler.schedule(async () => new Response("last available", {
    headers: {
      "X-RateLimit-Limit": "90",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(Math.trunc((nowMs + 30_000) / 1000))
    }
  }));
  await scheduler.schedule(async () => new Response("after reset"));
  await scheduler.schedule(async () => new Response("limited", {
    status: 429,
    headers: { "Retry-After": "12" }
  }));
  await scheduler.schedule(async () => new Response("after retry"));

  assert.deepEqual(delays, [30_000, 12_000]);
});
