import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { AppSettings, DownloadTask, Episode, EpisodePreference, FansubGroup, MyAnime, ReleaseSourceConfig } from "@shared/domain";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import type { AppRepository } from "../../repositories/app-repository";
import { AutomationRunService } from "../automation-run-service";

const defaultSettings = new GenericDefaultSettingsProvider({
  downloads: "/test/Downloads",
  userData: "/test/UserData",
  cache: "/test/Cache",
  logs: "/test/Logs"
}).getSettings();

test("AutomationRunService 使用单集字幕组覆盖选择最佳资源并写回下载状态", async (t) => {
  const repository = new FakeAutomationRepository({
    settings: defaultSettings,
    myAnime: [createMyAnime({ defaultFansubGroupId: "fansub-default" })],
    episodes: [createEpisode()],
    preferences: [
      {
        id: "pref-1",
        animeId: "anime-1",
        episodeId: "episode-1",
        fansubGroupId: "fansub-override",
        isManualOverride: true
      }
    ],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });
  mockRssFeed(t, [
    {
      title: "[默认字幕组] 测试番 - 01 [1080p][HEVC][简体]",
      guid: "release-default",
      magnet: "magnet:?xt=urn:btih:DEFAULT01&dn=default"
    },
    {
      title: "[覆盖字幕组] 测试番 - 01 [1080p][HEVC][简体]",
      guid: "release-override",
      magnet: "magnet:?xt=urn:btih:OVERRIDE01&dn=override"
    }
  ]);

  const result = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.equal(result.checkedEpisodes, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.downloaded[0].releaseId, "rss-test:release-override");
  assert.equal(result.downloaded[0].releaseTitle, "[覆盖字幕组] 测试番 - 01 [1080p][HEVC][简体]");
  assert.equal(repository.downloads.length, 1);
  assert.equal(repository.downloads[0].releaseId, "rss-test:release-override");
  assert.equal(repository.downloads[0].savePath, defaultSettings.download.defaultDownloadDir);
  assert.equal(repository.episodes[0].status, "downloading");
});

test("AutomationRunService 遇到已有下载任务时跳过单集且不搜索来源", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCount += 1;
    return new Response("<rss><channel /></rss>", { status: 200, statusText: "OK" });
  });

  const repository = new FakeAutomationRepository({
    settings: defaultSettings,
    myAnime: [createMyAnime({})],
    episodes: [createEpisode()],
    downloads: [
      {
        id: "existing-task",
        releaseId: "release-existing",
        animeId: "anime-1",
        episodeId: "episode-1",
        engine: "embedded",
        name: "已有任务",
        status: "downloading",
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        savePath: "/test/Downloads/Ani Tracker",
        files: [],
        createdAt: "2026-07-13T00:00:00.000Z"
      }
    ],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });

  const result = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.equal(fetchCount, 0);
  assert.equal(result.checkedEpisodes, 1);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "已有下载任务");
  assert.equal(repository.episodes[0].status, "aired");
});

test("AutomationRunService 全局自动下载关闭时提前跳过", async () => {
  const repository = new FakeAutomationRepository({
    settings: {
      ...defaultSettings,
      automation: {
        ...defaultSettings.automation,
        autoDownloadEnabledGlobally: false
      }
    },
    myAnime: [createMyAnime({})],
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });

  const result = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.equal(result.checkedEpisodes, 0);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "全局自动下载未开启");
});

test("AutomationRunService 在 wait 策略下不回退到非默认字幕组候选", async (t) => {
  const repository = new FakeAutomationRepository({
    settings: {
      ...defaultSettings,
      automation: {
        ...defaultSettings.automation,
        fallbackWhenDefaultFansubMissing: "wait"
      }
    },
    myAnime: [createMyAnime({ defaultFansubGroupId: "fansub-default" })],
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });
  mockRssFeed(t, [
    {
      title: "[候补字幕组] 测试番 - 01 [1080p][HEVC][简体]",
      guid: "release-candidate",
      magnet: "magnet:?xt=urn:btih:CANDIDATE01&dn=candidate"
    }
  ]);

  const result = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.equal(result.checkedEpisodes, 1);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "未找到匹配资源");
  assert.equal(repository.downloads.length, 0);
  assert.equal(repository.episodes[0].status, "aired");
});

test("AutomationRunService 在 candidate 策略下允许使用非默认字幕组候选", async (t) => {
  const repository = new FakeAutomationRepository({
    settings: {
      ...defaultSettings,
      automation: {
        ...defaultSettings.automation,
        fallbackWhenDefaultFansubMissing: "candidate"
      }
    },
    myAnime: [createMyAnime({ defaultFansubGroupId: "fansub-default" })],
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });
  mockRssFeed(t, [
    {
      title: "[候补字幕组] 测试番 - 01 [1080p][HEVC][简体]",
      guid: "release-candidate",
      magnet: "magnet:?xt=urn:btih:CANDIDATE01&dn=candidate"
    }
  ]);

  const result = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.equal(result.checkedEpisodes, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.downloaded[0].releaseId, "rss-test:release-candidate");
  assert.equal(repository.downloads.length, 1);
  assert.equal(repository.episodes[0].status, "downloading");
});

interface FakeAutomationRepositoryData {
  settings: AppSettings;
  myAnime?: MyAnime[];
  episodes?: Episode[];
  preferences?: EpisodePreference[];
  downloads?: DownloadTask[];
  fansubs?: FansubGroup[];
  sources?: ReleaseSourceConfig[];
}

class FakeAutomationRepository {
  settings: AppSettings;
  myAnime: MyAnime[];
  episodes: Episode[];
  preferences: EpisodePreference[];
  downloads: DownloadTask[];
  fansubs: FansubGroup[];
  sources: ReleaseSourceConfig[];

  constructor(data: FakeAutomationRepositoryData) {
    this.settings = data.settings;
    this.myAnime = data.myAnime ?? [];
    this.episodes = data.episodes ?? [];
    this.preferences = data.preferences ?? [];
    this.downloads = data.downloads ?? [];
    this.fansubs = data.fansubs ?? [];
    this.sources = data.sources ?? [];
  }

  asAppRepository(): AppRepository {
    return this as unknown as AppRepository;
  }

  async getSettings(): Promise<AppSettings> {
    return this.settings;
  }

  async listMyAnime(): Promise<MyAnime[]> {
    return this.myAnime;
  }

  async listDownloads(): Promise<DownloadTask[]> {
    return [...this.downloads];
  }

  async listFansubs(): Promise<FansubGroup[]> {
    return this.fansubs;
  }

  async listSources(): Promise<ReleaseSourceConfig[]> {
    return this.sources;
  }

  async listEpisodes(animeId: string): Promise<Episode[]> {
    return this.episodes.filter((episode) => episode.animeId === animeId);
  }

  async listEpisodePreferences(animeId: string): Promise<EpisodePreference[]> {
    return this.preferences.filter((preference) => preference.animeId === animeId);
  }

  async upsertEpisode(episode: Episode): Promise<Episode[]> {
    const index = this.episodes.findIndex((item) => item.id === episode.id);
    if (index >= 0) {
      this.episodes[index] = episode;
    } else {
      this.episodes.push(episode);
    }

    return this.episodes.filter((item) => item.animeId === episode.animeId);
  }

  async upsertDownloadTask(task: DownloadTask): Promise<DownloadTask[]> {
    const index = this.downloads.findIndex((item) => item.id === task.id);
    if (index >= 0) {
      this.downloads[index] = task;
    } else {
      this.downloads.unshift(task);
    }

    return this.downloads;
  }
}

function createMyAnime(overrides: Partial<MyAnime>): MyAnime {
  return {
    id: "my-anime-1",
    anime: {
      id: "anime-1",
      title: "测试番",
      originalTitle: "テストアニメ",
      aliases: [
        {
          id: "anime-1-alias-1",
          animeId: "anime-1",
          alias: "Test Anime",
          language: "en",
          priority: 80
        }
      ],
      premiereYear: 2026,
      premiereMonth: 7,
      externalIds: {}
    },
    status: "watching",
    defaultFansubGroupId: "fansub-default",
    autoDownload: true,
    preferredResolution: "1080p",
    preferredCodec: "H.265/HEVC",
    preferredSubtitle: "chs",
    addedAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides
  };
}

function createEpisode(): Episode {
  return {
    id: "episode-1",
    animeId: "anime-1",
    episodeNo: 1,
    status: "aired",
    airTime: "2026-07-13T00:00:00.000Z"
  };
}

function createFansubs(): FansubGroup[] {
  return [
    {
      id: "fansub-default",
      name: "默认字幕组",
      aliases: [],
      sourceIds: ["rss-test"]
    },
    {
      id: "fansub-override",
      name: "覆盖字幕组",
      aliases: [],
      sourceIds: ["rss-test"]
    },
    {
      id: "fansub-candidate",
      name: "候补字幕组",
      aliases: [],
      sourceIds: ["rss-test"]
    }
  ];
}

function createRssSource(): ReleaseSourceConfig {
  return {
    id: "rss-test",
    name: "RSS 测试源",
    kind: "rss",
    enabled: true,
    rssUrl: "https://example.test/feed.xml"
  };
}

function mockRssFeed(
  t: TestContext,
  items: Array<{
    title: string;
    guid: string;
    magnet: string;
  }>
): void {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    assert.equal(String(input), "https://example.test/feed.xml");

    return new Response(
      `
        <rss>
          <channel>
            ${items
              .map(
                (item) => `
                  <item>
                    <title>${item.title}</title>
                    <link>${item.magnet.replaceAll("&", "&amp;")}</link>
                    <guid>${item.guid}</guid>
                    <pubDate>Mon, 13 Jul 2026 12:30:00 GMT</pubDate>
                  </item>
                `
              )
              .join("")}
          </channel>
        </rss>
      `,
      { status: 200, statusText: "OK" }
    );
  });
}
