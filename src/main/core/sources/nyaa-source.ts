import type { ReleaseQuery, ReleaseSource } from "@shared/contracts";
import type { Release, ReleaseSourceConfig } from "@shared/domain";
import { logger } from "../logger";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import { fetchRssReleases, type RssHttpClient } from "./rss-source";

const DEFAULT_NYAA_BASE_URL = "https://nyaa.si/";
const NYAA_ANIME_CATEGORY = "1_0";

export class NyaaReleaseSource implements ReleaseSource {
  constructor(
    public readonly config: ReleaseSourceConfig,
    private readonly httpClient: RssHttpClient = defaultMetadataHttpClient
  ) {}

  /** 使用 Nyaa Anime RSS 按关键词查询资源。 */
  async searchReleases(query: ReleaseQuery): Promise<Release[]> {
    const keyword = query.keyword.trim();
    const rssUrl = buildNyaaRssUrl(this.config.baseUrl ?? DEFAULT_NYAA_BASE_URL, keyword);
    logger.info("Nyaa source search started", {
      sourceId: this.config.id,
      keyword,
      limit: query.limit ?? 50
    });

    const releases = await fetchRssReleases(this.config, this.httpClient, rssUrl, {
      requestSource: "nyaa-release",
      errorName: "Nyaa"
    });
    const result = releases.slice(0, query.limit ?? 50);
    logger.info("Nyaa source search finished", {
      sourceId: this.config.id,
      keyword,
      count: result.length
    });
    return result;
  }

  /** 按字幕组名称查询 Nyaa 最新资源。 */
  async listLatestByFansub(groupId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: groupId });
  }

  /** 按番剧标识查询 Nyaa 最新资源。 */
  async listLatestByAnime(animeId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: animeId });
  }
}

/** 生成限定 Anime 分类的 Nyaa RSS 查询地址。 */
export function buildNyaaRssUrl(baseUrl: string, keyword: string): string {
  const url = new URL("/", baseUrl);
  url.searchParams.set("page", "rss");
  if (keyword) {
    url.searchParams.set("q", keyword);
  }
  url.searchParams.set("c", NYAA_ANIME_CATEGORY);
  url.searchParams.set("f", "0");
  return url.toString();
}
