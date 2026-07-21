import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReleaseSourceConfig, ReleaseSourceSyncState } from "@shared/domain";
import { shouldUseSourceProxy } from "@shared/source-network-policy";
import {
  SourceRequestScheduler,
  type SourceRequestStateStore
} from "../source-http-client";

const source: ReleaseSourceConfig = {
  id: "source-policy-test",
  name: "来源策略测试",
  kind: "rss",
  enabled: true,
  useProxy: true,
  requestIntervalMs: 1_000,
  rssUrl: "https://example.test/feed.xml"
};

test("AniBT 忽略旧配置中的代理开关并固定直连", () => {
  assert.equal(shouldUseSourceProxy({
    ...source,
    id: "anibt",
    name: "AniBT",
    useProxy: true
  }), false);
  assert.equal(shouldUseSourceProxy(source, "https://anibt.net/rss/magnets.xml?limit=50"), false);
  assert.equal(shouldUseSourceProxy(source), true);
});

test("SourceRequestScheduler 合并同一来源的并发相同请求", async () => {
  const scheduler = new SourceRequestScheduler({ random: () => 0 });
  let callCount = 0;
  let resolveResponse!: (response: Response) => void;
  let markOperationReady!: () => void;
  const operationReady = new Promise<void>((resolve) => {
    markOperationReady = resolve;
  });
  const operation = () => {
    callCount += 1;
    return new Promise<Response>((resolve) => {
      resolveResponse = resolve;
      markOperationReady();
    });
  };

  const first = scheduler.schedule(source, source.rssUrl!, {}, operation);
  const second = scheduler.schedule(source, source.rssUrl!, {}, operation);
  await operationReady;
  resolveResponse(new Response("ok", { status: 200 }));

  assert.equal(await (await first).text(), "ok");
  assert.equal(await (await second).text(), "ok");
  assert.equal(callCount, 1);
});

test("SourceRequestScheduler 对同域名请求应用最小间隔和抖动", async () => {
  let nowMs = Date.parse("2026-07-18T00:00:00.000Z");
  const delays: number[] = [];
  const scheduler = new SourceRequestScheduler({
    now: () => nowMs,
    random: () => 0.5,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      nowMs += delayMs;
    }
  });

  await scheduler.schedule(source, "https://example.test/first", {}, async () => new Response("first"));
  await scheduler.schedule(source, "https://example.test/second", {}, async () => new Response("second"));

  assert.equal(delays.filter((delay) => delay > 0)[0], 1_100);
});

test("SourceRequestScheduler 对 AniBT 不同入口统一限制为每三秒最多一次", async () => {
  let nowMs = Date.parse("2026-07-18T00:00:00.000Z");
  const delays: number[] = [];
  const scheduler = new SourceRequestScheduler({
    now: () => nowMs,
    random: () => 0,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      nowMs += delayMs;
    }
  });
  const anibtSource = {
    ...source,
    id: "anibt",
    name: "AniBT",
    requestIntervalMs: 250,
    rssUrl: "https://anibt.net/rss/magnets.xml"
  };
  const subscriptionSource = {
    ...source,
    id: "rss-subscription:anibt-test",
    name: "AniBT 番剧订阅",
    requestIntervalMs: undefined,
    rssUrl: "https://anibt.net/rss/anime.xml?bgmId=528828"
  };

  await scheduler.schedule(anibtSource, anibtSource.rssUrl!, {}, async () => new Response("first"));
  await scheduler.schedule(subscriptionSource, subscriptionSource.rssUrl!, {}, async () => new Response("second"));

  assert.equal(delays.filter((delay) => delay > 0)[0], 3_000);
});

test("SourceRequestScheduler 持久化 Retry-After，重建后仍拒绝提前请求", async () => {
  const nowMs = Date.parse("2026-07-18T00:00:00.000Z");
  const store = new MemoryStateStore();
  const firstScheduler = new SourceRequestScheduler({ now: () => nowMs, random: () => 0 });
  const response = await firstScheduler.schedule(
    source,
    source.rssUrl!,
    {},
    async () => new Response("limited", { status: 429, headers: { "Retry-After": "120" } }),
    store
  );
  assert.equal(response.status, 429);
  assert.equal(store.states[0].requestFailureCount, 1);
  assert.equal(Date.parse(store.states[0].backoffUntil!) - nowMs, 120_000);

  const secondScheduler = new SourceRequestScheduler({ now: () => nowMs, random: () => 0 });
  const sameHostSource = { ...source, id: "same-host-source", name: "同域名来源" };
  let callCount = 0;
  await assert.rejects(
    secondScheduler.schedule(sameHostSource, "https://example.test/after-restart", {}, async () => {
      callCount += 1;
      return new Response("unexpected");
    }, store),
    /熔断保护/
  );
  assert.equal(callCount, 0);
});

test("SourceRequestScheduler 对连续 403 按 10、20、30 分钟熔断", async () => {
  let nowMs = Date.parse("2026-07-18T00:00:00.000Z");
  const store = new MemoryStateStore();
  const scheduler = new SourceRequestScheduler({ now: () => nowMs, random: () => 0 });
  const expectedDurations = [10 * 60_000, 20 * 60_000, 30 * 60_000];

  for (const expectedDuration of expectedDurations) {
    const response = await scheduler.schedule(
      source,
      source.rssUrl!,
      {},
      async () => new Response("forbidden", { status: 403 }),
      store
    );
    assert.equal(response.status, 403);
    const backoffUntil = Date.parse(store.states[0].backoffUntil!);
    assert.equal(backoffUntil - nowMs, expectedDuration);
    nowMs = backoffUntil;
  }

  assert.equal(store.states[0].requestFailureCount, 3);
});

test("SourceRequestScheduler 熔断到期后只放行一个半开探测请求", async () => {
  const nowMs = Date.parse("2026-07-18T00:10:00.000Z");
  const store = new MemoryStateStore();
  store.states = [{
    sourceId: source.id,
    requestHost: "example.test",
    requestFailureCount: 1,
    backoffUntil: new Date(nowMs).toISOString()
  }];
  const scheduler = new SourceRequestScheduler({ now: () => nowMs, random: () => 0 });
  let callCount = 0;
  let resolveProbe!: (response: Response) => void;
  let markProbeStarted!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    markProbeStarted = resolve;
  });
  const first = scheduler.schedule(source, "https://example.test/probe-1", {}, async () => {
    callCount += 1;
    markProbeStarted();
    return new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
  }, store);
  const second = scheduler.schedule(source, "https://example.test/probe-2", {}, async () => {
    callCount += 1;
    return new Response("unexpected");
  }, store);

  await probeStarted;
  resolveProbe(new Response("forbidden", { status: 403 }));
  assert.equal((await first).status, 403);
  await assert.rejects(second, /熔断保护/);
  assert.equal(callCount, 1);
});

test("SourceRequestScheduler 将未持久化入口的 AniBT 熔断共享给持久化请求", async () => {
  const nowMs = Date.parse("2026-07-18T00:00:00.000Z");
  const scheduler = new SourceRequestScheduler({ now: () => nowMs, random: () => 0 });
  const store = new MemoryStateStore();
  const subscriptionSource = {
    ...source,
    id: "rss-subscription:anibt-test",
    name: "AniBT 番剧订阅",
    rssUrl: "https://anibt.net/rss/anime.xml?bgmId=528828"
  };

  await scheduler.schedule(
    subscriptionSource,
    subscriptionSource.rssUrl!,
    {},
    async () => new Response("forbidden", { status: 403 })
  );

  let callCount = 0;
  await assert.rejects(
    scheduler.schedule(
      { ...source, id: "anibt", name: "AniBT" },
      "https://anibt.net/rss/magnets.xml",
      {},
      async () => {
        callCount += 1;
        return new Response("unexpected");
      },
      store
    ),
    /熔断保护/
  );
  assert.equal(callCount, 0);
});

class MemoryStateStore implements SourceRequestStateStore {
  states: ReleaseSourceSyncState[] = [];

  async listSourceSyncStates(): Promise<ReleaseSourceSyncState[]> {
    return this.states.map((state) => ({ ...state }));
  }

  async upsertSourceSyncState(state: ReleaseSourceSyncState): Promise<ReleaseSourceSyncState[]> {
    this.states = [...this.states.filter((item) => item.sourceId !== state.sourceId), { ...state }];
    return this.listSourceSyncStates();
  }
}
