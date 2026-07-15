import type { MyAnime, ReleaseSourceConfig } from "@shared/domain";
import { buildAnimeReleaseSearchTerms, matchesAnimeReleaseTitle } from "@shared/anime-release-search";
import { logger } from "../logger";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import type { AppRepository } from "../repositories/app-repository";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { createReleaseSource, isAniBtConfig } from "../sources/release-source-service";
import type { ReleaseHttpClient } from "../sources/mikan-source";

type DiscoveryRepository = Pick<
  AppRepository,
  "listFansubs" | "listSources" | "observeAnimeFansubs"
>;

const runningDiscoveries = new Map<string, Promise<void>>();

/** 以单个下载源请求发现新追番实际发布的字幕组。 */
export class AnimeFansubDiscoveryService {
  constructor(
    private readonly repository: DiscoveryRepository,
    private readonly httpClient: ReleaseHttpClient = defaultMetadataHttpClient
  ) {}

  /** 启动去重后的后台发现任务，同一番剧不会并发重复请求。 */
  discoverInBackground(item: MyAnime): void {
    if (runningDiscoveries.has(item.anime.id)) {
      return;
    }

    const task = this.discover(item)
      .catch((error) => {
        logger.warn("追番字幕组后台发现失败", {
          animeId: item.anime.id,
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => runningDiscoveries.delete(item.anime.id));
    runningDiscoveries.set(item.anime.id, task);
  }

  /** 选择一个低请求成本来源，单次读取后保存识别到的字幕组。 */
  async discover(item: MyAnime): Promise<void> {
    const sourceConfig = await this.selectSource(item);
    if (!sourceConfig) {
      logger.info("追番字幕组后台发现跳过：没有可用的单请求下载源", { animeId: item.anime.id });
      return;
    }

    const source = createReleaseSource(sourceConfig, this.httpClient);
    if (!source) {
      return;
    }

    logger.info("追番字幕组后台发现开始", {
      animeId: item.anime.id,
      sourceId: sourceConfig.id
    });
    const knownGroups = await this.repository.listFansubs(item.anime.id);
    const releases = (await source.searchReleases({
      keyword: item.anime.title,
      animeId: item.anime.id,
      limit: 100
    }))
      .filter((release) => matchesAnimeReleaseTitle(release.title, buildAnimeReleaseSearchTerms(item.anime)))
      .map((release) => ({
        ...enrichReleaseFromTitle(release, knownGroups),
        animeId: item.anime.id
      }));
    const groups = await this.repository.observeAnimeFansubs(item.anime.id, releases);
    logger.info("追番字幕组后台发现完成", {
      animeId: item.anime.id,
      sourceId: sourceConfig.id,
      releaseCount: releases.length,
      groupCount: groups.length
    });
  }

  /** 优先使用番剧 RSS，其次选用一个不会内部扩散请求的已启用来源。 */
  private async selectSource(item: MyAnime): Promise<ReleaseSourceConfig | undefined> {
    const subscription = item.rssSubscriptions?.find((entry) => entry.enabled && entry.url.trim());
    if (subscription) {
      return {
        id: `rss-subscription:${subscription.id}`,
        name: subscription.name,
        kind: "rss",
        enabled: true,
        rssUrl: subscription.url
      };
    }

    const sources = (await this.repository.listSources())
      .filter((source) => source.enabled && !isAniBtConfig(source) && createReleaseSource(source, this.httpClient))
      .sort((left, right) => sourceRequestPriority(left) - sourceRequestPriority(right));
    return sources[0];
  }
}

/** 将一次读取即可过滤的 RSS 放在后台发现首位。 */
function sourceRequestPriority(source: ReleaseSourceConfig): number {
  if (source.kind === "rss") return 0;
  if (source.kind === "site_adapter") return 1;
  return 2;
}
