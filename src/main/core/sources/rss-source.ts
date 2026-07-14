import type { ReleaseQuery, ReleaseSource } from "@shared/contracts";
import type { Release, ReleaseSourceConfig } from "@shared/domain";
import { normalizeReleaseSearchText } from "../../../shared/anime-release-search";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { parseXml, textValue, toArray } from "./xml";

interface RssDocument {
  rss?: {
    channel?: {
      item?: RssItem | RssItem[];
    };
  };
  feed?: {
    entry?: RssItem | RssItem[];
  };
}

interface RssItem {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  pubDate?: unknown;
  updated?: unknown;
  published?: unknown;
  enclosure?: {
    "@url"?: string;
    "@length"?: string;
  };
}

export class RssReleaseSource implements ReleaseSource {
  constructor(public readonly config: ReleaseSourceConfig) {}

  async searchReleases(query: ReleaseQuery): Promise<Release[]> {
    const releases = await this.readFeed();
    const keyword = query.keyword.trim().toLowerCase();
    const normalizedKeyword = normalizeReleaseSearchText(query.keyword);
    const filtered = keyword
      ? releases.filter((release) => {
          const title = release.title.toLowerCase();
          const normalizedTitle = normalizeReleaseSearchText(release.title);
          return title.includes(keyword) || (normalizedKeyword ? normalizedTitle.includes(normalizedKeyword) : false);
        })
      : releases;

    return filtered.slice(0, query.limit ?? 50);
  }

  async listLatestByFansub(): Promise<Release[]> {
    return this.readFeed();
  }

  async listLatestByAnime(): Promise<Release[]> {
    return this.readFeed();
  }

  private async readFeed(): Promise<Release[]> {
    if (!this.config.rssUrl) {
      return [];
    }

    const response = await fetch(this.config.rssUrl);
    if (!response.ok) {
      throw new Error(`RSS source failed: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();
    const parsed = parseXml<RssDocument>(xml);
    const items = [
      ...toArray(parsed.rss?.channel?.item),
      ...toArray(parsed.feed?.entry)
    ];

    return items.map((item, index) => enrichReleaseFromTitle(this.mapItem(item, index)));
  }

  private mapItem(item: RssItem, index: number): Release {
    const title = textValue(item.title) ?? `RSS Item ${index + 1}`;
    const link = textValue(item.link) ?? textValue(item.guid);
    const enclosureUrl = item.enclosure?.["@url"];
    const downloadUrl = link ?? enclosureUrl;

    return {
      id: `${this.config.id}:${textValue(item.guid) ?? downloadUrl ?? title}`,
      title,
      sourceId: this.config.id,
      sourceName: this.config.name,
      magnetUrl: isMagnet(downloadUrl) ? downloadUrl : undefined,
      torrentUrl: downloadUrl && !isMagnet(downloadUrl) ? downloadUrl : undefined,
      size: parseOptionalNumber(item.enclosure?.["@length"]),
      publishedAt: textValue(item.pubDate) ?? textValue(item.published) ?? textValue(item.updated) ?? new Date().toISOString()
    };
  }
}

function isMagnet(value?: string): boolean {
  return Boolean(value?.startsWith("magnet:"));
}

function parseOptionalNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
