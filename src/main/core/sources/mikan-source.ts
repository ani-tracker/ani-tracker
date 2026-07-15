import type { AnimeSourceCandidate, ReleaseQuery, ReleaseSource } from "@shared/contracts";
import type { Anime, Release, ReleaseSourceConfig } from "@shared/domain";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { DESKTOP_BROWSER_USER_AGENT } from "../http/user-agents";
import { defaultMetadataHttpClient, type MetadataFetchOptions } from "../metadata/metadata-http-client";
import { parseMikanSeasonHtml } from "../metadata/mikan-metadata-provider";
import { RssReleaseSource } from "./rss-source";

const DEFAULT_MIKAN_BASE_URL = "https://mikanani.me/";
const MIKAN_FETCH_TIMEOUT_MS = 10_000;

export interface ReleaseHttpClient {
  fetch(input: string | URL, options?: MetadataFetchOptions): Promise<Response>;
}

export class MikanReleaseSource implements ReleaseSource {
  constructor(
    public readonly config: ReleaseSourceConfig,
    private readonly httpClient: ReleaseHttpClient = defaultMetadataHttpClient
  ) {}

  async searchReleases(query: ReleaseQuery): Promise<Release[]> {
    const keyword = query.keyword.trim();
    if (!keyword) {
      return [];
    }

    const url = new URL("/Home/Search", this.config.baseUrl ?? DEFAULT_MIKAN_BASE_URL);
    url.searchParams.set("searchstr", keyword);

    const html = await fetchText(url.toString(), this.httpClient);
    return parseMikanReleaseList(html, this.config).slice(0, query.limit ?? 50);
  }

  async listLatestByFansub(groupId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: groupId });
  }

  async listLatestByAnime(animeId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: animeId });
  }

  /** 按 Mikan 番组 ID 精确读取该番剧 RSS。 */
  async listReleasesByAnimeId(sourceAnimeId: string, limit = 100): Promise<Release[]> {
    const rssUrl = new URL("/RSS/Bangumi", getMikanBaseUrl(this.config));
    rssUrl.searchParams.set("bangumiId", sourceAnimeId);
    const source = new RssReleaseSource(
      {
        ...this.config,
        kind: "rss",
        rssUrl: rssUrl.toString()
      },
      this.httpClient
    );
    return source.searchReleases({ keyword: "", limit });
  }

  /** 从 Mikan 对应季度目录查找待确认番剧。 */
  async searchAnimeCandidates(anime: Anime): Promise<Array<Omit<AnimeSourceCandidate, "score" | "reasons">>> {
    const url = new URL("/Home/BangumiCoverFlowByDayOfWeek", getMikanBaseUrl(this.config));
    url.searchParams.set("year", String(anime.premiereYear));
    url.searchParams.set("seasonStr", getMikanSeason(anime.premiereMonth));
    const html = await fetchText(url.toString(), this.httpClient);
    return parseMikanSeasonHtml(html, getMikanBaseUrl(this.config)).map((candidate) => ({
      sourceId: this.config.id,
      sourceName: this.config.name,
      sourceAnimeId: candidate.id,
      title: candidate.title,
      aliases: [],
      premiereYear: anime.premiereYear,
      premiereMonth: getSeasonStartMonth(anime.premiereMonth),
      sourceUrl: candidate.detailUrl
    }));
  }
}

function getMikanBaseUrl(config: ReleaseSourceConfig): string {
  if (config.baseUrl) {
    return config.baseUrl;
  }
  if (config.rssUrl) {
    return new URL(config.rssUrl).origin;
  }
  return DEFAULT_MIKAN_BASE_URL;
}

function getMikanSeason(month: number): "冬" | "春" | "夏" | "秋" {
  if (month <= 3) return "冬";
  if (month <= 6) return "春";
  if (month <= 9) return "夏";
  return "秋";
}

function getSeasonStartMonth(month: number): number {
  return Math.floor((month - 1) / 3) * 3 + 1;
}

export function parseMikanReleaseList(html: string, config: ReleaseSourceConfig): Release[] {
  const rows = [
    ...(html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []),
    ...(html.match(/<li\b[\s\S]*?<\/li>/gi) ?? [])
  ];
  const parsedRows = rows
    .map((row, index) => parseMikanReleaseRow(row, config, index))
    .filter((release): release is Release => Boolean(release));

  if (parsedRows.length) {
    return parsedRows.map((release) => enrichReleaseFromTitle(release));
  }

  return parseMikanReleaseAnchors(html, config).map((release) => enrichReleaseFromTitle(release));
}

function parseMikanReleaseRow(row: string, config: ReleaseSourceConfig, index: number): Release | null {
  const episode = findEpisodeLink(row);
  const title = episode?.title;
  const magnetUrl = findHref(row, /^magnet:/i);
  const torrentUrl = findHref(row, /(?:\/Download\/|\.torrent\b)/i) ?? buildTorrentUrl(episode?.id, config);

  if (!title || (!magnetUrl && !torrentUrl)) {
    return null;
  }

  return {
    id: `${config.id}:${episode?.id ?? extractInfoHash(magnetUrl) ?? index}`,
    title,
    sourceId: config.id,
    sourceName: config.name,
    magnetUrl,
    torrentUrl: torrentUrl ? absolutizeUrl(torrentUrl, config.baseUrl ?? DEFAULT_MIKAN_BASE_URL) : undefined,
    infoHash: extractInfoHash(magnetUrl),
    size: parseSize(row),
    publishedAt: parsePublishedAt(row) ?? new Date().toISOString()
  };
}

function parseMikanReleaseAnchors(html: string, config: ReleaseSourceConfig): Release[] {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']*\/Home\/Episode\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match, index): Release | null => {
      const [, href, id, body] = match;
      const title = normalizeText(stripTags(body));
      if (!title) {
        return null;
      }

      return {
        id: `${config.id}:${id}`,
        title,
        sourceId: config.id,
        sourceName: config.name,
        torrentUrl: buildTorrentUrl(id, config),
        publishedAt: new Date().toISOString()
      };
    })
    .filter((release): release is Release => Boolean(release));
}

function findEpisodeLink(row: string): { id: string; title: string } | null {
  const matches = [...row.matchAll(/<a\b[^>]*href=["']([^"']*\/Home\/Episode\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const match = matches.find((item) => normalizeText(stripTags(item[3])).length > 1);
  if (!match) {
    return null;
  }

  return {
    id: match[2],
    title: normalizeText(stripTags(match[3]))
  };
}

async function fetchText(url: string, httpClient: ReleaseHttpClient): Promise<string> {
  const response = await httpClient.fetch(url, {
    source: "mikan-release",
    timeoutMs: MIKAN_FETCH_TIMEOUT_MS,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": DESKTOP_BROWSER_USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Mikan 下载源请求失败: ${response.status} ${response.statusText}`);
  }

  return response.text();
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

function buildTorrentUrl(episodeId: string | undefined, config: ReleaseSourceConfig): string | undefined {
  if (!episodeId) {
    return undefined;
  }

  return new URL(`/Download/${episodeId}.torrent`, config.baseUrl ?? DEFAULT_MIKAN_BASE_URL).toString();
}

function parsePublishedAt(row: string): string | undefined {
  const text = normalizeText(stripTags(row));
  const match = text.match(/\b(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?\b/);
  if (!match) {
    return undefined;
  }

  const [, year, month, day, hour = "0", minute = "0"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
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
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
