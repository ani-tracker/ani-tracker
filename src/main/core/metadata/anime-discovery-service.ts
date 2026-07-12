import type { AnimeDiscoveryQuery, AnimeDiscoveryResult } from "@shared/contracts";
import type { AppRepository } from "../repositories/app-repository";
import { AniListMetadataProvider } from "./anilist-metadata-provider";

export class AnimeDiscoveryService {
  constructor(
    private readonly repository: AppRepository,
    private readonly provider = new AniListMetadataProvider()
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

    try {
      const fetched = await this.provider.getAnimeByMonth(query.year, query.month);
      const upserted = await this.repository.upsertAnimeCatalog(fetched);

      return {
        query,
        items: upserted.items.filter(
          (anime) => anime.premiereYear === query.year && anime.premiereMonth === query.month
        ),
        addedCount: upserted.addedCount,
        existingCount: upserted.existingCount,
        source: "anilist",
        errors: []
      };
    } catch (error) {
      return {
        query,
        items: existing,
        addedCount: 0,
        existingCount: existing.length,
        source: "anilist",
        errors: [error instanceof Error ? error.message : "新番采集失败"]
      };
    }
  }
}
