import type { ReleaseQuery, ReleaseSearchResult, ReleaseSource } from "@shared/contracts";
import type { FansubGroup, ReleaseSourceConfig } from "@shared/domain";
import { createHash } from "node:crypto";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import { logger } from "../logger";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { AcgnxReleaseSource } from "./acgnx-source";
import { AniBtReleaseSource } from "./anibt-source";
import { DmhyReleaseSource } from "./dmhy-source";
import { MikanReleaseSource, type ReleaseHttpClient } from "./mikan-source";
import { RssReleaseSource } from "./rss-source";
import { TorznabReleaseSource } from "./torznab-source";

const MAX_RELEASE_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const releaseSearchCache = new Map<string, { expiresAt: number; result: ReleaseSearchResult }>();

export class ReleaseSourceService {
  constructor(
    private readonly configs: ReleaseSourceConfig[],
    private readonly fansubs: FansubGroup[] = [],
    private readonly httpClient: ReleaseHttpClient = defaultMetadataHttpClient
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
      .map((config) => createReleaseSource(config, this.httpClient))
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

    const result = {
      query,
      releases: dedupeReleases(releases).slice(0, query.limit ?? 100),
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
}

export function createReleaseSource(
  config: ReleaseSourceConfig,
  httpClient: ReleaseHttpClient = defaultMetadataHttpClient
): ReleaseSource | null {
  if (config.kind === "rss") {
    return new RssReleaseSource(config);
  }

  if (config.kind === "torznab") {
    return new TorznabReleaseSource(config);
  }

  if (config.kind === "site_adapter" && isDmhyConfig(config)) {
    return new DmhyReleaseSource(config);
  }

  if (config.kind === "site_adapter" && isMikanConfig(config)) {
    return new MikanReleaseSource(config, httpClient);
  }

  if (config.kind === "site_adapter" && isAniBtConfig(config)) {
    return new AniBtReleaseSource(config);
  }

  if (config.kind === "site_adapter" && isAcgnxConfig(config)) {
    return new AcgnxReleaseSource(config);
  }

  return null;
}

function isDmhyConfig(config: ReleaseSourceConfig): boolean {
  const text = [config.id, config.name, config.baseUrl].filter(Boolean).join(" ").toLowerCase();
  return text.includes("dmhy") || text.includes("动漫花园") || text.includes("share.dmhy.org");
}

function isMikanConfig(config: ReleaseSourceConfig): boolean {
  const text = [config.id, config.name, config.baseUrl].filter(Boolean).join(" ").toLowerCase();
  return text.includes("mikan") || text.includes("蜜柑") || text.includes("mikanani.me");
}

function isAniBtConfig(config: ReleaseSourceConfig): boolean {
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
    releases: result.releases.map((release) => ({ ...release })),
    searchedSourceIds: [...result.searchedSourceIds],
    errors: result.errors.map((error) => ({ ...error }))
  };
}

/** 计算缓存键和敏感字段签名。 */
function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
