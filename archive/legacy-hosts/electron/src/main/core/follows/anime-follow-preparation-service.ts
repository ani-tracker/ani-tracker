import type {
  AnimeSourceBinding,
  FansubGroup,
  MyAnime,
  NotificationRecord,
  ReleaseSourceConfig
} from "@shared/domain";
import type { ReleaseSearchResult } from "@shared/contracts";
import { logger } from "../logger";
import { MetadataHttpClient } from "../metadata/metadata-http-client";
import type { AppRepository } from "../repositories/app-repository";
import { AnimeSourceBindingService } from "../source-bindings/anime-source-binding-service";
import {
  ReleaseSourceService,
  resolveAnimeReleaseCacheTtlMs
} from "../sources/release-source-service";
import type { ReleaseHttpClient } from "../sources/mikan-source";
import { EpisodeSyncService } from "../episodes/episode-sync-service";

type BindingService = Pick<AnimeSourceBindingService, "getState">;
type ResourceService = Pick<ReleaseSourceService, "searchAnime"> &
  Partial<Pick<ReleaseSourceService, "primeAnimeSearchCache">>;

export interface AnimeFollowPreparationOptions {
  createHttpClient?: () => ReleaseHttpClient;
  createBindingService?: (httpClient: ReleaseHttpClient) => BindingService;
  createResourceService?: (
    sources: ReleaseSourceConfig[],
    fansubs: FansubGroup[],
    httpClient: ReleaseHttpClient
  ) => ResourceService;
  now?: () => Date;
}

const runningPreparations = new Map<string, Promise<void>>();
export const FOLLOW_PREPARATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 在追番保存后异步准备来源绑定、资源缓存和字幕组数据。 */
export class AnimeFollowPreparationService {
  constructor(
    private readonly repository: AppRepository,
    private readonly options: AnimeFollowPreparationOptions = {}
  ) {}

  /** 启动去重后的后台任务；调用方无需等待即可返回保存结果。 */
  prepareInBackground(item: MyAnime): Promise<void> {
    const existing = runningPreparations.get(item.anime.id);
    if (existing) {
      logger.info("追番后台数据准备复用进行中任务", { animeId: item.anime.id });
      return existing;
    }

    const task = this.prepare(item)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("追番后台数据准备失败", { animeId: item.anime.id, message });
        await this.addFailureNotification(item, "准备流程", message).catch((notificationError) => {
          logger.warn("追番后台数据准备失败通知写入失败", {
            animeId: item.anime.id,
            message: notificationError instanceof Error ? notificationError.message : String(notificationError)
          });
        });
      })
      .finally(() => runningPreparations.delete(item.anime.id));
    runningPreparations.set(item.anime.id, task);
    return task;
  }

  /** 执行一次完整准备流程，供后台入口和测试复用。 */
  async prepare(item: MyAnime): Promise<void> {
    logger.info("追番后台数据准备开始", { animeId: item.anime.id, title: item.anime.title });
    const settings = await this.repository.getSettings();
    const httpClient = this.options.createHttpClient?.() ?? new MetadataHttpClient(settings.network.metadataProxy);
    const bindingService = this.options.createBindingService?.(httpClient) ??
      new AnimeSourceBindingService(this.repository, httpClient);
    const bindingState = await bindingService.getState(item.anime.id, false);
    const [sources, fansubs] = await Promise.all([
      this.repository.listSources(),
      this.repository.listFansubs(item.anime.id)
    ]);
    const resourceService = this.options.createResourceService?.(sources, fansubs, httpClient) ??
      new ReleaseSourceService(sources, fansubs, httpClient, this.repository);
    const cacheTtlMs = resolveAnimeReleaseCacheTtlMs(
      item.status,
      FOLLOW_PREPARATION_CACHE_TTL_MS
    );
    const query = {
      animeId: item.anime.id,
      preferredResolution: item.preferredResolution,
      limit: 200,
      cacheTtlMs
    };
    const result = await resourceService.searchAnime(item.anime, query, bindingState.bindings);
    const discoveredFansubs = await this.repository.observeAnimeFansubs(item.anime.id, result.releases);
    const episodeSync = await new EpisodeSyncService(this.repository).sync(item, result.releases);

    if (result.errors.length) {
      await this.addSourceFailureNotification(item, result.errors, sources);
      for (const error of result.errors) {
        logger.warn("追番后台资源预热来源失败", {
          animeId: item.anime.id,
          sourceId: error.sourceId,
          message: error.message
        });
      }
    } else {
      const cacheWriter = this.options.createResourceService?.(sources, discoveredFansubs, httpClient) ??
        new ReleaseSourceService(sources, discoveredFansubs, httpClient, this.repository);
      await cacheWriter.primeAnimeSearchCache?.(item.anime, query, bindingState.bindings, result);
    }

    logger.info("追番后台数据准备完成", {
      animeId: item.anime.id,
      bindingCount: bindingState.bindings.length,
      releaseCount: result.releases.length,
      fansubCount: discoveredFansubs.length,
      errorCount: result.errors.length,
      episodeCreatedCount: episodeSync.createdCount,
      episodeUpdatedCount: episodeSync.updatedCount,
      cacheTtlMs
    });
  }

  /** 汇总来源级错误，提醒中心保留具体来源和失败原因。 */
  private async addSourceFailureNotification(
    item: MyAnime,
    errors: ReleaseSearchResult["errors"],
    sources: ReleaseSourceConfig[]
  ): Promise<void> {
    const sourceNames = new Map(sources.map((source) => [source.id, source.name]));
    const body = errors
      .map((error) => `${sourceNames.get(error.sourceId) ?? error.sourceId}（${error.sourceId}）：${error.message}`)
      .join("\n");
    await this.addFailureNotification(item, `${errors.length} 个下载源`, body);
  }

  /** 写入一条追番准备失败通知。 */
  private async addFailureNotification(item: MyAnime, scope: string, message: string): Promise<void> {
    const now = this.options.now?.() ?? new Date();
    const record: NotificationRecord = {
      id: `follow-preparation-${item.anime.id}-${now.getTime()}`,
      kind: "system",
      title: `「${item.anime.title}」数据准备部分失败`,
      body: `${scope}：${message}`,
      severity: "warning",
      animeId: item.anime.id,
      createdAt: now.toISOString()
    };
    await this.repository.addNotifications([record]);
  }
}
