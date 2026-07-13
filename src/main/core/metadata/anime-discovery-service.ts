import type { AnimeDiscoveryQuery, AnimeDiscoveryResult } from "@shared/contracts";
import type { Anime } from "@shared/domain";
import { logger } from "../logger";
import type { AppRepository } from "../repositories/app-repository";
import { AniListMetadataProvider } from "./anilist-metadata-provider";
import { BangumiMetadataProvider } from "./bangumi-metadata-provider";
import { MikanMetadataProvider } from "./mikan-metadata-provider";
import { type MonthlyAnimeMetadataProvider, uniqueByNormalizedTitle } from "./metadata-provider";

export class AnimeDiscoveryService {
  constructor(
    private readonly repository: AppRepository,
    private readonly providers: MonthlyAnimeMetadataProvider[] = [
      new BangumiMetadataProvider(),
      new AniListMetadataProvider(),
      new MikanMetadataProvider()
    ]
  ) {}

  async listCatalog(year?: number, month?: number) {
    if (year && month) {
      return this.repository.listAnimeCatalogByMonth(year, month);
    }

    return this.repository.listAnimeCatalog();
  }

  async searchCatalog(keyword: string) {
    return this.repository.searchAnimeCatalog(keyword);
  }

  async collectMonth(query: AnimeDiscoveryQuery): Promise<AnimeDiscoveryResult> {
    const existing = await this.repository.listAnimeCatalogByMonth(query.year, query.month);
    if (existing.length && !query.forceRefresh) {
      return {
        query,
        items: existing,
        addedCount: 0,
        existingCount: existing.length,
        source: "local-cache",
        errors: []
      };
    }

    const result = await this.collectFromProviders(query.year, query.month);
    if (result.items.length) {
      const upserted = await this.repository.upsertAnimeCatalog(result.items);

      return {
        query,
        items: upserted.items.filter(
          (anime) => anime.premiereYear === query.year && anime.premiereMonth === query.month
        ),
        addedCount: upserted.addedCount,
        existingCount: upserted.existingCount,
        source: result.source,
        errors: []
      };
    }

    return {
      query,
      items: existing,
      addedCount: 0,
      existingCount: existing.length,
      source: result.source,
      errors: result.errors.length ? result.errors : ["新番采集没有返回结果"]
    };
  }

  private async collectFromProviders(
    year: number,
    month: number
  ): Promise<{ items: Anime[]; source: string; errors: string[] }> {
    const errors: string[] = [];

    for (const provider of this.providers) {
      logger.info("开始采集新番元数据", { source: provider.id, year, month });

      try {
        const items = uniqueByNormalizedTitle(await provider.getAnimeByMonth(year, month));
        logger.info("新番元数据采集完成", { source: provider.id, year, month, count: items.length });

        if (items.length) {
          return {
            items,
            source: provider.id,
            errors
          };
        }

        errors.push(`${provider.id}: 未返回新番数据`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "新番采集失败";
        logger.warn("新番元数据来源采集失败", { source: provider.id, year, month, error: message });
        errors.push(`${provider.id}: ${message}`);
      }
    }

    return {
      items: [],
      source: this.providers.map((provider) => provider.id).join(","),
      errors
    };
  }
}
