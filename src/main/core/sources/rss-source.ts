import type { ReleaseQuery, ReleaseSource } from "@shared/contracts";
import type { Release, ReleaseSourceConfig } from "@shared/domain";
import { normalizeReleaseSearchText } from "../../../shared/anime-release-search";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { DESKTOP_BROWSER_ACCEPT_LANGUAGE, DESKTOP_BROWSER_USER_AGENT } from "../http/user-agents";
import { defaultMetadataHttpClient, type MetadataFetchOptions } from "../metadata/metadata-http-client";
import { parseXml, textValue, toArray } from "./xml";

export interface RssHttpClient {
  fetch(input: string | URL, options?: MetadataFetchOptions): Promise<Response>;
}

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
  torrent?: {
    link?: unknown;
    contentLength?: unknown;
    pubDate?: unknown;
  };
}

export class RssReleaseSource implements ReleaseSource {
  constructor(
    public readonly config: ReleaseSourceConfig,
    private readonly httpClient: RssHttpClient = defaultMetadataHttpClient
  ) {}

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

    const response = await this.httpClient.fetch(this.config.rssUrl, {
      source: "rss-release",
      headers: {
        Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": DESKTOP_BROWSER_ACCEPT_LANGUAGE,
        "User-Agent": DESKTOP_BROWSER_USER_AGENT
      }
    });
    if (response.status === 304) {
      return [];
    }
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
    const torrentLink = textValue(item.torrent?.link);
    const magnetUrl = [link, enclosureUrl, torrentLink].find(isMagnet);
    const torrentUrl = [enclosureUrl, torrentLink, link].find(isTorrentDownloadUrl);
    const sourceMeta = buildRssSourceMeta(this.config.rssUrl, link);

    return {
      id: `${this.config.id}:${textValue(item.guid) ?? magnetUrl ?? torrentUrl ?? link ?? title}`,
      title,
      sourceId: this.config.id,
      sourceName: this.config.name,
      magnetUrl,
      torrentUrl,
      size: parseOptionalNumber(item.enclosure?.["@length"]) ?? parseOptionalNumber(textValue(item.torrent?.contentLength)),
      publishedAt:
        textValue(item.pubDate) ??
        textValue(item.published) ??
        textValue(item.updated) ??
        textValue(item.torrent?.pubDate) ??
        new Date().toISOString(),
      sourceMeta
    };
  }
}

/** 根据 RSS 地址保留可复用的来源元信息。 */
function buildRssSourceMeta(rssUrl?: string, sourceUrl?: string): Release["sourceMeta"] {
  if (!rssUrl && !sourceUrl) {
    return undefined;
  }

  const mikanMeta = parseMikanRssMeta(rssUrl);
  return {
    sourceUrl,
    rssUrl,
    ...mikanMeta
  };
}

function parseMikanRssMeta(rssUrl?: string): Pick<NonNullable<Release["sourceMeta"]>, "mikanBangumiId" | "mikanSubgroupId"> {
  if (!rssUrl) {
    return {};
  }

  try {
    const url = new URL(rssUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "mikanani.me" && !hostname.endsWith(".mikanani.me")) {
      return {};
    }
    if (!url.pathname.toLowerCase().includes("/rss/bangumi")) {
      return {};
    }

    return {
      mikanBangumiId: url.searchParams.get("bangumiId") ?? undefined,
      mikanSubgroupId: url.searchParams.get("subgroupid") ?? undefined
    };
  } catch {
    return {};
  }
}

function isMagnet(value?: string): boolean {
  return Boolean(value?.startsWith("magnet:"));
}

function isTorrentDownloadUrl(value?: string): value is string {
  return Boolean(value && !isMagnet(value) && /(?:\.torrent\b|\/Download\/|\/download\/|\/topics\/download\/)/i.test(value));
}

function parseOptionalNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
