import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AppSettings, NotificationRecord, Release, ReleaseSourceConfig, ReleaseSourceSyncState } from "@shared/domain";
import type { AppRepository } from "../../repositories/app-repository";
import { isSameLocalDay, SourceSyncService } from "../source-sync-service";
import { normalizeDailyTime, resolveNextRunAt } from "../source-sync-scheduler";

test("SourceSyncService 仅补跑当天未成功来源并保存条件请求游标", async () => {
  const now = new Date(2026, 6, 18, 10, 0, 0);
  const repository = new SourceSyncRepository(now);
  let fetchCount = 0;
  const service = new SourceSyncService(repository as unknown as AppRepository, () => ({
    fetch: async (_input, options) => {
      fetchCount += 1;
      assert.equal(new Headers(options?.headers).get("If-None-Match"), "old-etag");
      return new Response(createRssXml(), {
        status: 200,
        headers: { ETag: "new-etag", "Last-Modified": "Fri, 18 Jul 2026 01:00:00 GMT" }
      });
    }
  }));

  const first = await service.run({ now });
  assert.deepEqual(first.syncedSourceIds, ["pending-rss"]);
  assert.deepEqual(first.skippedSourceIds, ["synced-rss"]);
  assert.equal(first.addedReleaseCount, 1);
  assert.equal(fetchCount, 1);
  const pendingState = repository.states.find((state) => state.sourceId === "pending-rss");
  assert.equal(pendingState?.lastSuccessfulSyncAt, now.toISOString());
  assert.equal(pendingState?.etag, "new-etag");

  const second = await service.run({ now });
  assert.equal(second.syncedSourceIds.length, 0);
  assert.equal(second.skippedSourceIds.length, 2);
  assert.equal(fetchCount, 1);
});

test("SourceSyncService 通知显示失败来源、真实原因和熔断状态", async () => {
  const now = new Date();
  const repository = new SourceSyncRepository(now);
  repository.sources.splice(0, repository.sources.length, {
    id: "anibt-notification-test",
    name: "AniBT",
    kind: "rss",
    enabled: true,
    useProxy: true,
    requestIntervalMs: 250,
    rssUrl: "https://sync-failure.example.test/feed.xml"
  });
  repository.states = [{
    sourceId: "anibt-notification-test",
    requestFailureCount: 0
  }];
  const service = new SourceSyncService(repository as unknown as AppRepository, () => ({
    fetch: async () => new Response("forbidden", { status: 403, statusText: "Forbidden" })
  }));

  const first = await service.run({ force: true, now });
  assert.equal(first.errors[0].message, "RSS source failed: 403 Forbidden");
  assert.equal(repository.notifications[0].title, "AniBT 同步失败");
  assert.match(repository.notifications[0].body, /失败来源：AniBT（anibt-notification-test）/);
  assert.match(repository.notifications[0].body, /原因：RSS source failed: 403 Forbidden/);
  assert.match(repository.notifications[0].body, /连续失败 1 次/);
  assert.match(repository.notifications[0].body, /熔断至/);

  const second = await service.run({ force: true, now });
  assert.equal(second.errors[0].message, "RSS source failed: 403 Forbidden");
  assert.match(repository.notifications[1].body, /原因：RSS source failed: 403 Forbidden/);
  assert.doesNotMatch(repository.notifications[1].body, /正在熔断保护中/);
});

test("每日同步时间按本地时间计算并在错过后顺延一天", () => {
  const now = new Date(2026, 6, 18, 10, 30, 0);
  const next = resolveNextRunAt(now, "09:00");
  assert.equal(next.getDate(), 19);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.equal(normalizeDailyTime("25:00"), "09:00");
  assert.equal(isSameLocalDay(new Date(2026, 6, 18, 0, 1).toISOString(), now), true);
});

class SourceSyncRepository {
  readonly sources: ReleaseSourceConfig[] = [
    {
      id: "synced-rss",
      name: "当天已同步",
      kind: "rss",
      enabled: true,
      useProxy: true,
      requestIntervalMs: 250,
      rssUrl: "https://synced.example.test/feed.xml"
    },
    {
      id: "pending-rss",
      name: "等待补跑",
      kind: "rss",
      enabled: true,
      useProxy: true,
      requestIntervalMs: 250,
      rssUrl: "https://pending.example.test/feed.xml"
    }
  ];
  states: ReleaseSourceSyncState[];
  releases: Release[] = [];
  notifications: NotificationRecord[] = [];

  constructor(now: Date) {
    this.states = [
      {
        sourceId: "synced-rss",
        requestFailureCount: 0,
        lastSuccessfulSyncAt: now.toISOString()
      },
      {
        sourceId: "pending-rss",
        requestFailureCount: 0,
        lastSuccessfulSyncAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        etag: "old-etag"
      }
    ];
  }

  async getSettings(): Promise<AppSettings> {
    return {
      network: {
        metadataProxy: { mode: "off", timeoutMs: 15_000 },
        remoteAccess: { lanEnabled: false, port: 18_083 }
      }
    } as AppSettings;
  }

  async listSources(): Promise<ReleaseSourceConfig[]> {
    return this.sources;
  }

  async listSourceSyncStates(): Promise<ReleaseSourceSyncState[]> {
    return this.states.map((state) => ({ ...state }));
  }

  async upsertSourceSyncState(state: ReleaseSourceSyncState): Promise<ReleaseSourceSyncState[]> {
    this.states = [...this.states.filter((item) => item.sourceId !== state.sourceId), { ...state }];
    return this.listSourceSyncStates();
  }

  async upsertCachedReleases(releases: Release[]): Promise<number> {
    const existing = new Set(this.releases.map((release) => release.id));
    this.releases = [...this.releases.filter((release) => !releases.some((item) => item.id === release.id)), ...releases];
    return releases.filter((release) => !existing.has(release.id)).length;
  }

  async pruneCachedReleases(): Promise<number> {
    return 0;
  }

  async addNotifications(records: NotificationRecord[]): Promise<NotificationRecord[]> {
    this.notifications.push(...records);
    return this.notifications;
  }
}

function createRssXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><item>
      <title>[测试组] 增量同步番 - 01 [1080p]</title>
      <guid>incremental-release-1</guid>
      <link>magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567</link>
      <pubDate>Fri, 18 Jul 2026 01:00:00 GMT</pubDate>
    </item></channel></rss>`;
}
