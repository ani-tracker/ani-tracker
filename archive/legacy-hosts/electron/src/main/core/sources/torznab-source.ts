import type { ReleaseQuery, ReleaseSource } from "@shared/contracts";
import type { Release, ReleaseSourceConfig } from "@shared/domain";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { DESKTOP_BROWSER_USER_AGENT } from "../http/user-agents";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import type { ReleaseHttpClient } from "./mikan-source";
import { collectReleasePages } from "./source-pagination";
import { parseXml, textValue, toArray } from "./xml";

interface TorznabDocument {
  rss?: {
    channel?: {
      item?: TorznabItem | TorznabItem[];
      "newznab:response"?: {
        "@offset"?: string;
        "@total"?: string;
      };
    };
  };
}

interface TorznabItem {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  pubDate?: unknown;
  enclosure?: {
    "@url"?: string;
    "@length"?: string;
  };
  "torznab:attr"?: TorznabAttr | TorznabAttr[];
}

interface TorznabAttr {
  "@name"?: string;
  "@value"?: string;
}

export class TorznabReleaseSource implements ReleaseSource {
  constructor(
    public readonly config: ReleaseSourceConfig,
    private readonly httpClient: ReleaseHttpClient = defaultMetadataHttpClient
  ) {}

  async searchReleases(query: ReleaseQuery): Promise<Release[]> {
    if (!this.config.baseUrl) {
      return [];
    }

    return collectReleasePages(query.limit, async ({ offset, limit }) => {
      const url = new URL("/api", this.config.baseUrl);
      url.searchParams.set("t", "search");
      url.searchParams.set("q", query.keyword);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      if (this.config.apiKey) {
        url.searchParams.set("apikey", this.config.apiKey);
      }

      const response = await this.httpClient.fetch(url, {
        source: "torznab-release",
        headers: {
          "User-Agent": DESKTOP_BROWSER_USER_AGENT
        }
      });
      if (!response.ok) {
        throw new Error(`Torznab source failed: ${response.status} ${response.statusText}`);
      }

      const parsed = parseXml<TorznabDocument>(await response.text());
      const items = toArray(parsed.rss?.channel?.item)
        .map((item, index) => enrichReleaseFromTitle(this.mapItem(item, offset + index)));
      const pageMeta = parsed.rss?.channel?.["newznab:response"];
      const total = parseOptionalNumber(pageMeta?.["@total"]);
      const reportedOffset = parseOptionalNumber(pageMeta?.["@offset"]) ?? offset;
      return {
        items,
        hasNextPage: total === undefined ? undefined : reportedOffset + items.length < total
      };
    });
  }

  async listLatestByFansub(groupId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: groupId });
  }

  async listLatestByAnime(animeId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: animeId });
  }

  private mapItem(item: TorznabItem, index: number): Release {
    const title = textValue(item.title) ?? `Torznab Item ${index + 1}`;
    const attrs = toArray(item["torznab:attr"]);
    const seeders = getAttrNumber(attrs, "seeders");
    const size = parseOptionalNumber(item.enclosure?.["@length"]) ?? getAttrNumber(attrs, "size");
    const link = textValue(item.link) ?? item.enclosure?.["@url"];

    return {
      id: `${this.config.id}:${textValue(item.guid) ?? link ?? title}`,
      title,
      sourceId: this.config.id,
      sourceName: this.config.name,
      magnetUrl: link?.startsWith("magnet:") ? link : undefined,
      torrentUrl: link && !link.startsWith("magnet:") ? link : undefined,
      size,
      seeders,
      publishedAt: textValue(item.pubDate) ?? new Date().toISOString()
    };
  }
}

function getAttrNumber(attrs: TorznabAttr[], name: string): number | undefined {
  const value = attrs.find((attr) => attr["@name"] === name)?.["@value"];
  return parseOptionalNumber(value);
}

function parseOptionalNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
