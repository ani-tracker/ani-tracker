import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RequestCircuitState } from "@shared/domain";
import {
  RequestCircuitBreaker,
  type RequestCircuitStateStore,
  type RequestCircuitTarget
} from "../request-circuit-breaker";

const target: RequestCircuitTarget = {
  key: "metadata:test",
  group: "metadata",
  name: "测试元数据源",
  shareByHost: true
};

test("RequestCircuitBreaker 持久化 Retry-After 并在到期前拒绝请求", async () => {
  const nowMs = Date.parse("2026-07-21T00:00:00.000Z");
  const store = new MemoryCircuitStateStore();
  const breaker = new RequestCircuitBreaker({ now: () => nowMs });

  const response = await breaker.execute(
    target,
    "https://example.test/data",
    async () => new Response("limited", { status: 429, headers: { "Retry-After": "120" } }),
    { stateStore: store }
  );

  assert.equal(response.status, 429);
  assert.equal(store.states[0].failureCount, 1);
  assert.equal(Date.parse(store.states[0].backoffUntil!) - nowMs, 120_000);
  await assert.rejects(
    breaker.execute(target, "https://example.test/after", async () => new Response("unexpected"), {
      stateStore: store
    }),
    /熔断保护/
  );
});

test("RequestCircuitBreaker 熔断到期后只允许一个半开探测请求", async () => {
  const nowMs = Date.parse("2026-07-21T00:10:00.000Z");
  const store = new MemoryCircuitStateStore([{
    key: target.key,
    group: target.group,
    requestHost: "example.test",
    failureCount: 1,
    backoffUntil: new Date(nowMs).toISOString()
  }]);
  const breaker = new RequestCircuitBreaker({ now: () => nowMs });
  let resolveProbe!: (response: Response) => void;
  let markProbeStarted!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    markProbeStarted = resolve;
  });

  const first = breaker.execute(target, "https://example.test/probe", async () => {
    markProbeStarted();
    return new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
  }, { stateStore: store });
  await probeStarted;

  await assert.rejects(
    breaker.execute(target, "https://example.test/probe-2", async () => new Response("unexpected"), {
      stateStore: store
    }),
    /恢复探测/
  );
  resolveProbe(new Response("ok"));
  assert.equal((await first).status, 200);
  assert.equal(store.states[0].failureCount, 0);
  assert.equal(store.states[0].backoffUntil, undefined);
});

test("RequestCircuitBreaker 不用较早发出的成功响应覆盖较新的熔断状态", async () => {
  const nowMs = Date.parse("2026-07-21T00:00:00.000Z");
  const store = new MemoryCircuitStateStore();
  const breaker = new RequestCircuitBreaker({ now: () => nowMs });
  let resolveFailure!: (response: Response) => void;
  let resolveSuccess!: (response: Response) => void;
  let markFailureStarted!: () => void;
  let markSuccessStarted!: () => void;
  const failureStarted = new Promise<void>((resolve) => {
    markFailureStarted = resolve;
  });
  const successStarted = new Promise<void>((resolve) => {
    markSuccessStarted = resolve;
  });

  const failure = breaker.execute(target, "https://example.test/failure", () =>
    new Promise<Response>((resolve) => {
      markFailureStarted();
      resolveFailure = resolve;
    }), { stateStore: store });
  const success = breaker.execute(target, "https://example.test/success", () =>
    new Promise<Response>((resolve) => {
      markSuccessStarted();
      resolveSuccess = resolve;
    }), { stateStore: store });

  await Promise.all([failureStarted, successStarted]);
  resolveFailure(new Response("unavailable", { status: 503 }));
  await failure;
  resolveSuccess(new Response("ok"));
  await success;

  assert.equal(store.states[0].failureCount, 1);
  assert.ok(store.states[0].backoffUntil);
});

test("RequestCircuitBreaker 半开成功不清除探测开始后产生的同域熔断", async () => {
  let nowMs = Date.parse("2026-07-21T00:00:00.000Z");
  const store = new MemoryCircuitStateStore();
  const breaker = new RequestCircuitBreaker({ now: () => nowMs });
  const relatedTarget = { ...target, key: "metadata:related", name: "关联来源" };
  const probeTarget = { ...target, key: "metadata:probe", name: "探测来源" };
  let resolveOldFailure!: (response: Response) => void;
  let markOldRequestStarted!: () => void;
  const oldRequestStarted = new Promise<void>((resolve) => {
    markOldRequestStarted = resolve;
  });
  const oldFailure = breaker.execute(relatedTarget, "https://example.test/old", () =>
    new Promise<Response>((resolve) => {
      markOldRequestStarted();
      resolveOldFailure = resolve;
    }), { stateStore: store });
  await oldRequestStarted;

  await breaker.execute(
    relatedTarget,
    "https://example.test/current",
    async () => new Response("unavailable", { status: 503 }),
    { stateStore: store }
  );
  nowMs += 30_000;

  let resolveProbe!: (response: Response) => void;
  let markProbeStarted!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    markProbeStarted = resolve;
  });
  const probe = breaker.execute(probeTarget, "https://example.test/probe", () =>
    new Promise<Response>((resolve) => {
      markProbeStarted();
      resolveProbe = resolve;
    }), { stateStore: store });
  await probeStarted;

  resolveOldFailure(new Response("unavailable", { status: 503 }));
  await oldFailure;
  resolveProbe(new Response("ok"));
  await probe;

  const relatedState = store.states.find((state) => state.key === relatedTarget.key);
  assert.equal(relatedState?.failureCount, 2);
  assert.ok(Date.parse(relatedState?.backoffUntil ?? "") > nowMs);
});

test("RequestCircuitBreaker 持久化状态清空后同步移除进程缓存", async () => {
  const nowMs = Date.parse("2026-07-21T00:00:00.000Z");
  const store = new MemoryCircuitStateStore([{
    key: target.key,
    group: target.group,
    requestHost: "example.test",
    failureCount: 1,
    backoffUntil: new Date(nowMs + 60_000).toISOString()
  }]);
  const breaker = new RequestCircuitBreaker({ now: () => nowMs });

  assert.equal((await breaker.getState(target, store)).failureCount, 1);
  store.states = [];
  assert.equal((await breaker.getState(target, store)).failureCount, 0);
});

test("RequestCircuitBreaker 支持替换响应退避策略", async () => {
  const nowMs = Date.parse("2026-07-21T00:00:00.000Z");
  const store = new MemoryCircuitStateStore();
  const breaker = new RequestCircuitBreaker({
    now: () => nowMs,
    policy: {
      resolveBackoffMs: (outcome) => outcome.kind === "response" && outcome.response.status === 418
        ? 45_000
        : undefined
    }
  });

  await breaker.execute(
    target,
    "https://example.test/custom-policy",
    async () => new Response("custom", { status: 418 }),
    { stateStore: store }
  );

  assert.equal(store.states[0].failureCount, 1);
  assert.equal(Date.parse(store.states[0].backoffUntil!) - nowMs, 45_000);
});

class MemoryCircuitStateStore implements RequestCircuitStateStore {
  constructor(public states: RequestCircuitState[] = []) {}

  async listRequestCircuitStates(): Promise<RequestCircuitState[]> {
    return this.states.map((state) => ({ ...state }));
  }

  async upsertRequestCircuitState(state: RequestCircuitState): Promise<RequestCircuitState[]> {
    this.states = [...this.states.filter((item) => item.key !== state.key), { ...state }];
    return this.listRequestCircuitStates();
  }
}
