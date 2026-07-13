import type { ReleaseQuery, ReleaseSearchResult, ReleaseSource } from "@shared/contracts";
import type { FansubGroup, ReleaseSourceConfig } from "@shared/domain";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { AcgnxReleaseSource } from "./acgnx-source";
import { AniBtReleaseSource } from "./anibt-source";
import { DmhyReleaseSource } from "./dmhy-source";
import { MikanReleaseSource } from "./mikan-source";
import { RssReleaseSource } from "./rss-source";
import { TorznabReleaseSource } from "./torznab-source";

export class ReleaseSourceService {
  constructor(
    private readonly configs: ReleaseSourceConfig[],
    private readonly fansubs: FansubGroup[] = []
  ) {}

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
              message: formatReleaseSourceError(error)
            });
            return [];
          }
        })
      )
    )
      .flat()
      .map((release) => enrichReleaseFromTitle(release, this.fansubs));

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

  if (config.kind === "site_adapter" && isDmhyConfig(config)) {
    return new DmhyReleaseSource(config);
  }

  if (config.kind === "site_adapter" && isMikanConfig(config)) {
    return new MikanReleaseSource(config);
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
