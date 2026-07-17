import type { AutomationRunResult, ReleaseSearchResult } from "@shared/contracts";
import type {
  AnimeRssSubscription,
  AnimeSourceBinding,
  AppSettings,
  AutomationSettings,
  Episode,
  FansubGroup,
  MyAnime,
  Release,
  SubtitlePreference
} from "@shared/domain";
import { buildAnimeReleaseSearchTerms, matchesAnimeReleaseTitle } from "@shared/anime-release-search";
import { createTorrentEngine } from "../downloads/torrent-engine-factory";
import { addReleaseTorrentToEngine } from "../downloads/torrent-resource-adder";
import { logger } from "../logger";
import { resolveAnimeDownloadPath } from "../downloads/download-path-resolver";
import type { AppRepository } from "../repositories/app-repository";
import { rankReleases, type ReleaseMatchResult } from "../releases/release-matcher";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { MetadataHttpClient } from "../metadata/metadata-http-client";
import { ReleaseSourceService } from "../sources/release-source-service";
import { RssReleaseSource } from "../sources/rss-source";
import { AnimeSourceBindingService } from "../source-bindings/anime-source-binding-service";

const DEFAULT_RSS_REFRESH_INTERVAL_MINUTES = 20;
const rssSubscriptionReleaseCache = new Map<string, { fetchedAtMs: number; releases: Release[] }>();

export interface AutomationRunServiceOptions {
  getQbittorrentBaseUrl?: (settings: AppSettings) => string;
}

export class AutomationRunService {
  constructor(
    private readonly repository: AppRepository,
    private readonly options: AutomationRunServiceOptions = {}
  ) {}

  async runOnce(): Promise<AutomationRunResult> {
    const startedAt = new Date().toISOString();
    const result: AutomationRunResult = {
      startedAt,
      finishedAt: startedAt,
      checkedEpisodes: 0,
      downloaded: [],
      skipped: [],
      errors: []
    };

    const settings = await this.repository.getSettings();
    const myAnimeItems = await this.repository.listMyAnime();

    if (!settings.automation.autoDownloadEnabledGlobally) {
      result.skipped.push({
        animeId: "",
        animeTitle: "全局自动下载",
        reason: "全局自动下载未开启"
      });
      result.finishedAt = new Date().toISOString();
      return result;
    }

    const [downloads, fansubs, sources] = await Promise.all([
      this.repository.listDownloads(),
      this.repository.listFansubs(),
      this.repository.listSources()
    ]);
    const httpClient = new MetadataHttpClient(settings.network.metadataProxy);
    const sourceService = new ReleaseSourceService(sources, fansubs, httpClient);
    const engine = createTorrentEngine(settings, {
      qbittorrentBaseUrl: this.options.getQbittorrentBaseUrl?.(settings),
      torrentHttpClient: httpClient
    });

    for (const anime of myAnimeItems) {
      if (!anime.autoDownload) {
        result.skipped.push({
          animeId: anime.anime.id,
          animeTitle: anime.anime.title,
          reason: "番剧未开启自动下载"
        });
        continue;
      }

      const [episodes, preferences] = await Promise.all([
        this.repository.listEpisodes(anime.anime.id),
        this.repository.listEpisodePreferences(anime.anime.id)
      ]);
      const actionableEpisodes = episodes.filter(isActionableEpisode);
      const bindingState = await new AnimeSourceBindingService(this.repository).getState(anime.anime.id, false);

      if (!actionableEpisodes.length) {
        result.skipped.push({
          animeId: anime.anime.id,
          animeTitle: anime.anime.title,
          reason: "没有需要自动处理的单集"
        });
        continue;
      }

      const animeRssSearch = await searchAnimeRssSubscriptions({
        repository: this.repository,
        anime,
        fansubs,
        settings,
        httpClient
      });
      if (animeRssSearch.releases.length) {
        await this.repository.observeAnimeFansubs(anime.anime.id, animeRssSearch.releases);
      }

      for (const episode of actionableEpisodes) {
        result.checkedEpisodes += 1;

        if (downloads.some((task) => task.animeId === anime.anime.id && task.episodeId === episode.id)) {
          result.skipped.push({
            animeId: anime.anime.id,
            animeTitle: anime.anime.title,
            episodeId: episode.id,
            episodeNo: episode.episodeNo,
            reason: "已有下载任务"
          });
          continue;
        }

        try {
          const preference = preferences.find((item) => item.episodeId === episode.id);
          const preferredFansubGroupId = preference?.fansubGroupId ?? anime.defaultFansubGroupId;
          const rssRanked = rankReleases(
            animeRssSearch.releases,
            {
              anime,
              episodeNo: episode.episodeNo,
              episodeFansubOverrideId: preference?.fansubGroupId
            },
            fansubs
          );
          const rssCandidates = applyFansubFallbackPolicy(
            rssRanked,
            preferredFansubGroupId,
            settings.automation.fallbackWhenDefaultFansubMissing
          );
          let ranked = rssRanked;
          let candidates = rssCandidates;

          if (!rssCandidates.length) {
            const searchResults = await searchEpisodeReleases(
              sourceService,
              anime,
              episode,
              bindingState.bindings,
              preference?.fansubGroupId
            );
            const releases = dedupeReleases(searchResults.flatMap((item) => item.releases));
            await this.repository.observeAnimeFansubs(anime.anime.id, releases);
            ranked = rankReleases(
              releases,
              {
                anime,
                episodeNo: episode.episodeNo,
                episodeFansubOverrideId: preference?.fansubGroupId
              },
              fansubs
            );
            candidates = applyFansubFallbackPolicy(
              ranked,
              preferredFansubGroupId,
              settings.automation.fallbackWhenDefaultFansubMissing
            );
          }

          const best = candidates[0]?.release;

          if (ranked.length && !candidates.length && preferredFansubGroupId) {
            logger.info("Automation run waiting for preferred fansub release", {
              animeId: anime.anime.id,
              episodeId: episode.id,
              episodeNo: episode.episodeNo,
              preferredFansubGroupId,
              fallbackPolicy: settings.automation.fallbackWhenDefaultFansubMissing
            });
          }

          if (!best) {
            result.skipped.push({
              animeId: anime.anime.id,
              animeTitle: anime.anime.title,
              episodeId: episode.id,
              episodeNo: episode.episodeNo,
              reason: "未找到匹配资源"
            });
            await this.repository.upsertEpisode({
              ...episode,
              status: "aired"
            });
            continue;
          }

          if (!best.magnetUrl && !best.torrentUrl) {
            result.skipped.push({
              animeId: anime.anime.id,
              animeTitle: anime.anime.title,
              episodeId: episode.id,
              episodeNo: episode.episodeNo,
              reason: "最佳资源没有下载地址"
            });
            continue;
          }

          const task = await addReleaseTorrentToEngine({
            engine,
            magnetUrl: best.magnetUrl,
            torrentUrl: best.torrentUrl,
            options: {
              savePath: resolveAnimeDownloadPath(settings, anime)
            },
            torrentHttpClient: httpClient,
            context: {
              source: "automation",
              animeId: anime.anime.id,
              episodeId: episode.id,
              episodeNo: episode.episodeNo,
              releaseId: best.id
            }
          });
          const savedTasks = await this.repository.upsertDownloadTask({
            ...task,
            releaseId: best.id,
            animeId: anime.anime.id,
            episodeId: episode.id,
            animeTitle: anime.anime.title,
            episodeNo: episode.episodeNo,
            fansubGroupId: best.fansubGroupId,
            fansubName: best.fansubName,
            name: best.title
          });
          await this.repository.upsertEpisode({
            ...episode,
            status: "downloading"
          });
          downloads.push(savedTasks[0]);
          result.downloaded.push({
            animeId: anime.anime.id,
            animeTitle: anime.anime.title,
            episodeId: episode.id,
            episodeNo: episode.episodeNo,
            releaseId: best.id,
            releaseTitle: best.title,
            downloadTaskId: task.id
          });
        } catch (error) {
          result.errors.push({
            animeId: anime.anime.id,
            animeTitle: anime.anime.title,
            episodeId: episode.id,
            episodeNo: episode.episodeNo,
            message: error instanceof Error ? error.message : "自动下载失败"
          });
        }
      }
    }

    result.finishedAt = new Date().toISOString();
    return result;
  }
}

interface AnimeRssSubscriptionSearchInput {
  repository: AppRepository;
  anime: MyAnime;
  fansubs: FansubGroup[];
  settings: AppSettings;
  httpClient: MetadataHttpClient;
}

interface AnimeRssSubscriptionSearchResult {
  releases: Release[];
  errors: ReleaseSearchResult["errors"];
}

/** 读取单部追番的 RSS 订阅资源，自动下载优先使用该结果。 */
async function searchAnimeRssSubscriptions(
  input: AnimeRssSubscriptionSearchInput
): Promise<AnimeRssSubscriptionSearchResult> {
  const subscriptions = getEnabledRssSubscriptions(input.anime);
  if (!subscriptions.length) {
    return { releases: [], errors: [] };
  }

  const releases: Release[] = [];
  const errors: ReleaseSearchResult["errors"] = [];
  const updatedSubscriptions = [...(input.anime.rssSubscriptions ?? [])];
  let hasSubscriptionUpdate = false;

  for (const subscription of subscriptions) {
    const cacheKey = buildRssSubscriptionCacheKey(subscription);
    const intervalMs = normalizeRssRefreshInterval(subscription.refreshIntervalMinutes) * 60 * 1000;
    const cached = rssSubscriptionReleaseCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAtMs < intervalMs) {
      releases.push(...cached.releases);
      continue;
    }

    try {
      const fetchedAt = new Date().toISOString();
      const rssReleases = await fetchRssSubscriptionReleases(input, subscription);
      rssSubscriptionReleaseCache.set(cacheKey, {
        fetchedAtMs: Date.now(),
        releases: rssReleases
      });
      releases.push(...rssReleases);
      const index = updatedSubscriptions.findIndex((item) => item.id === subscription.id);
      if (index >= 0) {
        updatedSubscriptions[index] = {
          ...updatedSubscriptions[index],
          refreshIntervalMinutes: normalizeRssRefreshInterval(subscription.refreshIntervalMinutes),
          lastFetchedAt: fetchedAt,
          updatedAt: fetchedAt
        };
        hasSubscriptionUpdate = true;
      }
      logger.info("自动下载 RSS 订阅读取完成", {
        animeId: input.anime.anime.id,
        subscriptionId: subscription.id,
        subscriptionName: subscription.name,
        releaseCount: rssReleases.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "RSS 订阅读取失败";
      errors.push({ sourceId: subscription.id, message });
      logger.warn("自动下载 RSS 订阅读取失败", {
        animeId: input.anime.anime.id,
        subscriptionId: subscription.id,
        subscriptionName: subscription.name,
        message
      });
    }
  }

  if (hasSubscriptionUpdate) {
    try {
      await input.repository.upsertMyAnime({
        ...input.anime,
        rssSubscriptions: updatedSubscriptions,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      logger.warn("自动下载 RSS 订阅更新时间保存失败", {
        animeId: input.anime.anime.id,
        message: error instanceof Error ? error.message : "保存失败"
      });
    }
  }

  return {
    releases: dedupeReleases(releases),
    errors
  };
}

/** 请求单条 RSS 订阅并过滤出当前追番相关资源。 */
async function fetchRssSubscriptionReleases(
  input: AnimeRssSubscriptionSearchInput,
  subscription: AnimeRssSubscription
): Promise<Release[]> {
  const rssUrl = validateRssUrl(subscription.url);
  const source = new RssReleaseSource(
    {
      id: `rss-subscription:${subscription.id}`,
      name: subscription.name,
      kind: "rss",
      enabled: true,
      rssUrl
    },
    input.httpClient
  );
  const rssReleases = await source.searchReleases({
    keyword: "",
    animeId: input.anime.anime.id,
    preferredResolution: input.anime.preferredResolution,
    limit: 200
  });
  const searchTerms = buildAnimeReleaseSearchTerms(input.anime.anime);
  const relevantReleases = isExactMikanSubscription(rssUrl, input.anime)
    ? rssReleases
    : rssReleases.filter((release) => matchesAnimeReleaseTitle(release.title, searchTerms));
  const preferredSubtitle = subscription.preferredSubtitle ?? input.anime.preferredSubtitle;

  return sortRssSubscriptionReleases(
    relevantReleases.map((release) => ({
      ...enrichReleaseFromTitle(release, input.fansubs),
      animeId: input.anime.anime.id
    })),
    preferredSubtitle
  );
}

async function searchEpisodeReleases(
  sourceService: ReleaseSourceService,
  anime: MyAnime,
  episode: Episode,
  bindings: AnimeSourceBinding[],
  fansubGroupId?: string
): Promise<ReleaseSearchResult[]> {
  return [await sourceService.searchAnime(anime.anime, {
    animeId: anime.anime.id,
    episodeNo: episode.episodeNo,
    fansubGroupId: fansubGroupId ?? anime.defaultFansubGroupId,
    preferredResolution: anime.preferredResolution,
    limit: 80
  }, bindings)];
}

/** 读取启用且地址非空的追番 RSS 订阅。 */
function getEnabledRssSubscriptions(anime: MyAnime): AnimeRssSubscription[] {
  return (anime.rssSubscriptions ?? []).filter((subscription) => subscription.enabled && subscription.url.trim());
}

/** 规范化 RSS 自动刷新间隔，默认 20 分钟。 */
function normalizeRssRefreshInterval(value?: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return DEFAULT_RSS_REFRESH_INTERVAL_MINUTES;
  }

  return Math.max(1, Math.round(value));
}

/** 为 RSS 订阅缓存生成稳定键，URL 变化时自动失效。 */
function buildRssSubscriptionCacheKey(subscription: AnimeRssSubscription): string {
  return `${subscription.id}:${subscription.url.trim()}`;
}

/** 校验用户保存的 RSS 地址，自动下载只允许 HTTP(S)。 */
function validateRssUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RSS 订阅仅支持 HTTP 或 HTTPS 地址");
  }
  return url.toString();
}

/** 判断 RSS 是否为当前番剧外部 ID 对应的 Mikan 精确订阅。 */
function isExactMikanSubscription(rssUrl: string, anime: MyAnime): boolean {
  const mikanId = anime.anime.externalIds.mikan?.trim();
  if (!mikanId) {
    return false;
  }
  const url = new URL(rssUrl);
  const hostname = url.hostname.toLowerCase();
  return (hostname === "mikanani.me" || hostname.endsWith(".mikanani.me")) &&
    url.searchParams.get("bangumiId") === mikanId;
}

/** 按订阅语言偏好和发布时间排列 RSS 资源。 */
function sortRssSubscriptionReleases(releases: Release[], preferredSubtitle?: SubtitlePreference): Release[] {
  return [...releases].sort((left, right) => {
    const leftRank = getSubtitleSortRank(left.subtitle, preferredSubtitle);
    const rightRank = getSubtitleSortRank(right.subtitle, preferredSubtitle);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "");
  });
}

/** 计算 RSS 资源在当前语言偏好下的排序等级。 */
function getSubtitleSortRank(subtitle?: SubtitlePreference, preferredSubtitle?: SubtitlePreference): number {
  if (!preferredSubtitle) {
    return 0;
  }
  if (subtitle === preferredSubtitle) {
    return 0;
  }
  if (subtitle === "multi") {
    return 1;
  }
  if (subtitle) {
    return 2;
  }
  return 3;
}

function isActionableEpisode(episode: Episode): boolean {
  if (["downloading", "downloaded", "watched"].includes(episode.status)) {
    return false;
  }

  if (episode.status === "aired" || episode.status === "matched") {
    return true;
  }

  return episode.airTime ? new Date(episode.airTime).getTime() <= Date.now() : false;
}

function dedupeReleases(releases: Release[]): Release[] {
  const seen = new Set<string>();

  return releases.filter((release) => {
    const key = release.infoHash ?? release.magnetUrl ?? release.torrentUrl ?? release.title;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function applyFansubFallbackPolicy(
  ranked: ReleaseMatchResult[],
  preferredFansubGroupId: string | undefined,
  policy: AutomationSettings["fallbackWhenDefaultFansubMissing"]
): ReleaseMatchResult[] {
  if (!preferredFansubGroupId) {
    return ranked;
  }

  const preferredMatches = ranked.filter((result) => result.release.fansubGroupId === preferredFansubGroupId);
  if (preferredMatches.length) {
    return preferredMatches;
  }

  if (policy === "candidate") {
    return ranked;
  }

  return [];
}
