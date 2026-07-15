import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type {
  AnimeSourceBinding,
  AppSettings,
  DownloadTask,
  Episode,
  EpisodePreference,
  FansubGroup,
  MyAnime,
  NotificationRecord,
  Release,
  ReleaseSourceConfig
} from "@shared/domain";
import type { AutomationRunResult } from "@shared/contracts";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import type { AppRepository } from "../../repositories/app-repository";
import { AutomationScheduler } from "../automation-scheduler";

const defaultSettings = new GenericDefaultSettingsProvider({
  downloads: "/test/Downloads",
  userData: "/test/UserData",
  cache: "/test/Cache",
  logs: "/test/Logs"
}).getSettings();

test("AutomationScheduler 在 notify_only 策略下写入无下载摘要通知", async (t) => {
  const repository = new FakeSchedulerRepository({
    settings: {
      ...defaultSettings,
      automation: {
        ...defaultSettings.automation,
        fallbackWhenDefaultFansubMissing: "notify_only"
      }
    },
    myAnime: [createMyAnime({ defaultFansubGroupId: "fansub-default" })],
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });
  const notificationService = new FakeDesktopNotificationService();
  mockRssFeed(t, [
    {
      title: "[候补字幕组] 测试番 - 01 [1080p][HEVC][简体]",
      guid: "release-candidate",
      magnet: "magnet:?xt=urn:btih:CANDIDATE01&dn=candidate"
    }
  ]);

  const result = await new AutomationScheduler(
    repository.asAppRepository(),
    notificationService
  ).runNow({ ignoreCooldown: true });

  assert.equal(result.checkedEpisodes, 1);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(repository.notifications.length, 1);
  assert.equal(repository.notifications[0].kind, "automation");
  assert.equal(repository.notifications[0].severity, "info");
  assert.equal(repository.notifications[0].title, "自动扫描完成");
  assert.equal(repository.notifications[0].body, "已检查 1 集，没有新增下载任务。");
  assert.equal(notificationService.automationResults.length, 1);
  assert.equal(notificationService.schedulerErrors.length, 0);
});

test("AutomationScheduler 为自动下载失败写入错误通知", async (t) => {
  const repository = new FakeSchedulerRepository({
    settings: {
      ...defaultSettings,
      download: {
        ...defaultSettings.download,
        defaultTorrentEngine: "qbittorrent",
        qbittorrent: {
          ...defaultSettings.download.qbittorrent,
          baseUrl: "https://qb.test",
          username: "test"
        }
      }
    },
    myAnime: [createMyAnime({ defaultFansubGroupId: "fansub-default" })],
    episodes: [createEpisode()],
    fansubs: createFansubs(),
    sources: [createRssSource()]
  });
  const notificationService = new FakeDesktopNotificationService();
  mockRssFeedAndFailedQbit(t, [
    {
      title: "[默认字幕组] 测试番 - 01 [1080p][HEVC][简体]",
      guid: "release-default",
      magnet: "magnet:?xt=urn:btih:DEFAULT01&dn=default"
    }
  ]);

  const result = await new AutomationScheduler(
    repository.asAppRepository(),
    notificationService
  ).runNow({ ignoreCooldown: true });

  assert.equal(result.checkedEpisodes, 1);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /qBittorrent request failed: 500 Add Failed/);
  assert.equal(repository.notifications.length, 1);
  assert.equal(repository.notifications[0].severity, "error");
  assert.equal(repository.notifications[0].title, "扫描失败：测试番");
  assert.equal(repository.notifications[0].body, "第 1 集：qBittorrent request failed: 500 Add Failed");
  assert.equal(notificationService.automationResults.length, 1);
  assert.equal(notificationService.automationResults[0].errors.length, 1);
  assert.equal(notificationService.schedulerErrors.length, 0);
});

test("AutomationScheduler 在扫描整体失败时调用调度错误通知", async () => {
  const repository = new FakeSchedulerRepository({
    settings: defaultSettings,
    failListMyAnimeMessage: "追番列表读取失败"
  });
  const notificationService = new FakeDesktopNotificationService();
  const scheduler = new AutomationScheduler(repository.asAppRepository(), notificationService);

  await assert.rejects(() => scheduler.runNow({ ignoreCooldown: true }), /追番列表读取失败/);

  assert.equal(repository.notifications.length, 0);
  assert.deepEqual(notificationService.schedulerErrors, ["追番列表读取失败"]);
  assert.equal(scheduler.getStatus().lastError, "追番列表读取失败");
});

interface FakeSchedulerRepositoryData {
  settings: AppSettings;
  myAnime?: MyAnime[];
  episodes?: Episode[];
  preferences?: EpisodePreference[];
  downloads?: DownloadTask[];
  fansubs?: FansubGroup[];
  sources?: ReleaseSourceConfig[];
  notifications?: NotificationRecord[];
  failListMyAnimeMessage?: string;
}

class FakeSchedulerRepository {
  settings: AppSettings;
  myAnime: MyAnime[];
  episodes: Episode[];
  preferences: EpisodePreference[];
  downloads: DownloadTask[];
  fansubs: FansubGroup[];
  sources: ReleaseSourceConfig[];
  notifications: NotificationRecord[];
  failListMyAnimeMessage?: string;

  constructor(data: FakeSchedulerRepositoryData) {
    this.settings = data.settings;
    this.myAnime = data.myAnime ?? [];
    this.episodes = data.episodes ?? [];
    this.preferences = data.preferences ?? [];
    this.downloads = data.downloads ?? [];
    this.fansubs = data.fansubs ?? [];
    this.sources = data.sources ?? [];
    this.notifications = data.notifications ?? [];
    this.failListMyAnimeMessage = data.failListMyAnimeMessage;
  }

  asAppRepository(): AppRepository {
    return this as unknown as AppRepository;
  }

  async getSettings(): Promise<AppSettings> {
    return this.settings;
  }

  async listMyAnime(): Promise<MyAnime[]> {
    if (this.failListMyAnimeMessage) {
      throw new Error(this.failListMyAnimeMessage);
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

  async addNotifications(records: NotificationRecord[]): Promise<NotificationRecord[]> {
    this.notifications.unshift(...records);
    return this.notifications;
  }
}

class FakeDesktopNotificationService {
  automationResults: AutomationRunResult[] = [];
  schedulerErrors: string[] = [];

  notifyAutomationResult(result: AutomationRunResult): void {
    this.automationResults.push(result);
  }

  notifySchedulerError(message: string): void {
    this.schedulerErrors.push(message);
  }

  notifyReminder(): void {
    return;
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

function mockRssFeedAndFailedQbit(
  t: TestContext,
  items: Array<{
    title: string;
    guid: string;
    magnet: string;
  }>
): void {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url === "https://example.test/feed.xml") {
      return createRssResponse(items);
    }

    if (url === "https://qb.test/api/v2/auth/login") {
      return new Response("Ok.", {
        status: 200,
        statusText: "OK",
        headers: {
          "set-cookie": "SID=test"
        }
      });
    }

    if (url === "https://qb.test/api/v2/torrents/add") {
      return new Response("add failed", { status: 500, statusText: "Add Failed" });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  });
}

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
