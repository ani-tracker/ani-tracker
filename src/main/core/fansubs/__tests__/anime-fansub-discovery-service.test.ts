import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { FansubGroup, MyAnime, Release, ReleaseSourceConfig } from "@shared/domain";
import { AnimeFansubDiscoveryService } from "../anime-fansub-discovery-service";

test("AnimeFansubDiscoveryService 单次 RSS 请求发现多个字幕组", async () => {
  const repository = new FakeDiscoveryRepository();
  let requestCount = 0;
  const httpClient = {
    async fetch(): Promise<Response> {
      requestCount += 1;
      return new Response(`
        <rss><channel>
          <item><title>[Nix-Raws] 测试番 - 01 [1080p]</title><guid>release-1</guid></item>
          <item><title>[LoliHouse] 测试番 - 01 [1080p]</title><guid>release-2</guid></item>
        </channel></rss>
      `, { status: 200 });
    }
  };

  await new AnimeFansubDiscoveryService(repository, httpClient).discover(createMyAnime());

  assert.equal(requestCount, 1);
  assert.equal(repository.observedReleases.length, 2);
  assert.equal(repository.observedReleases.every((release) => release.fansubGroupId?.startsWith("fansub-auto-")), true);
});

class FakeDiscoveryRepository {
  observedReleases: Release[] = [];

  async listFansubs(_animeId?: string): Promise<FansubGroup[]> {
    return [];
  }

  async listSources(): Promise<ReleaseSourceConfig[]> {
    return [{
      id: "rss-test",
      name: "测试 RSS",
      kind: "rss",
      enabled: true,
      rssUrl: "https://example.test/rss"
    }];
  }

  async observeAnimeFansubs(_animeId: string, releases: Release[]): Promise<FansubGroup[]> {
    this.observedReleases = releases;
    return releases.flatMap((release) => release.fansubGroupId && release.fansubName
      ? [{ id: release.fansubGroupId, name: release.fansubName, aliases: [], sourceIds: [release.sourceId] }]
      : []);
  }
}

/** 创建后台字幕组发现使用的最小追番数据。 */
function createMyAnime(): MyAnime {
  const timestamp = new Date().toISOString();
  return {
    id: "my-anime-test",
    anime: {
      id: "anime-test",
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
