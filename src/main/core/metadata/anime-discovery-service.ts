import type {
  AnimeDiscoveryQuery,
  AnimeDiscoveryResult,
  AnimeDiscoverySeasonQuery,
  AnimeDiscoverySeasonResult
} from "@shared/contracts";
import type { Anime, Season } from "@shared/domain";
import { logger } from "../logger";
import type { AppRepository } from "../repositories/app-repository";
import { createAnimeMetadataProviders } from "./metadata-provider-factory";
import {
  mergeAnimeMetadataBatches,
  type MonthlyAnimeMetadataProvider,
  supportsSeasonalAnimeMetadataProvider,
  uniqueByNormalizedTitle
} from "./metadata-provider";

interface ProviderBatch {
  source: string;
  items: Anime[];
}

interface ProviderCollectionResult {
  batches: ProviderBatch[];
  source: string;
  errors: string[];
}

const seasonMonths: Record<Season, readonly [number, number, number]> = {
  winter: [1, 2, 3],
  spring: [4, 5, 6],
  summer: [7, 8, 9],
  fall: [10, 11, 12]
};

export class AnimeDiscoveryService {
  constructor(
    private readonly repository: AppRepository,
    private readonly providers?: MonthlyAnimeMetadataProvider[]
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
    const result = await this.collectFromProviders(query.year, query.month);
    if (result.items.length) {
      const upserted = query.forceRefresh
        ? await this.repository.replaceAnimeCatalogMonth(query.year, query.month, result.items)
        : await this.repository.upsertAnimeCatalog(result.items);

      if (query.forceRefresh) {
        logger.info("新番月度缓存已原子替换", {
          year: query.year,
          month: query.month,
          collectedCount: result.items.length
        });
      }

      return {
        query,
        items: upserted.items.filter(
          (anime) => anime.premiereYear === query.year && anime.premiereMonth === query.month
        ),
        addedCount: upserted.addedCount,
        existingCount: upserted.existingCount,
        source: result.source,
        errors: result.errors
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

  /** 一次采集季度来源数据，再按首播月份分别写入本地目录。 */
  async collectSeason(query: AnimeDiscoverySeasonQuery): Promise<AnimeDiscoverySeasonResult> {
    const months = seasonMonths[query.season];
    const existingByMonth = new Map<number, Anime[]>();
    const existingCatalogs = await Promise.all(
      months.map(async (month) => [month, await this.repository.listAnimeCatalogByMonth(query.year, month)] as const)
    );
    for (const [month, items] of existingCatalogs) {
      existingByMonth.set(month, items);
    }

    const result = await this.collectSeasonFromProviders(query.year, query.season, months);
    const persistedItems: Anime[] = [];
    let addedCount = 0;
    let existingCount = 0;

    for (const month of months) {
      const monthBatches = result.batches
        .map((batch) => ({
          source: batch.source,
          items: batch.items.filter(
            (anime) => anime.premiereYear === query.year && anime.premiereMonth === month
          )
        }))
        .filter((batch) => batch.items.length > 0);
      const collectedItems = monthBatches.length ? mergeAnimeMetadataBatches(monthBatches) : [];

      if (!collectedItems.length) {
        const existing = existingByMonth.get(month) ?? [];
        persistedItems.push(...existing);
        existingCount += existing.length;
        continue;
      }

      const persisted = query.forceRefresh
        ? await this.repository.replaceAnimeCatalogMonth(query.year, month, collectedItems)
        : await this.repository.upsertAnimeCatalog(collectedItems);
      persistedItems.push(...persisted.items.filter(
        (anime) => anime.premiereYear === query.year && anime.premiereMonth === month
      ));
      addedCount += persisted.addedCount;
      existingCount += persisted.existingCount;
    }

    logger.info("新番季度采集完成", {
      year: query.year,
      season: query.season,
      source: result.source,
      count: persistedItems.length,
      errorCount: result.errors.length,
      forceRefresh: Boolean(query.forceRefresh)
    });

    return {
      query,
      items: uniqueByNormalizedTitle(persistedItems),
      addedCount,
      existingCount,
      source: result.source,
      errors: result.batches.length
        ? result.errors
        : result.errors.length ? result.errors : ["新番季度采集没有返回结果"]
    };
  }

  private async collectFromProviders(
    year: number,
    month: number
  ): Promise<{ items: Anime[]; source: string; errors: string[] }> {
    const errors: string[] = [];
    const batches: Array<{ source: string; items: Anime[] }> = [];
    const providers = await this.getProviders();

    for (const provider of providers) {
      logger.info("开始采集新番元数据", { source: provider.id, year, month });

      try {
        const items = uniqueByNormalizedTitle(await provider.getAnimeByMonth(year, month));
        logger.info("新番元数据采集完成", { source: provider.id, year, month, count: items.length });

        if (items.length) {
          batches.push({ source: provider.id, items });
          continue;
        }

        errors.push(`${provider.id}: 未返回新番数据`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "新番采集失败";
        logger.warn("新番元数据来源采集失败", { source: provider.id, year, month, error: message });
        errors.push(`${provider.id}: ${message}`);
      }
    }

    if (batches.length) {
      const items = mergeAnimeMetadataBatches(batches);
      const source = batches.map((batch) => batch.source).join("+");
      logger.info("新番元数据合并完成", {
        source,
        year,
        month,
        inputCount: batches.reduce((total, batch) => total + batch.items.length, 0),
        mergedCount: items.length
      });

      return {
        items,
        source,
        errors
      };
    }

    return {
      items: [],
      source: providers.map((provider) => provider.id).join(","),
      errors
    };
  }

  /** 按来源能力选择季度采集或三次月度采集。 */
  private async collectSeasonFromProviders(
    year: number,
    season: Season,
    months: readonly number[]
  ): Promise<ProviderCollectionResult> {
    const providers = await this.getProviders();
    const batches: ProviderBatch[] = [];
    const errors: string[] = [];

    for (const provider of providers) {
      if (supportsSeasonalAnimeMetadataProvider(provider)) {
        logger.info("开始采集季度新番元数据", { source: provider.id, year, season });
        try {
          const items = uniqueByNormalizedTitle(await provider.getAnimeBySeason(year, season));
          logger.info("季度新番元数据采集完成", { source: provider.id, year, season, count: items.length });
          if (items.length) {
            batches.push({ source: provider.id, items });
          } else {
            errors.push(`${provider.id}: 未返回季度新番数据`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "季度新番采集失败";
          logger.warn("季度新番元数据来源采集失败", { source: provider.id, year, season, error: message });
          errors.push(`${provider.id}: ${message}`);
        }
        continue;
      }

      for (const month of months) {
        logger.info("开始采集月度新番元数据", { source: provider.id, year, month });
        try {
          const items = uniqueByNormalizedTitle(await provider.getAnimeByMonth(year, month));
          logger.info("月度新番元数据采集完成", { source: provider.id, year, month, count: items.length });
          if (items.length) {
            batches.push({ source: provider.id, items });
          } else {
            errors.push(`${provider.id}(${month}月): 未返回新番数据`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "月度新番采集失败";
          logger.warn("月度新番元数据来源采集失败", { source: provider.id, year, month, error: message });
          errors.push(`${provider.id}(${month}月): ${message}`);
        }
      }
    }

    return {
      batches,
      source: [...new Set(batches.map((batch) => batch.source))].join("+") ||
        providers.map((provider) => provider.id).join(","),
      errors
    };
  }

  private async getProviders(): Promise<MonthlyAnimeMetadataProvider[]> {
    if (this.providers) {
      return this.providers;
    }

    const settings = await this.repository.getSettings();
    return createAnimeMetadataProviders(settings, this.repository);
  }
}
