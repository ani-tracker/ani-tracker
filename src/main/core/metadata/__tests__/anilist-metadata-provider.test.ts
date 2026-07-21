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
