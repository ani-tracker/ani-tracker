import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { AnimeSourceBinding, AppSettings, DownloadTask, Episode, EpisodePreference, FansubGroup, MyAnime, Release, ReleaseSourceConfig } from "@shared/domain";
import { createDefaultMyAnimePreferences } from "@shared/my-anime-policy";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import type { AppRepository } from "../../repositories/app-repository";
import { AutomationRunService } from "../automation-run-service";
import { resolveAnimeDownloadPath } from "../../downloads/download-path-resolver";

const baseSettings = new GenericDefaultSettingsProvider({
  downloads: "/test/Downloads",
  userData: "/test/UserData",
  cache: "/test/Cache",
  logs: "/test/Logs"
}).getSettings();
const defaultSettings: AppSettings = {
  ...baseSettings,
  download: {
    ...baseSettings.download,
    defaultTorrentEngine: "embedded",
    embedded: {
      ...baseSettings.download.embedded,
      enabled: true
    }
  }
};

test("新增追番默认启用自动下载并偏好 1080p HEVC 10bit", () => {
  assert.deepEqual(createDefaultMyAnimePreferences(), {
    autoDownload: true,
    preferredResolution: "1080p",
    preferredCodec: "H.265/HEVC",
    preferredBitDepth: 10,
    preferredSubtitleLanguages: ["chs"]
  });
});

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
  assert.equal(repository.downloads[0].savePath, resolveAnimeDownloadPath(defaultSettings, repository.myAnime[0]));
  assert.equal(repository.episodes[0].status, "downloading");
});

test("AutomationRunService 优先使用追番 RSS 且命中后不请求全局源", async (t) => {
  const requestedUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "https://example.test/personal.xml") {
      return createRssResponse([
        {
          title: "[默认字幕组] 测试番 - 01 [1080p][HEVC][简体]",
          guid: "personal-release",
          magnet: "magnet:?xt=urn:btih:PERSONAL01&dn=personal"
        }
      ]);
    }

    throw new Error(`不应请求全局源：${url}`);
  });

  const repository = new FakeAutomationRepository({
    settings: defaultSettings,
    myAnime: [
      createMyAnime({
        defaultFansubGroupId: "fansub-default",
        rssSubscriptions: [
          createRssSubscription({
            id: "rss-personal",
            url: "https://example.test/personal.xml"
          })
        ]
      })
    ],
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });

  const result = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.deepEqual(requestedUrls, ["https://example.test/personal.xml"]);
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.downloaded[0].releaseId, "rss-subscription:rss-personal:personal-release");
  assert.equal(repository.downloads[0].releaseId, "rss-subscription:rss-personal:personal-release");
  assert.equal(repository.myAnime[0].rssSubscriptions?.[0].refreshIntervalMinutes, 20);
  assert.match(repository.myAnime[0].rssSubscriptions?.[0].lastFetchedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("AutomationRunService 在追番 RSS 无结果时回退普通下载源", async (t) => {
  const requestedUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "https://example.test/empty-personal.xml") {
      return createRssResponse([]);
    }
    if (url === "https://example.test/feed.xml") {
      return createRssResponse([
        {
          title: "[默认字幕组] 测试番 - 01 [1080p][HEVC][简体]",
          guid: "fallback-empty-release",
          magnet: "magnet:?xt=urn:btih:FALLBACKEMPTY01&dn=fallback"
        }
      ]);
    }
    throw new Error(`未预期的请求：${url}`);
  });
  const repository = new FakeAutomationRepository({
    settings: defaultSettings,
    myAnime: [createMyAnime({
      rssSubscriptions: [createRssSubscription({
        id: "rss-empty",
        url: "https://example.test/empty-personal.xml"
      })]
    })],
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });

  const result = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.deepEqual(requestedUrls, [
    "https://example.test/empty-personal.xml",
    "https://example.test/feed.xml"
  ]);
  assert.equal(result.downloaded[0].releaseId, "rss-test:fallback-empty-release");
});

test("AutomationRunService 在追番 RSS 失败时回退普通下载源", async (t) => {
  const requestedUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "https://rss-failure.example.test/personal.xml") {
      return new Response("unavailable", { status: 503, statusText: "Unavailable" });
    }
    if (url === "https://example.test/feed.xml") {
      return createRssResponse([
        {
          title: "[默认字幕组] 测试番 - 01 [1080p][HEVC][简体]",
          guid: "fallback-error-release",
          magnet: "magnet:?xt=urn:btih:FALLBACKERROR01&dn=fallback"
        }
      ]);
    }
    throw new Error(`未预期的请求：${url}`);
  });
  const repository = new FakeAutomationRepository({
    settings: defaultSettings,
    myAnime: [createMyAnime({
      rssSubscriptions: [createRssSubscription({
        id: "rss-failure",
        url: "https://rss-failure.example.test/personal.xml"
      })]
    })],
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });

  const result = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.deepEqual(requestedUrls, [
    "https://rss-failure.example.test/personal.xml",
    "https://example.test/feed.xml"
  ]);
  assert.equal(result.downloaded[0].releaseId, "rss-test:fallback-error-release");
});

test("AutomationRunService 在 RSS 刷新间隔内复用订阅缓存", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    assert.equal(String(input), "https://example.test/cache.xml");
    fetchCount += 1;
    return createRssResponse([
      {
        title: "[默认字幕组] 测试番 - 01 [1080p][HEVC][简体]",
        guid: "cache-release",
        magnet: "magnet:?xt=urn:btih:CACHE01&dn=cache"
      }
    ]);
  });

  const repository = new FakeAutomationRepository({
    settings: defaultSettings,
    myAnime: [
      createMyAnime({
        defaultFansubGroupId: "fansub-default",
        rssSubscriptions: [
          createRssSubscription({
            id: "rss-cache",
            url: "https://example.test/cache.xml",
            refreshIntervalMinutes: 20
          })
        ]
      })
    ],
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: []
  });

  const first = await new AutomationRunService(repository.asAppRepository()).runOnce();
  repository.downloads = [];
  repository.episodes = [{ ...createEpisode(), status: "aired" }];
  const second = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.equal(fetchCount, 1);
  assert.equal(first.downloaded.length, 1);
  assert.equal(second.downloaded.length, 1);
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

test("AutomationRunService 跳过已完成和已弃追番", async () => {
  const myAnime = [
    createMyAnime({ id: "my-completed", status: "completed" }),
    createMyAnime({ id: "my-dropped", anime: { ...createMyAnime({}).anime, id: "anime-dropped" }, status: "dropped" })
  ];
  const repository = new FakeAutomationRepository({
    settings: defaultSettings,
    myAnime,
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });

  const result = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.equal(result.checkedEpisodes, 0);
  assert.equal(result.downloaded.length, 0);
  assert.deepEqual(result.skipped.map((item) => item.reason), ["追番已完成", "追番已弃"]);
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

test("AutomationRunService 在 candidate 策略空名单下不回退到任意字幕组", async (t) => {
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
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped[0].reason, "未找到匹配资源");
  assert.equal(repository.downloads.length, 0);
  assert.equal(repository.episodes[0].status, "aired");
});

test("AutomationRunService 在 candidate 策略下只允许名单内字幕组", async (t) => {
  const repository = new FakeAutomationRepository({
    settings: {
      ...defaultSettings,
      automation: {
        ...defaultSettings.automation,
        fallbackWhenDefaultFansubMissing: "candidate",
        candidateFansubNames: ["候 补字幕组"]
      }
    },
    myAnime: [createMyAnime({ defaultFansubGroupId: "fansub-default" })],
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });
  mockRssFeed(t, [
    {
      title: "[其他字幕组] 测试番 - 01 [1080p][HEVC][简体]",
      guid: "release-other",
      magnet: "magnet:?xt=urn:btih:OTHER01&dn=other"
    },
    {
      title: "[候补字幕组] 测试番 - 01 [1080p][HEVC][简体]",
      guid: "release-candidate-allowed",
      magnet: "magnet:?xt=urn:btih:CANDIDATE02&dn=candidate"
    }
  ]);

  const result = await new AutomationRunService(repository.asAppRepository()).runOnce();

  assert.equal(result.checkedEpisodes, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.downloaded[0].releaseId, "rss-test:release-candidate-allowed");
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

  async upsertMyAnime(item: MyAnime): Promise<MyAnime[]> {
    const index = this.myAnime.findIndex((entry) => entry.id === item.id);
    if (index >= 0) {
      this.myAnime[index] = item;
    } else {
      this.myAnime.push(item);
    }

    return this.myAnime;
  }

  async listDownloads(): Promise<DownloadTask[]> {
    return [...this.downloads];
  }

  async listFansubs(): Promise<FansubGroup[]> {
    return this.fansubs;
  }

  async observeAnimeFansubs(_animeId: string, _releases: Release[]): Promise<FansubGroup[]> {
    return this.fansubs;
  }

  async listSources(): Promise<ReleaseSourceConfig[]> {
    return this.sources;
  }

  async listAnimeSourceBindings(): Promise<AnimeSourceBinding[]> {
    return [];
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
    rssSubscriptions: [],
    preferredResolution: "1080p",
    preferredCodec: "H.265/HEVC",
    preferredSubtitle: "chs",
    addedAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides
  };
}

function createRssSubscription(overrides: Partial<NonNullable<MyAnime["rssSubscriptions"]>[number]>) {
  return {
    id: "rss-personal",
    myAnimeId: "my-anime-1",
    name: "个人 RSS",
    url: "https://example.test/personal.xml",
    enabled: true,
    refreshIntervalMinutes: 20,
    createdAt: "2026-07-13T00:00:00.000Z",
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

    return createRssResponse(items);
  });
}

/** 构造测试用 RSS 响应。 */
function createRssResponse(
  items: Array<{
    title: string;
    guid: string;
    magnet: string;
  }>
): Response {
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
}
