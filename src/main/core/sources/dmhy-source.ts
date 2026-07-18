import type { ReleaseQuery, ReleaseSource } from "@shared/contracts";
import type { Release, ReleaseSourceConfig } from "@shared/domain";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { DESKTOP_BROWSER_USER_AGENT } from "../http/user-agents";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import type { ReleaseHttpClient } from "./mikan-source";

const DEFAULT_DMHY_BASE_URL = "https://share.dmhy.org/";

export class DmhyReleaseSource implements ReleaseSource {
  constructor(
    public readonly config: ReleaseSourceConfig,
    private readonly httpClient: ReleaseHttpClient = defaultMetadataHttpClient
  ) {}

  async searchReleases(query: ReleaseQuery): Promise<Release[]> {
    const url = new URL("/topics/list", this.config.baseUrl ?? DEFAULT_DMHY_BASE_URL);
    const keyword = query.keyword.trim();
    if (keyword) {
      url.searchParams.set("keyword", keyword);
    }

    const response = await this.httpClient.fetch(url, {
      source: "dmhy-release",
      headers: {
        "User-Agent": DESKTOP_BROWSER_USER_AGENT
      }
    });

    if (!response.ok) {
      throw new Error(`DMHY source failed: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    return parseDmhyList(html, this.config).slice(0, query.limit ?? 50);
  }

  async listLatestByFansub(groupId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: groupId });
  }

  async listLatestByAnime(animeId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: animeId });
  }
}

export function parseDmhyList(html: string, config: ReleaseSourceConfig): Release[] {
  const rows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];

  return rows
    .map((row, index) => parseDmhyRow(row, config, index))
    .filter((release): release is Release => Boolean(release))
    .map((release) => enrichReleaseFromTitle(release));
}

function parseDmhyRow(row: string, config: ReleaseSourceConfig, index: number): Release | null {
  const topic = findTopicLink(row);
  const magnetUrl = findHref(row, /^magnet:/i);
  const torrentUrl = findHref(row, /(?:\.torrent|\/topics\/download\/)/i);

  if (!topic || (!magnetUrl && !torrentUrl)) {
    return null;
  }

  const infoHash = extractInfoHash(magnetUrl);
  const publishedAt = parsePublishedAt(row);
  const size = parseSize(row);

  return {
    id: `${config.id}:${infoHash ?? topic.id ?? index}`,
    title: topic.title,
    sourceId: config.id,
    sourceName: config.name,
    magnetUrl,
    torrentUrl: torrentUrl ? absolutizeUrl(torrentUrl, config.baseUrl ?? DEFAULT_DMHY_BASE_URL) : undefined,
    infoHash,
    size,
    publishedAt: publishedAt ?? new Date().toISOString()
  };
}

function findTopicLink(row: string): { id?: string; title: string } | null {
  const matches = [...row.matchAll(/<a\b[^>]*href=["']([^"']*\/topics\/view\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const match = matches.at(-1);
  if (!match) {
    return null;
  }

  const href = decodeHtml(match[1]);
  const title = normalizeText(stripTags(match[2]));
  if (!title) {
    return null;
  }

  return {
    id: href.match(/\/topics\/view\/([^"'/?#]+)/i)?.[1],
    title
  };
}

function findHref(row: string, pattern: RegExp): string | undefined {
  for (const match of row.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = decodeHtml(match[1]);
    if (pattern.test(href)) {
      return href;
    }
  }

  return undefined;
}

function parsePublishedAt(row: string): string | undefined {
  const text = normalizeText(stripTags(row));
  const match = text.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{1,2})\b/);
  if (!match) {
    return undefined;
  }

  const [, year, month, day, hour, minute] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute)
  );

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseSize(row: string): number | undefined {
  const text = normalizeText(stripTags(row));
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)\b/i);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4
  };

  return Number.isFinite(value) ? Math.round(value * multipliers[unit]) : undefined;
}

function extractInfoHash(magnetUrl?: string): string | undefined {
  const match = magnetUrl?.match(/xt=urn:btih:([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase();
}

function absolutizeUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return new URL(url, baseUrl).toString();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function normalizeText(value: string): string {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
