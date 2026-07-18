import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReleaseSourceConfig, ReleaseSourceSyncState } from "@shared/domain";
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
    /退避保护/
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
