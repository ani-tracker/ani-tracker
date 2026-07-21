import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReleaseSourceConfig } from "@shared/domain";
import { createSourceHttpClient, SourceRequestScheduler } from "../source-http-client";
import { collectReleasePages } from "../source-pagination";
import {
  MAX_RELEASE_SOURCE_FETCH_LIMIT,
  MAX_RELEASE_SOURCE_RESULT_LIMIT,
  normalizeReleaseSourceResultLimit
} from "../source-query";
import { TorznabReleaseSource } from "../torznab-source";

test("下载源分页按 50 条累计、去重并限制目标总数", async () => {
  const pageLimits: number[] = [];
  const releases = await collectReleasePages(80, async ({ page, limit }) => {
    pageLimits.push(limit);
    const start = page === 1 ? 0 : 49;
    return {
      items: Array.from({ length: limit }, (_, index) => ({
        id: `release-${start + index}`,
        title: `资源 ${start + index}`,
        sourceId: "pagination-test",
        sourceName: "分页测试",
        publishedAt: "2026-07-22T00:00:00.000Z"
      }))
    };
  });

  assert.deepEqual(pageLimits, [50, 30]);
  assert.equal(releases.length, 79);
  assert.equal(new Set(releases.map((release) => release.id)).size, 79);
  assert.equal(normalizeReleaseSourceResultLimit(500), MAX_RELEASE_SOURCE_RESULT_LIMIT);
  assert.equal(MAX_RELEASE_SOURCE_FETCH_LIMIT, 50);
});

test("Torznab 每个分页请求都经过来源间隔调度", async () => {
  let nowMs = Date.parse("2026-07-22T00:00:00.000Z");
  const delays: number[] = [];
  const requests: URL[] = [];
  const config: ReleaseSourceConfig = {
    id: "torznab-pagination-test",
    name: "Torznab 分页测试",
    kind: "torznab",
    enabled: true,
    useProxy: true,
    requestIntervalMs: 1_000,
    baseUrl: "https://indexer.example.test/"
  };
  const scheduler = new SourceRequestScheduler({
    now: () => nowMs,
    random: () => 0,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      nowMs += delayMs;
    }
  });
  const transport = {
    async fetch(input: string | URL) {
      const url = new URL(input.toString());
      requests.push(url);
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return new Response(createTorznabPage(offset, limit));
    }
  };
  const source = new TorznabReleaseSource(
    config,
    createSourceHttpClient(config, transport, undefined, scheduler)
  );

  const releases = await source.searchReleases({ keyword: "测试番", limit: 80 });

  assert.deepEqual(requests.map((url) => url.searchParams.get("limit")), ["50", "30"]);
  assert.deepEqual(requests.map((url) => url.searchParams.get("offset")), ["0", "50"]);
  assert.deepEqual(delays.filter((delay) => delay > 0), [1_000]);
  assert.equal(releases.length, 80);
});

/** 生成指定 offset 和数量的 Torznab 测试页。 */
function createTorznabPage(offset: number, limit: number): string {
  const items = Array.from({ length: limit }, (_, index) => {
    const id = offset + index;
    return `<item><title>测试番 - ${id}</title><guid>guid-${id}</guid><link>magnet:?xt=urn:btih:${id}</link></item>`;
  }).join("");
  return `<rss><channel>${items}</channel></rss>`;
}
