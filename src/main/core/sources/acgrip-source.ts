import type { ReleaseQuery, ReleaseSource } from "@shared/contracts";
import type { Release, ReleaseSourceConfig } from "@shared/domain";
import { logger } from "../logger";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import { fetchRssReleases, type RssHttpClient } from "./rss-source";

const DEFAULT_ACGRIP_BASE_URL = "https://acg.rip/";

export class AcgRipReleaseSource implements ReleaseSource {
  constructor(
    public readonly config: ReleaseSourceConfig,
    private readonly httpClient: RssHttpClient = defaultMetadataHttpClient
  ) {}

  /** 使用 ACG.RIP RSS 按关键词查询资源。 */
  async searchReleases(query: ReleaseQuery): Promise<Release[]> {
    const keyword = query.keyword.trim();
    const rssUrl = buildAcgRipRssUrl(this.config.baseUrl ?? DEFAULT_ACGRIP_BASE_URL, keyword);
    logger.info("ACG.RIP source search started", {
      sourceId: this.config.id,
      keyword,
      limit: query.limit ?? 50
    });

    const releases = await fetchRssReleases(this.config, this.httpClient, rssUrl, {
      requestSource: "acgrip-release",
      errorName: "ACG.RIP"
    });
    const result = releases.slice(0, query.limit ?? 50);
    logger.info("ACG.RIP source search finished", {
      sourceId: this.config.id,
      keyword,
      count: result.length
    });
    return result;
  }

  /** 按字幕组名称查询 ACG.RIP 最新资源。 */
  async listLatestByFansub(groupId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: groupId });
  }

  /** 按番剧标识查询 ACG.RIP 最新资源。 */
  async listLatestByAnime(animeId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: animeId });
  }
}

/** 生成 ACG.RIP RSS 查询地址。 */
export function buildAcgRipRssUrl(baseUrl: string, keyword: string): string {
  const url = new URL("/.xml", baseUrl);
  if (keyword) {
    url.searchParams.set("term", keyword);
  }
  return url.toString();
}
