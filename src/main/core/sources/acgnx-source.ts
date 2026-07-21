import type { ReleaseQuery, ReleaseSource } from "@shared/contracts";
import type { Release, ReleaseSourceConfig } from "@shared/domain";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { logger } from "../logger";
import { DESKTOP_BROWSER_USER_AGENT } from "../http/user-agents";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import type { ReleaseHttpClient } from "./mikan-source";
import { collectReleasePages } from "./source-pagination";

const DEFAULT_ACGNX_BASE_URL = "https://share.acgnx.se/";
const ACGNX_FETCH_TIMEOUT_MS = 10_000;

export class AcgnxReleaseSource implements ReleaseSource {
  constructor(
    public readonly config: ReleaseSourceConfig,
    private readonly httpClient: ReleaseHttpClient = defaultMetadataHttpClient
  ) {}

  async searchReleases(query: ReleaseQuery): Promise<Release[]> {
    const keyword = query.keyword.trim();
    logger.info("ACGNX source search started", {
      sourceId: this.config.id,
      keyword,
      limit: query.limit
    });

    const result = await collectReleasePages(query.limit, async ({ page, limit }) => ({
      items: dedupeReleases(await this.searchWithCandidates(keyword, page, limit))
    }));

    logger.info("ACGNX source search finished", {
      sourceId: this.config.id,
      keyword,
      count: result.length
    });

    return result;
  }

  async listLatestByFansub(groupId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: groupId });
  }

  async listLatestByAnime(animeId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: animeId });
  }

  private async searchWithCandidates(keyword: string, page: number, limit: number): Promise<Release[]> {
    let lastError: Error | undefined;

    for (const url of buildSearchUrls(this.config.baseUrl ?? DEFAULT_ACGNX_BASE_URL, keyword, page, limit)) {
      try {
        const response = await fetchWithTimeout(this.httpClient, url);
        if (!response.ok) {
          if (response.status === 404 || response.status === 405) {
            continue;
          }

          throw new Error(`ACGNX source failed: ${response.status} ${response.statusText}`);
        }

        const text = await response.text();
        const releases = parseResponseText(text, this.config, response.headers.get("content-type") ?? "");
        if (releases.length) {
          return releases;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Network and timeout failures mean the mirror itself is not reachable; do not fan out more requests.
        if (/fetch failed|aborted|timeout|network/i.test(lastError.message)) {
          throw lastError;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    return [];
  }
}

export function parseAcgnxApiResponse(payload: unknown, config: ReleaseSourceConfig): Release[] {
  return findRecordArray(payload)
    .map((record, index) => mapAcgnxRecord(record, config, index))
    .filter((release): release is Release => Boolean(release))
    .map((release) => enrichReleaseFromTitle(release));
}

export function parseAcgnxHtml(html: string, config: ReleaseSourceConfig): Release[] {
  const rows = [
    ...(html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []),
    ...(html.match(/<li\b[\s\S]*?<\/li>/gi) ?? [])
  ];

  return rows
    .map((row, index) => mapAcgnxHtmlRow(row, config, index))
    .filter((release): release is Release => Boolean(release))
    .map((release) => enrichReleaseFromTitle(release));
}

function parseResponseText(text: string, config: ReleaseSourceConfig, contentType: string): Release[] {
  const trimmed = text.trim();
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseAcgnxApiResponse(JSON.parse(trimmed), config);
  }

  return parseAcgnxHtml(text, config);
}

function buildSearchUrls(baseUrl: string, keyword: string, page: number, limit: number): string[] {
  const base = new URL(baseUrl);
  if (base.pathname !== "/" && base.pathname !== "") {
    return [withSearchQuery(base, keyword, page, limit).toString()];
  }

  return ["/api.php", "/api/search", "/search.php"].map((path) => {
    const url = new URL(path, base);
    return withSearchQuery(url, keyword, page, limit).toString();
  });
}

/** 给 ACGNX API 或页面搜索地址补齐关键词和分页参数。 */
function withSearchQuery(url: URL, keyword: string, page: number, limit: number): URL {
  const next = new URL(url.toString());
  if (!next.searchParams.has("keyword")) {
    next.searchParams.set("keyword", keyword);
  }
  if (next.pathname.includes("api") && !next.searchParams.has("q")) {
    next.searchParams.set("q", keyword);
  }
  next.searchParams.set("page", String(page));
  next.searchParams.set("limit", String(limit));
  return next;
}

async function fetchWithTimeout(httpClient: ReleaseHttpClient, url: string): Promise<Response> {
  return httpClient.fetch(url, {
    source: "acgnx-release",
    timeoutMs: ACGNX_FETCH_TIMEOUT_MS,
    headers: {
      Accept: "application/json,text/html,application/xhtml+xml",
      "User-Agent": DESKTOP_BROWSER_USER_AGENT
    }
  });
}

function findRecordArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!isRecord(payload)) {
    return [];
  }

  for (const key of ["data", "items", "results", "list", "torrents", "resources"]) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value;
    }

    const nested = findRecordArray(value);
    if (nested.length) {
      return nested;
    }
  }

  return [];
}

function mapAcgnxRecord(record: unknown, config: ReleaseSourceConfig, index: number): Release | null {
  if (!isRecord(record)) {
    return null;
  }

  const title = getString(record, ["title", "name", "filename", "fileName", "resourceTitle", "torrentName", "subject"]);
  if (!title) {
    return null;
  }

  const magnetUrl = getMagnet(record);
  const torrentUrl = getTorrentUrl(record);
  if (!magnetUrl && !torrentUrl) {
    return null;
  }

  const infoHash = getString(record, ["infoHash", "info_hash", "hash", "btih"])?.toLowerCase() ?? extractInfoHash(magnetUrl);
  const id = getString(record, ["id", "torrentId", "torrent_id", "resourceId", "resource_id"]);

  return {
    id: `${config.id}:${id ?? infoHash ?? magnetUrl ?? torrentUrl ?? index}`,
    title,
    sourceId: config.id,
    sourceName: config.name,
    magnetUrl,
    torrentUrl: torrentUrl ? absolutizeUrl(torrentUrl, config.baseUrl ?? DEFAULT_ACGNX_BASE_URL) : undefined,
    infoHash,
    size: getSize(record),
    seeders: getNumber(record, ["seeders", "seeds", "seedCount", "seed_count", "seed"]),
    publishedAt:
      getString(record, ["publishedAt", "published_at", "publishTime", "publish_time", "createdAt", "created_at", "date", "time"]) ??
      new Date().toISOString()
  };
}

function mapAcgnxHtmlRow(row: string, config: ReleaseSourceConfig, index: number): Release | null {
  const magnetUrl = findHref(row, /^magnet:/i);
  const torrentUrl = findHref(row, /(?:\.torrent\b|download|torrent)/i);
  if (!magnetUrl && !torrentUrl) {
    return null;
  }

  const title = findTitle(row);
  if (!title) {
    return null;
  }

  const infoHash = extractInfoHash(magnetUrl);

  return {
    id: `${config.id}:${infoHash ?? torrentUrl ?? index}`,
    title,
    sourceId: config.id,
    sourceName: config.name,
    magnetUrl,
    torrentUrl: torrentUrl ? absolutizeUrl(torrentUrl, config.baseUrl ?? DEFAULT_ACGNX_BASE_URL) : undefined,
    infoHash,
    size: parseSize(normalizeText(stripTags(row))),
    seeders: parseSeeders(normalizeText(stripTags(row))),
    publishedAt: parsePublishedAt(normalizeText(stripTags(row))) ?? new Date().toISOString()
  };
}

function getMagnet(record: Record<string, unknown>): string | undefined {
  const value = getString(record, ["magnet", "magnetUrl", "magnet_url", "magnetUri", "magnet_uri", "magnetLink", "magnet_link", "download", "downloadUrl", "download_url", "url"]);
  return value?.startsWith("magnet:") ? value : undefined;
}

function getTorrentUrl(record: Record<string, unknown>): string | undefined {
  const value = getString(record, ["torrent", "torrentUrl", "torrent_url", "torrentLink", "torrent_link", "download", "downloadUrl", "download_url", "url"]);
  if (!value || value.startsWith("magnet:")) {
    return undefined;
  }

  return value;
}

function getSize(record: Record<string, unknown>): number | undefined {
  for (const key of ["size", "fileSize", "file_size", "length", "bytes"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      return parseSize(value) ?? parseOptionalNumber(value);
    }
  }

  return undefined;
}

function getNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function getString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return decodeHtml(value.trim());
    }
    if (typeof value === "number") {
      return String(value);
    }
  }

  return undefined;
}

function findTitle(row: string): string | undefined {
  const anchors = [...row.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const match of anchors.reverse()) {
    const href = decodeHtml(match[1]);
    if (/^magnet:|\.torrent\b|download/i.test(href)) {
      continue;
    }

    const title = normalizeText(stripTags(match[2]));
    if (title) {
      return title;
    }
  }

  const text = normalizeText(stripTags(row));
  return text || undefined;
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

function parsePublishedAt(text: string): string | undefined {
  const match = text.match(/\b(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?\b/);
  if (!match) {
    return undefined;
  }

  const [, year, month, day, hour = "0", minute = "0"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseSeeders(text: string): number | undefined {
  const match = text.match(/(?:seeders?|seeds?|做种|保种)\D{0,6}(\d{1,6})/i);
  return match ? parseOptionalNumber(match[1]) : undefined;
}

function parseSize(value: string): number | undefined {
  const match = value.match(/\b(\d+(?:\.\d+)?)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)\b/i);
  if (!match) {
    return undefined;
  }

  const size = Number(match[1]);
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

  return Number.isFinite(size) ? Math.round(size * multipliers[unit]) : undefined;
}

function parseOptionalNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractInfoHash(magnetUrl?: string): string | undefined {
  const match = magnetUrl?.match(/xt=urn:btih:([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase();
}

function absolutizeUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url) || url.startsWith("magnet:")) {
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

function dedupeReleases(releases: Release[]): Release[] {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
