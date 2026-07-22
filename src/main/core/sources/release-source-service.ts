import type { AnimeReleaseQuery, ReleaseQuery, ReleaseSearchResult, ReleaseSource } from "@shared/contracts";
import type { Anime, AnimeSourceBinding, AnimeStatus, FansubGroup, Release, ReleaseSourceConfig } from "@shared/domain";
import { createHash } from "node:crypto";
import { buildAnimeReleaseSearchTerms, classifyAnimeRelease, matchesAnimeReleaseTitle, normalizeReleaseSearchText } from "../../../shared/anime-release-search";
import { releaseMatchesEpisode } from "../../../shared/release-search-input";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import { logger } from "../logger";
import type { AppRepository } from "../repositories/app-repository";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { AcgnxReleaseSource } from "./acgnx-source";
import { AcgRipReleaseSource } from "./acgrip-source";
import { isAnimeRssSubscriptionSource } from "./anime-rss-subscription-source";
import { AniBtReleaseSource } from "./anibt-source";
import { DmhyReleaseSource } from "./dmhy-source";
import { MikanReleaseSource, type ReleaseHttpClient } from "./mikan-source";
import { NyaaReleaseSource } from "./nyaa-source";
import { RssReleaseSource } from "./rss-source";
import { TorznabReleaseSource } from "./torznab-source";
import { createSourceHttpClient } from "./source-http-client";

export const COMPLETED_ANIME_RELEASE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RELEASE_SEARCH_CACHE_TTL_MS = COMPLETED_ANIME_RELEASE_CACHE_TTL_MS;
const releaseSearchCache = new Map<string, { expiresAt: number; result: ReleaseSearchResult }>();

interface SourceFetchResult {
  sourceId: string;
  sourceName: string;
  releases: Release[];
  error?: string;
}

export class ReleaseSourceService {
  constructor(
    private readonly configs: ReleaseSourceConfig[],
    private readonly fansubs: FansubGroup[] = [],
    private readonly httpClient: ReleaseHttpClient = defaultMetadataHttpClient,
    private readonly repository?: AppRepository
  ) {}

  async search(query: ReleaseQuery): Promise<ReleaseSearchResult> {
    const cacheKey = this.buildCacheKey(query);
    if (cacheKey && !query.forceRefresh) {
      const cached = await this.loadReleaseSearchCache(cacheKey);
      if (cached) {
        logger.info("下载资源搜索命中缓存", {
          animeId: query.animeId,
          keyword: query.keyword,
          releaseCount: cached.releases.length
        });
        return cloneSearchResult(cached, query);
      }
    }

    const sources = this.configs
      .filter((config) => config.enabled)
      .map((config) => createReleaseSource(config, this.httpClient, this.repository))
      .filter(Boolean) as ReleaseSource[];
    const sourceFetchResults: SourceFetchResult[] = await Promise.all(
      sources.map(async (source) => {
        try {
          return {
            sourceId: source.config.id,
            sourceName: source.config.name,
            releases: await source.searchReleases(query)
          };
        } catch (error) {
          return {
            sourceId: source.config.id,
            sourceName: source.config.name,
            releases: [],
            error: formatReleaseSourceError(error)
          };
        }
      })
    );
    const errors: ReleaseSearchResult["errors"] = sourceFetchResults.flatMap((sourceResult) =>
      sourceResult.error ? [{ sourceId: sourceResult.sourceId, message: sourceResult.error }] : []
    );
    const releases = sourceFetchResults.flatMap((sourceResult) =>
      sourceResult.releases.map((release) => enrichReleaseFromTitle(release, this.fansubs))
    );

    const dedupedReleases = dedupeReleases(releases);
    await this.persistCachedReleases(dedupedReleases);
    const matchesLiveQuery = (release: Release) =>
      releaseMatchesEpisode(release, query.episodeNo) &&
      (!query.animeId || matchesAnimeReleaseTitle(release.title, [query.keyword]));
    const liveRelevantReleases = dedupedReleases.filter(matchesLiveQuery);
    const cachedReleases = await this.loadCachedReleases(sources.map((source) => source.config.id));
    const relevantReleases = sortReleasesByPublishedAt(dedupeReleases([
      ...liveRelevantReleases,
      ...cachedReleases.filter((release) => matchesCachedQuery(release, query))
    ]));
    const sourceResults = createSourceSearchResults(
      sources.map((source) => source.config),
      releases,
      cachedReleases,
      matchesLiveQuery,
      (release) => matchesCachedQuery(release, query),
      query.limit ?? 100
    );
    if (liveRelevantReleases.length !== dedupedReleases.length) {
      logger.info("下载资源搜索结果已按条件过滤", {
        animeId: query.animeId,
        keyword: query.keyword,
        episodeNo: query.episodeNo,
        filteredCount: dedupedReleases.length - liveRelevantReleases.length
      });
    }

    const result: ReleaseSearchResult = {
      query,
      releases: relevantReleases.slice(0, query.limit ?? 100),
      sourceResults,
      searchedSourceIds: sources.map((source) => source.config.id),
      errors
    };

    if (cacheKey) {
      await this.saveReleaseSearchCache(cacheKey, query.cacheTtlMs, result);
      logger.info("下载资源搜索结果已缓存", {
        animeId: query.animeId,
        keyword: query.keyword,
        releaseCount: result.releases.length
      });
    }

    return result;
  }

  /** 按本地番剧及已确认来源绑定统一查询资源。 */
  async searchAnime(
    anime: Anime,
    query: AnimeReleaseQuery,
    bindings: AnimeSourceBinding[]
  ): Promise<ReleaseSearchResult> {
    const cacheKey = this.buildAnimeCacheKey(anime, query, bindings);
    if (cacheKey && !query.forceRefresh) {
      const cached = await this.loadReleaseSearchCache(cacheKey);
      if (cached) {
        logger.info("番剧资源搜索命中缓存", { animeId: anime.id, releaseCount: cached.releases.length });
        return cloneSearchResult(cached);
      }
    }

    const sources = this.configs.filter(
      (config) => config.enabled && !isMikanSiteConfig(config)
    );
    const terms = buildAnimeReleaseSearchTerms(anime, [], 8);
    const sourceFetchResults: SourceFetchResult[] = await Promise.all(
      sources.map(async (config) => {
        const binding = bindings.find((item) => item.sourceId === config.id && item.confirmed);
        try {
          const source = createReleaseSource(config, this.httpClient, this.repository);
          let releases: Release[] = [];
          if (source && isAnimeRssSubscriptionSource(source)) {
            const subscription = source.buildAnimeRssSubscription({
              anime,
              binding,
              limit: query.limit
            });
            if (!subscription) {
              return {
                sourceId: config.id,
                sourceName: config.name,
                releases,
                error: source.animeRssBindingError ?? "下载源无法生成当前番剧的 RSS 订阅"
              };
            }
            releases = await source.fetchAnimeRssSubscription(subscription);
          } else if (source) {
            const results = await Promise.all(
              terms.map((keyword) => source.searchReleases({ ...query, keyword, animeId: anime.id }))
            );
            releases = results.flat();
          }

          return { sourceId: config.id, sourceName: config.name, releases };
        } catch (error) {
          return {
            sourceId: config.id,
            sourceName: config.name,
            releases: [],
            error: formatReleaseSourceError(error)
          };
        }
      })
    );
    const errors: ReleaseSearchResult["errors"] = sourceFetchResults.flatMap((sourceResult) =>
      sourceResult.error ? [{ sourceId: sourceResult.sourceId, message: sourceResult.error }] : []
    );
    const releases = sourceFetchResults.flatMap((sourceResult) =>
      sourceResult.releases.map((release) => ({
        ...enrichReleaseFromTitle(release, this.fansubs),
        animeId: anime.id
      }))
    );
    const matchesAnimeQuery = (release: Release) => {
      const hasConfirmedExactBinding = bindings.some(
        (binding) => binding.sourceId === release.sourceId && binding.confirmed
      );
      const titleMatched = hasConfirmedExactBinding || matchesAnimeReleaseTitle(release.title, terms);
      return titleMatched &&
        classifyAnimeRelease(release, anime) !== "mismatch" &&
        releaseMatchesEpisode(release, query.episodeNo);
    };
    const liveRelevantReleases = dedupeReleases(releases).filter(matchesAnimeQuery);
    await this.persistCachedReleases(liveRelevantReleases);
    const cachedReleases = await this.loadCachedReleases(sources.map((source) => source.id));
    const relevantReleases = sortReleasesByPublishedAt(dedupeReleases([
      ...liveRelevantReleases,
      ...cachedReleases.filter(matchesAnimeQuery)
    ]));
    const sourceResults = createSourceSearchResults(
      sources,
      releases,
      cachedReleases,
      matchesAnimeQuery,
      matchesAnimeQuery,
      query.limit ?? 100
    );

    logger.info("Anime release search finished", {
      animeId: anime.id,
      episodeNo: query.episodeNo,
      sourceCount: sources.length,
      bindingCount: bindings.filter((binding) => binding.confirmed).length,
      releaseCount: relevantReleases.length
    });
    const result: ReleaseSearchResult = {
      query: { ...query, keyword: anime.title },
      releases: relevantReleases.slice(0, query.limit ?? 100),
      sourceResults,
      searchedSourceIds: sources.map((source) => source.id),
      errors
    };
    if (cacheKey) {
      await this.saveReleaseSearchCache(cacheKey, query.cacheTtlMs, result);
    }
    return result;
  }

  /** 按当前字幕组和来源签名保存已有番剧结果，不重复访问下载源。 */
  async primeAnimeSearchCache(
    anime: Anime,
    query: AnimeReleaseQuery,
    bindings: AnimeSourceBinding[],
    result: ReleaseSearchResult
  ): Promise<void> {
    const cacheKey = this.buildAnimeCacheKey(anime, query, bindings);
    if (!cacheKey) {
      return;
    }
    await this.saveReleaseSearchCache(cacheKey, query.cacheTtlMs, result);
    logger.info("番剧资源搜索缓存预热完成", {
      animeId: anime.id,
      releaseCount: result.releases.length,
      cacheTtlMs: normalizeCacheTtlMs(query.cacheTtlMs)
    });
  }

  /** 生成资源搜索缓存键，绑定查询条件、启用下载源和字幕组配置。 */
  private buildCacheKey(query: ReleaseQuery): string | null {
    if (!query.cacheTtlMs || query.cacheTtlMs <= 0) {
      return null;
    }

    const sourceSignature = this.configs
      .filter((config) => config.enabled)
      .map((config) => ({
        id: config.id,
        name: config.name,
        kind: config.kind,
        useProxy: config.useProxy,
        requestIntervalMs: config.requestIntervalMs,
        baseUrl: config.baseUrl,
        rssUrl: config.rssUrl,
        tags: config.tags,
        apiKeyHash: config.apiKey ? hashValue(config.apiKey) : undefined
      }));
    const fansubSignature = this.fansubs.map((group) => ({
      id: group.id,
      name: group.name,
      aliases: group.aliases,
      sourceIds: group.sourceIds
    }));
    const cacheInput = {
      query: {
        keyword: query.keyword,
        animeId: query.animeId,
        episodeNo: query.episodeNo,
        fansubGroupId: query.fansubGroupId,
        preferredResolution: query.preferredResolution,
        limit: query.limit,
        cacheTtlMs: normalizeCacheTtlMs(query.cacheTtlMs)
      },
      sourceSignature,
      fansubSignature
    };

    return hashValue(JSON.stringify(cacheInput));
  }

  /** 生成番剧级资源搜索缓存键，并包含已确认来源映射。 */
  private buildAnimeCacheKey(
    anime: Anime,
    query: AnimeReleaseQuery,
    bindings: AnimeSourceBinding[]
  ): string | null {
    if (!query.cacheTtlMs || query.cacheTtlMs <= 0) {
      return null;
    }

    return hashValue(JSON.stringify({
      kind: "anime",
      anime: {
        id: anime.id,
        title: anime.title,
        originalTitle: anime.originalTitle,
        aliases: anime.aliases.map((item) => item.alias)
      },
      query: {
        animeId: query.animeId,
        episodeNo: query.episodeNo,
        fansubGroupId: query.fansubGroupId,
        preferredResolution: query.preferredResolution,
        limit: query.limit,
        cacheTtlMs: normalizeCacheTtlMs(query.cacheTtlMs)
      },
      bindings: bindings
        .filter((binding) => binding.confirmed)
        .map((binding) => [binding.sourceId, binding.sourceAnimeId, binding.updatedAt]),
      sources: this.configs.map((source) => [
        source.id,
        source.enabled,
        source.useProxy,
        source.requestIntervalMs,
        source.baseUrl,
        source.rssUrl
      ]),
      fansubs: this.fansubs.map((fansub) => [fansub.id, fansub.name, fansub.aliases])
    }));
  }

  /** 读取持久化资源缓存；仓库不可用时保持原有纯网络搜索行为。 */
  private async loadCachedReleases(sourceIds: string[]): Promise<Release[]> {
    if (typeof this.repository?.listCachedReleases !== "function") {
      return [];
    }
    return this.repository.listCachedReleases(sourceIds, 2_000);
  }

  /** 将网络结果写入持久化缓存，同时兼容尚未扩展的仓库实现。 */
  private async persistCachedReleases(releases: Release[]): Promise<void> {
    if (typeof this.repository?.upsertCachedReleases === "function") {
      await this.repository.upsertCachedReleases(releases);
    }
  }

  /** 优先读取进程缓存，并在未命中时恢复 SQLite 查询缓存。 */
  private async loadReleaseSearchCache(cacheKey: string): Promise<ReleaseSearchResult | undefined> {
    const memoryEntry = releaseSearchCache.get(cacheKey);
    if (memoryEntry?.expiresAt && memoryEntry.expiresAt > Date.now()) {
      return cloneSearchResult(memoryEntry.result);
    }
    if (memoryEntry) {
      releaseSearchCache.delete(cacheKey);
    }

    if (typeof this.repository?.getReleaseSearchCache !== "function") {
      return undefined;
    }
    try {
      const persistedEntry = await this.repository.getReleaseSearchCache(cacheKey);
      const expiresAt = Date.parse(persistedEntry?.expiresAt ?? "");
      if (!persistedEntry || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return undefined;
      }
      const result = cloneSearchResult(persistedEntry.result);
      releaseSearchCache.set(cacheKey, { expiresAt, result });
      return cloneSearchResult(result);
    } catch (error) {
      logger.warn("资源查询缓存读取失败，将继续访问下载源", {
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  /** 同时保存进程与 SQLite 查询缓存，持久化失败不影响本次搜索结果。 */
  private async saveReleaseSearchCache(
    cacheKey: string,
    requestedTtlMs: number | undefined,
    result: ReleaseSearchResult
  ): Promise<void> {
    const ttlMs = normalizeCacheTtlMs(requestedTtlMs);
    const expiresAt = Date.now() + ttlMs;
    const cachedResult = cloneSearchResult(result);
    releaseSearchCache.set(cacheKey, { expiresAt, result: cachedResult });

    if (typeof this.repository?.upsertReleaseSearchCache !== "function") {
      return;
    }
    try {
      await this.repository.upsertReleaseSearchCache(cacheKey, {
        expiresAt: new Date(expiresAt).toISOString(),
        result: cloneSearchResult(cachedResult)
      });
    } catch (error) {
      logger.warn("资源查询缓存持久化失败", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export function createReleaseSource(
  config: ReleaseSourceConfig,
  httpClient: ReleaseHttpClient = defaultMetadataHttpClient,
  repository?: AppRepository,
  applyNetworkPolicy = true
): ReleaseSource | null {
  const sourceHttpClient = applyNetworkPolicy ? createSourceHttpClient(config, httpClient, repository) : httpClient;
  if (isMikanRssConfig(config)) {
    return new MikanReleaseSource(config, sourceHttpClient);
  }

  if (config.kind === "rss") {
    return new RssReleaseSource(config, sourceHttpClient);
  }

  if (config.kind === "torznab") {
    return new TorznabReleaseSource(config, sourceHttpClient);
  }

  if (config.kind === "site_adapter" && isDmhyConfig(config)) {
    return new DmhyReleaseSource(config, sourceHttpClient);
  }

  if (config.kind === "site_adapter" && isMikanConfig(config)) {
    return new MikanReleaseSource(config, sourceHttpClient);
  }

  if (config.kind === "site_adapter" && isAniBtConfig(config)) {
    return new AniBtReleaseSource(config, sourceHttpClient);
  }

  if (config.kind === "site_adapter" && isAcgnxConfig(config)) {
    return new AcgnxReleaseSource(config, sourceHttpClient);
  }

  if (config.kind === "site_adapter" && isNyaaConfig(config)) {
    return new NyaaReleaseSource(config, sourceHttpClient);
  }

  if (config.kind === "site_adapter" && isAcgRipConfig(config)) {
    return new AcgRipReleaseSource(config, sourceHttpClient);
  }

  return null;
}

function isDmhyConfig(config: ReleaseSourceConfig): boolean {
  const text = [config.id, config.name, config.baseUrl].filter(Boolean).join(" ").toLowerCase();
  return text.includes("dmhy") || text.includes("动漫花园") || text.includes("share.dmhy.org");
}

export function isMikanConfig(config: ReleaseSourceConfig): boolean {
  const text = [config.id, config.name, config.baseUrl].filter(Boolean).join(" ").toLowerCase();
  return text.includes("mikan") || text.includes("蜜柑") || text.includes("mikanani.me");
}

export function isMikanRssConfig(config: ReleaseSourceConfig): boolean {
  return config.kind === "rss" && isMikanConfig(config);
}

export function isMikanSiteConfig(config: ReleaseSourceConfig): boolean {
  return config.kind === "site_adapter" && isMikanConfig(config);
}

export function isAniBtConfig(config: ReleaseSourceConfig): boolean {
  const text = [config.id, config.name, config.baseUrl].filter(Boolean).join(" ").toLowerCase();
  return text.includes("anibt") || text.includes("anibt.net");
}

function isAcgnxConfig(config: ReleaseSourceConfig): boolean {
  const text = [config.id, config.name, config.baseUrl].filter(Boolean).join(" ").toLowerCase();
  return text.includes("acgnx") || text.includes("share.acgnx");
}

/** 判断配置是否指向 Nyaa 主站或兼容镜像。 */
function isNyaaConfig(config: ReleaseSourceConfig): boolean {
  const text = [config.id, config.name, config.baseUrl].filter(Boolean).join(" ").toLowerCase();
  return text.includes("nyaa") || text.includes("nyaa.si");
}

/** 判断配置是否指向 ACG.RIP 主站或兼容镜像。 */
function isAcgRipConfig(config: ReleaseSourceConfig): boolean {
  const text = [config.id, config.name, config.baseUrl].filter(Boolean).join(" ").toLowerCase();
  return text.includes("acg-rip") || text.includes("acgrip") || text.includes("acg.rip");
}

function dedupeReleases<T extends { infoHash?: string; magnetUrl?: string; torrentUrl?: string; title: string }>(releases: T[]): T[] {
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

function matchesCachedQuery(release: Release, query: ReleaseQuery): boolean {
  if (!releaseMatchesEpisode(release, query.episodeNo)) {
    return false;
  }
  const keyword = normalizeReleaseSearchText(query.keyword);
  if (!keyword) {
    return true;
  }
  return normalizeReleaseSearchText(release.title).includes(keyword);
}

function sortReleasesByPublishedAt<T extends { publishedAt: string }>(releases: T[]): T[] {
  return [...releases].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
}

/** 按下载源保留各自结果，同时复用聚合结果的筛选与缓存规则。 */
function createSourceSearchResults(
  sources: Array<Pick<ReleaseSourceConfig, "id" | "name">>,
  liveReleases: Release[],
  cachedReleases: Release[],
  matchesLiveRelease: (release: Release) => boolean,
  matchesCachedRelease: (release: Release) => boolean,
  limit: number
): ReleaseSearchResult["sourceResults"] {
  return sources.map((source) => ({
    sourceId: source.id,
    sourceName: source.name,
    releases: sortReleasesByPublishedAt(dedupeReleases([
      ...liveReleases.filter((release) => release.sourceId === source.id && matchesLiveRelease(release)),
      ...cachedReleases.filter((release) => release.sourceId === source.id && matchesCachedRelease(release))
    ])).slice(0, limit)
  }));
}

function formatReleaseSourceError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "下载源搜索失败";
  }

  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  const message = cause ? `${error.message}: ${cause}` : error.message;
  if (/fetch failed/i.test(message)) {
    return "下载源网络请求失败，请检查网络、代理或下载源地址";
  }

  if (/aborted|timeout/i.test(message)) {
    return "下载源请求超时，请稍后重试";
  }

  return message;
}

/** 完结作品固定复用七天缓存，其他状态沿用调用方刷新周期。 */
export function resolveAnimeReleaseCacheTtlMs(
  status: AnimeStatus,
  requestedTtlMs?: number
): number | undefined {
  return status === "completed" ? COMPLETED_ANIME_RELEASE_CACHE_TTL_MS : requestedTtlMs;
}

/** 规范化资源搜索缓存时间，避免超过完结作品的七天上限。 */
function normalizeCacheTtlMs(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(1, Math.min(MAX_RELEASE_SEARCH_CACHE_TTL_MS, Math.round(value)));
}

/** 克隆资源搜索结果，防止缓存对象被外部修改。 */
function cloneSearchResult(result: ReleaseSearchResult, queryOverride?: ReleaseQuery): ReleaseSearchResult {
  const sourceResults = Array.isArray(result.sourceResults)
    ? result.sourceResults
    : result.searchedSourceIds.map((sourceId) => ({
        sourceId,
        sourceName: result.releases.find((release) => release.sourceId === sourceId)?.sourceName ?? sourceId,
        releases: result.releases.filter((release) => release.sourceId === sourceId)
      }));

  return {
    query: { ...(queryOverride ?? result.query) },
    releases: result.releases.map(cloneRelease),
    sourceResults: sourceResults.map((sourceResult) => ({
      ...sourceResult,
      releases: sourceResult.releases.map(cloneRelease)
    })),
    searchedSourceIds: [...result.searchedSourceIds],
    errors: result.errors.map((error) => ({ ...error }))
  };
}

/** 深拷贝资源中的可变来源元数据。 */
function cloneRelease(release: Release): Release {
  return {
    ...release,
    sourceMeta: release.sourceMeta ? { ...release.sourceMeta } : undefined
  };
}

/** 计算缓存键和敏感字段签名。 */
function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
