import type { AnimeDetailResult } from "@shared/contracts";
import type { Anime } from "@shared/domain";
import { mergeAnimeMetadataBatches, type AnimeDetailMetadataProvider } from "./metadata-provider";
import { createAnimeMetadataProviders } from "./metadata-provider-factory";
import type { AppRepository } from "../repositories/app-repository";
import { logger } from "../logger";

const DETAIL_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

type DetailProvider = AnimeDetailMetadataProvider;

/** 聚合本地详情、追番状态、单集和字幕组，并按需刷新外部元数据。 */
export class AnimeDetailService {
  constructor(
    private readonly repository: AppRepository,
    private readonly providers?: DetailProvider[]
  ) {}

  /** 只读取本地缓存，供详情页首屏快速展示。 */
  async getAnimeDetail(animeId: string): Promise<AnimeDetailResult> {
    const startedAt = Date.now();
    const result = await this.readLocalDetail(animeId);
    logger.info("[anime-detail] load completed", {
      animeId,
      followed: Boolean(result.myAnime),
      stale: result.stale,
      elapsedMs: Date.now() - startedAt
    });
    return result;
  }

  /** 按已有 external id 增量刷新详情，单一来源失败不覆盖已存字段。 */
  async refreshAnimeDetail(animeId: string): Promise<AnimeDetailResult> {
    const startedAt = Date.now();
    const local = await this.repository.getAnimeCatalogById(animeId);
    if (!local) {
      throw new Error("番剧不存在");
    }

    logger.info("[anime-detail] refresh started", { animeId });
    const partialErrors: AnimeDetailResult["partialErrors"] = [];
    const batches: Array<{ source: string; items: Anime[] }> = [{ source: "local", items: [local] }];
    const providers = await this.getProviders();
    let successCount = 0;

    for (const provider of providers) {
      const externalId = local.externalIds[provider.id];
      if (!externalId) {
        continue;
      }

      try {
        const item = await provider.getAnimeDetail(externalId, local);
        batches.push({ source: provider.id, items: [item] });
        successCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        partialErrors.push({ source: provider.id, message });
        logger.warn("[anime-detail] provider refresh failed", { animeId, source: provider.id, error: message });
      }
    }

    if (!providers.some((provider) => local.externalIds[provider.id])) {
      partialErrors.push({ source: "metadata", message: "没有可用的 external id" });
    }

    let merged = local;
    if (successCount > 0) {
      const candidate = mergeAnimeMetadataBatches(batches).find((item) => item.id === local.id)
        ?? mergeAnimeMetadataBatches(batches)[0];
      if (candidate) {
        merged = {
          ...candidate,
          id: local.id,
          detail: {
            ...candidate.detail,
            metadataSources: [...new Set([
              ...(local.detail?.metadataSources ?? []),
              ...candidate.detail?.metadataSources ?? []
            ])],
            refreshedAt: new Date().toISOString()
          }
        };
        await this.repository.upsertAnimeCatalog([merged]);
      }
    }

    const result = await this.readLocalDetail(animeId);
    const finalResult = { ...result, partialErrors };
    logger.info("[anime-detail] refresh completed", {
      animeId,
      successCount,
      partialErrorCount: partialErrors.length,
      elapsedMs: Date.now() - startedAt
    });
    return finalResult;
  }

  /** 读取详情聚合所需的所有本地关联数据。 */
  private async readLocalDetail(animeId: string): Promise<AnimeDetailResult> {
    logger.info("[anime-detail] load started", { animeId });
    const [anime, myAnimeItems, episodes, fansubGroups] = await Promise.all([
      this.repository.getAnimeCatalogById(animeId),
      this.repository.listMyAnime(),
      this.repository.listEpisodes(animeId),
      this.repository.listFansubs(animeId)
    ]);
    if (!anime) {
      throw new Error("番剧不存在");
    }

    const refreshedAt = anime.detail?.refreshedAt ? Date.parse(anime.detail.refreshedAt) : Number.NaN;
    const stale = !Number.isFinite(refreshedAt) || Date.now() - refreshedAt > DETAIL_STALE_AFTER_MS;
    return {
      anime,
      myAnime: myAnimeItems.find((item) => item.anime.id === animeId),
      episodes,
      fansubGroups,
      stale,
      partialErrors: []
    };
  }

  /** 构造带代理和超时配置的详情来源。 */
  private async getProviders(): Promise<DetailProvider[]> {
    if (this.providers) {
      return this.providers;
    }
    const settings = await this.repository.getSettings();
    return createAnimeMetadataProviders(settings, this.repository);
  }
}
