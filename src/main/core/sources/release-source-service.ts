import type { ReleaseQuery, ReleaseSearchResult, ReleaseSource } from "@shared/contracts";
import type { ReleaseSourceConfig } from "@shared/domain";
import { RssReleaseSource } from "./rss-source";
import { TorznabReleaseSource } from "./torznab-source";

export class ReleaseSourceService {
  constructor(private readonly configs: ReleaseSourceConfig[]) {}

  async search(query: ReleaseQuery): Promise<ReleaseSearchResult> {
    const sources = this.configs.filter((config) => config.enabled).map(createReleaseSource).filter(Boolean) as ReleaseSource[];
    const errors: ReleaseSearchResult["errors"] = [];
    const releases = (
      await Promise.all(
        sources.map(async (source) => {
          try {
            return await source.searchReleases(query);
          } catch (error) {
            errors.push({
              sourceId: source.config.id,
              message: error instanceof Error ? error.message : "下载源搜索失败"
            });
            return [];
          }
        })
      )
    ).flat();

    return {
      query,
      releases: dedupeReleases(releases).slice(0, query.limit ?? 100),
      searchedSourceIds: sources.map((source) => source.config.id),
      errors
    };
  }
}

export function createReleaseSource(config: ReleaseSourceConfig): ReleaseSource | null {
  if (config.kind === "rss") {
    return new RssReleaseSource(config);
  }

  if (config.kind === "torznab") {
    return new TorznabReleaseSource(config);
  }

  return null;
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
