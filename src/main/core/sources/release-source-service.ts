import type { AnimeReleaseQuery, ReleaseQuery, ReleaseSearchResult, ReleaseSource } from "@shared/contracts";
import type { Anime, AnimeSourceBinding, FansubGroup, Release, ReleaseSourceConfig } from "@shared/domain";
import { createHash } from "node:crypto";
import { buildAnimeReleaseSearchTerms, classifyAnimeRelease, matchesAnimeReleaseTitle, normalizeReleaseSearchText } from "../../../shared/anime-release-search";
import { releaseMatchesEpisode } from "../../../shared/release-search-input";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import { logger } from "../logger";
import type { AppRepository } from "../repositories/app-repository";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { AcgnxReleaseSource } from "./acgnx-source";
import { AniBtReleaseSource } from "./anibt-source";
import { DmhyReleaseSource } from "./dmhy-source";
import { MikanReleaseSource, type ReleaseHttpClient } from "./mikan-source";
import { RssReleaseSource } from "./rss-source";
import { TorznabReleaseSource } from "./torznab-source";
import { createSourceHttpClient } from "./source-http-client";

const MAX_RELEASE_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const releaseSearchCache = new Map<string, { expiresAt: number; result: ReleaseSearchResult }>();

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
      const cached = releaseSearchCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        logger.info("下载资源搜索命中缓存", {
          animeId: query.animeId,
          keyword: query.keyword,
          releaseCount: cached.result.releases.length
        });
        return cloneSearchResult(cached.result, query);
      }
      if (cached) {
        releaseSearchCache.delete(cacheKey);
      }
    }

    const sources = this.configs
      .filter((config) => config.enabled)
      .map((config) => createReleaseSource(config, this.httpClient, this.repository))
      .filter(Boolean) as ReleaseSource[];
    const errors: ReleaseSearchResult["errors"] = [];
    const releases = (
      await Promise.all(
        sources.map(async (source) => {
          try {
            return await source.searchReleases(query);
          } catch (error) {
            errors.push({
              sourceId: source.config.id,
              message: formatReleaseSourceError(error)
            });
            return [];
          }
        })
      )
    )
      .flat()
      .map((release) => enrichReleaseFromTitle(release, this.fansubs));

    const dedupedReleases = dedupeReleases(releases);
    await this.persistCachedReleases(dedupedReleases);
    const episodeReleases = dedupedReleases.filter((release) => releaseMatchesEpisode(release, query.episodeNo));
    const liveRelevantReleases = query.animeId
      ? episodeReleases.filter((release) => matchesAnimeReleaseTitle(release.title, [query.keyword]))
      : episodeReleases;
    const cachedReleases = await this.loadCachedReleases(sources.map((source) => source.config.id));
    const relevantReleases = sortReleasesByPublishedAt(dedupeReleases([
      ...liveRelevantReleases,
      ...cachedReleases.filter((release) => matchesCachedQuery(release, query))
    ]));
    if (liveRelevantReleases.length !== dedupedReleases.length) {
      logger.info("下载资源搜索结果已按条件过滤", {
        animeId: query.animeId,
        keyword: query.keyword,
        episodeNo: query.episodeNo,
        filteredCount: dedupedReleases.length - liveRelevantReleases.length
      });
    }

    const result = {
      query,
      releases: relevantReleases.slice(0, query.limit ?? 100),
      searchedSourceIds: sources.map((source) => source.config.id),
      errors
    };

    if (cacheKey) {
      releaseSearchCache.set(cacheKey, {
        expiresAt: Date.now() + normalizeCacheTtlMs(query.cacheTtlMs),
        result: cloneSearchResult(result)
      });
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
      const cached = releaseSearchCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        logger.info("番剧资源搜索命中缓存", { animeId: anime.id, releaseCount: cached.result.releases.length });
        return cloneSearchResult(cached.result);
      }
      if (cached) {
        releaseSearchCache.delete(cacheKey);
      }
    }

    const sources = this.configs.filter(
      (config) => config.enabled && !isMikanSiteConfig(config)
    );
    const terms = buildAnimeReleaseSearchTerms(anime, [], 8);
    const errors: ReleaseSearchResult["errors"] = [];
    const releases = (
      await Promise.all(
        sources.map(async (config) => {
          const binding = bindings.find((item) => item.sourceId === config.id && item.confirmed);
          try {
            const sourceHttpClient = createSourceHttpClient(config, this.httpClient, this.repository);
            if (isMikanRssConfig(config)) {
              if (!binding) {
                errors.push({ sourceId: config.id, message: "请先确认蜜柑计划番剧匹配" });
                return [];
              }
              return new MikanReleaseSource(config, sourceHttpClient).listReleasesByAnimeId(
                binding.sourceAnimeId,
                query.limit
              );
            }
            if (isAniBtConfig(config)) {
              if (!binding) {
                errors.push({ sourceId: config.id, message: "请先确认 AniBT 番剧匹配" });
                return [];
              }
              return new AniBtReleaseSource(config, sourceHttpClient).listReleasesByAnimeId(binding.sourceAnimeId, query.limit);
            }

            const source = createReleaseSource(config, this.httpClient, this.repository);
            if (!source) {
              return [];
            }
            if (config.kind === "rss") {
              return source.searchReleases({ ...query, keyword: "", animeId: anime.id });
            }
            const results = await Promise.all(
              terms.map((keyword) => source.searchReleases({ ...query, keyword, animeId: anime.id }))
            );
            return results.flat();
          } catch (error) {
            errors.push({ sourceId: config.id, message: formatReleaseSourceError(error) });
            return [];
          }
        })
      )
    )
      .flat()
      .map((release) => ({ ...enrichReleaseFromTitle(release, this.fansubs), animeId: anime.id }));
    const liveRelevantReleases = dedupeReleases(releases).filter((release) => {
      const hasConfirmedExactBinding = bindings.some(
        (binding) => binding.sourceId === release.sourceId && binding.confirmed
      );
      const titleMatched = hasConfirmedExactBinding || matchesAnimeReleaseTitle(release.title, terms);
      return titleMatched &&
        classifyAnimeRelease(release, anime) !== "mismatch" &&
        releaseMatchesEpisode(release, query.episodeNo);
    });
    await this.persistCachedReleases(liveRelevantReleases);
    const cachedReleases = await this.loadCachedReleases(sources.map((source) => source.id));
    const relevantReleases = sortReleasesByPublishedAt(dedupeReleases([
      ...liveRelevantReleases,
      ...cachedReleases.filter((release) => {
        const hasConfirmedExactBinding = bindings.some(
          (binding) => binding.sourceId === release.sourceId && binding.confirmed
        );
        return releaseMatchesEpisode(release, query.episodeNo) &&
          (hasConfirmedExactBinding || matchesAnimeReleaseTitle(release.title, terms)) &&
          classifyAnimeRelease(release, anime) !== "mismatch";
      })
    ]));

    logger.info("Anime release search finished", {
      animeId: anime.id,
      episodeNo: query.episodeNo,
      sourceCount: sources.length,
      bindingCount: bindings.filter((binding) => binding.confirmed).length,
      releaseCount: relevantReleases.length
    });
    const result = {
      query: { ...query, keyword: anime.title },
      releases: relevantReleases.slice(0, query.limit ?? 100),
      searchedSourceIds: sources.map((source) => source.id),
      errors
    };
    if (cacheKey) {
      releaseSearchCache.set(cacheKey, {
        expiresAt: Date.now() + normalizeCacheTtlMs(query.cacheTtlMs),
        result: cloneSearchResult(result)
      });
    }
    return result;
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
        limit: query.limit
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
        limit: query.limit
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
}

export function createReleaseSource(
  config: ReleaseSourceConfig,
  httpClient: ReleaseHttpClient = defaultMetadataHttpClient,
  repository?: AppRepository,
  applyNetworkPolicy = true
): ReleaseSource | null {
  const sourceHttpClient = applyNetworkPolicy ? createSourceHttpClient(config, httpClient, repository) : httpClient;
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

/** 规范化资源搜索缓存时间，避免超过 1 天。 */
function normalizeCacheTtlMs(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(1, Math.min(MAX_RELEASE_SEARCH_CACHE_TTL_MS, Math.round(value)));
}

/** 克隆资源搜索结果，防止缓存对象被外部修改。 */
function cloneSearchResult(result: ReleaseSearchResult, queryOverride?: ReleaseQuery): ReleaseSearchResult {
  return {
    query: { ...(queryOverride ?? result.query) },
    releases: result.releases.map((release) => ({
      ...release,
      sourceMeta: release.sourceMeta ? { ...release.sourceMeta } : undefined
    })),
    searchedSourceIds: [...result.searchedSourceIds],
    errors: result.errors.map((error) => ({ ...error }))
  };
}

/** 计算缓存键和敏感字段签名。 */
function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
