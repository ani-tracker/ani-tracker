import type {
  AnimeRssFeedDescriptor,
  AnimeRssSubscriptionContext,
  AnimeRssSubscriptionSource,
  AnimeSourceCandidate,
  ReleaseQuery,
  ReleaseSource
} from "@shared/contracts";
import type { Anime, Release, ReleaseSourceConfig, SubtitlePreference } from "@shared/domain";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { logger } from "../logger";
import { DESKTOP_BROWSER_ACCEPT_LANGUAGE, DESKTOP_BROWSER_USER_AGENT } from "../http/user-agents";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import type { ReleaseHttpClient } from "./mikan-source";
import { normalizeReleaseSourceFetchLimit } from "./source-query";
import { parseXml, textValue, toArray } from "./xml";

const DEFAULT_ANIBT_BASE_URL = "https://anibt.net/";
const ANIBT_FETCH_TIMEOUT_MS = 10_000;
const MAX_BGM_FEEDS_PER_SEARCH = 3;

interface AniBtBgmSearchResponse {
  ok?: boolean;
  data?: AniBtBgmSearchItem[];
}

interface AniBtBgmSearchItem {
  bgmId?: number | string;
  title?: string;
  name?: string;
  nameCn?: string;
  originalTitle?: string;
  year?: number | string;
  month?: number | string;
  episodeCount?: number | string;
}

interface AniBtRssDocument {
  rss?: {
    channel?: {
      item?: AniBtRssItem | AniBtRssItem[];
    };
  };
}

interface AniBtRssItem {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  pubDate?: unknown;
  enclosure?: {
    "@url"?: string;
    "@length"?: string;
  };
  description?: unknown;
  "anibt:releaseId"?: unknown;
  "anibt:torrentUrl"?: unknown;
  "anibt:releaseTitle"?: unknown;
  "anibt:groupName"?: unknown;
  "anibt:groupSlug"?: unknown;
  "anibt:episode"?: unknown;
  "anibt:resolution"?: unknown;
  "anibt:language"?: unknown;
  "anibt:fileSize"?: unknown;
  "anibt:customTag"?: unknown | unknown[];
  torrent?: {
    contentLength?: unknown;
    infohash?: unknown;
    magneturi?: unknown;
    pubDate?: unknown;
    filename?: unknown;
  };
}

export class AniBtReleaseSource implements ReleaseSource, AnimeRssSubscriptionSource {
  readonly animeRssBindingError = "请先确认 AniBT 番剧匹配";

  constructor(
    public readonly config: ReleaseSourceConfig,
    private readonly httpClient: ReleaseHttpClient = defaultMetadataHttpClient
  ) {}

  async searchReleases(query: ReleaseQuery): Promise<Release[]> {
    const keyword = query.keyword.trim();
    const limit = normalizeReleaseSourceFetchLimit(query.limit);
    const releases: Release[] = [];

    logger.info("AniBT source search started", {
      sourceId: this.config.id,
      keyword,
      limit
    });

    if (keyword) {
      try {
        const bgmIds = await this.searchBgmIds(keyword);
        for (const bgmId of bgmIds.slice(0, MAX_BGM_FEEDS_PER_SEARCH)) {
          releases.push(...(await this.readAnimeFeed(bgmId, limit)));
        }
      } catch (error) {
        logger.warn("AniBT BGM search failed; falling back to latest RSS", {
          sourceId: this.config.id,
          keyword,
          message: getErrorMessage(error)
        });
      }
    }

    if (!keyword || releases.length < limit) {
      const latest = await this.readLatestFeed(limit);
      releases.push(...(keyword ? latest.filter((release) => matchesKeyword(release, keyword)) : latest));
    }

    const result = dedupeReleases(releases).slice(0, limit);
    logger.info("AniBT source search finished", {
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

  /** 根据已确认绑定或 Bangumi 外部 ID 生成 AniBT 单番 RSS。 */
  buildAnimeRssSubscription(context: AnimeRssSubscriptionContext): AnimeRssFeedDescriptor | undefined {
    const boundSourceAnimeId = context.binding?.confirmed && context.binding.sourceId === this.config.id
      ? context.binding.sourceAnimeId.trim()
      : "";
    const sourceAnimeId = boundSourceAnimeId
      || (context.allowExternalIdFallback ? context.anime.externalIds.bangumi?.trim() : "");
    if (!sourceAnimeId) {
      return undefined;
    }

    return createAniBtAnimeRssDescriptor(this.config, sourceAnimeId, context.limit);
  }

  /** 读取并解析 AniBT 单番 RSS 扩展字段。 */
  async fetchAnimeRssSubscription(subscription: AnimeRssFeedDescriptor): Promise<Release[]> {
    const releases = await this.readFeed(subscription.url);
    return releases.slice(0, normalizeReleaseSourceFetchLimit(subscription.limit));
  }

  /** 按 Bangumi ID 精确读取 AniBT 番剧 RSS。 */
  async listReleasesByAnimeId(sourceAnimeId: string, limit = 50): Promise<Release[]> {
    return this.fetchAnimeRssSubscription(createAniBtAnimeRssDescriptor(this.config, sourceAnimeId, limit));
  }

  /** 查询 AniBT 可供用户确认的番剧候选。 */
  async searchAnimeCandidates(anime: Anime): Promise<Array<Omit<AnimeSourceCandidate, "score" | "reasons">>> {
    const keywords = [anime.title, anime.originalTitle, ...anime.aliases.map((item) => item.alias)].filter(
      (value): value is string => Boolean(value)
    );
    const candidates = (
      await Promise.all(keywords.slice(0, 4).map((keyword) => this.searchBgmCandidates(keyword)))
    ).flat();
    const byId = new Map<string, Omit<AnimeSourceCandidate, "score" | "reasons">>();
    for (const candidate of candidates) {
      byId.set(candidate.sourceAnimeId, candidate);
    }
    return [...byId.values()];
  }

  private async searchBgmIds(keyword: string): Promise<string[]> {
    return (await this.searchBgmCandidates(keyword)).map((item) => item.sourceAnimeId);
  }

  private async searchBgmCandidates(
    keyword: string
  ): Promise<Array<Omit<AnimeSourceCandidate, "score" | "reasons">>> {
    const url = new URL("/api/bgm/search", this.config.baseUrl ?? DEFAULT_ANIBT_BASE_URL);
    url.searchParams.set("q", keyword);

    const response = await fetchWithTimeout(this.httpClient, url.toString(), {
      headers: createAniBtHeaders(this.config, "application/json")
    });

    if (!response.ok) {
      throw createAniBtResponseError("番剧匹配", response);
    }

    const payload = (await response.json()) as AniBtBgmSearchResponse;
    if (payload.ok === false) {
      throw new Error("AniBT BGM search returned an error");
    }

    return toArray(payload.data)
      .filter((item) => item.bgmId !== undefined && item.bgmId !== null)
      .map((item) => ({
        sourceId: this.config.id,
        sourceName: this.config.name,
        sourceAnimeId: String(item.bgmId),
        title: item.nameCn ?? item.title ?? item.name ?? keyword,
        originalTitle: item.originalTitle,
        aliases: [],
        premiereYear: parseOptionalNumber(item.year === undefined ? undefined : String(item.year)),
        premiereMonth: parseOptionalNumber(item.month === undefined ? undefined : String(item.month)),
        episodeCount: parseOptionalNumber(item.episodeCount === undefined ? undefined : String(item.episodeCount)),
        sourceUrl: `https://bgm.tv/subject/${encodeURIComponent(String(item.bgmId))}`
      }));
  }

  private async readAnimeFeed(bgmId: string, limit: number): Promise<Release[]> {
    return this.fetchAnimeRssSubscription(createAniBtAnimeRssDescriptor(this.config, bgmId, limit));
  }

  private async readLatestFeed(limit: number): Promise<Release[]> {
    const url = new URL("/rss/magnets.xml", this.config.baseUrl ?? DEFAULT_ANIBT_BASE_URL);
    url.searchParams.set("limit", String(limit));
    return this.readFeed(url.toString());
  }

  private async readFeed(url: string): Promise<Release[]> {
    const response = await fetchWithTimeout(this.httpClient, url, {
      headers: createAniBtHeaders(this.config, "application/rss+xml,application/xml,text/xml")
    });

    if (!response.ok) {
      throw createAniBtResponseError("RSS", response);
    }

    return parseAniBtRss(await response.text(), this.config);
  }
}

/** 构造 AniBT 单番 RSS 描述，单次请求最多返回 50 条。 */
function createAniBtAnimeRssDescriptor(
  config: ReleaseSourceConfig,
  sourceAnimeId: string,
  limit = 50
): AnimeRssFeedDescriptor {
  const normalizedLimit = normalizeReleaseSourceFetchLimit(limit);
  const url = new URL("/rss/anime.xml", config.baseUrl ?? DEFAULT_ANIBT_BASE_URL);
  url.searchParams.set("bgmId", sourceAnimeId);
  url.searchParams.set("limit", String(normalizedLimit));
  return {
    sourceId: config.id,
    sourceName: config.name,
    sourceAnimeId,
    url: url.toString(),
    limit: normalizedLimit,
    exactAnimeMatch: true
  };
}

export function createAniBtHeaders(config: ReleaseSourceConfig, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "Accept-Language": DESKTOP_BROWSER_ACCEPT_LANGUAGE,
    "User-Agent": DESKTOP_BROWSER_USER_AGENT
  };

  const credential = config.apiKey?.trim();
  if (!credential) {
    return headers;
  }

  if (/^cookie\s*:/i.test(credential)) {
    headers.Cookie = credential.replace(/^cookie\s*:\s*/i, "");
    return headers;
  }

  if (/^authorization\s*:/i.test(credential)) {
    headers.Authorization = credential.replace(/^authorization\s*:\s*/i, "");
    return headers;
  }

  if (/^x-api-key\s*:/i.test(credential)) {
    headers["X-API-Key"] = credential.replace(/^x-api-key\s*:\s*/i, "");
    return headers;
  }

  if (/^[^=\s]+=[^;]+(?:;\s*[^=\s]+=[^;]+)*$/.test(credential)) {
    headers.Cookie = credential;
    return headers;
  }

  headers.Authorization = /^bearer\s+/i.test(credential) ? credential : `Bearer ${credential}`;
  headers["X-API-Key"] = credential.replace(/^bearer\s+/i, "");
  return headers;
}

export function parseAniBtRss(xml: string, config: ReleaseSourceConfig): Release[] {
  const parsed = parseXml<AniBtRssDocument>(xml);
  return toArray(parsed.rss?.channel?.item)
    .map((item, index) => mapAniBtItem(item, config, index))
    .map((release) => enrichReleaseFromTitle(release));
}

function mapAniBtItem(item: AniBtRssItem, config: ReleaseSourceConfig, index: number): Release {
  const title =
    textValue(item["anibt:releaseTitle"]) ??
    textValue(item.torrent?.filename) ??
    textValue(item.title) ??
    `AniBT Item ${index + 1}`;
  const releaseId = textValue(item["anibt:releaseId"]) ?? textValue(item.guid);
  const magnetUrl = textValue(item.torrent?.magneturi) ?? findMagnet(textValue(item.description));
  const torrentUrl = textValue(item["anibt:torrentUrl"]) ?? item.enclosure?.["@url"];
  const infoHash = textValue(item.torrent?.infohash)?.toLowerCase() ?? extractInfoHash(magnetUrl);
  const size =
    parseOptionalNumber(textValue(item["anibt:fileSize"])) ??
    parseOptionalNumber(textValue(item.torrent?.contentLength)) ??
    parseOptionalNumber(item.enclosure?.["@length"]);

  return {
    id: `${config.id}:${releaseId ?? infoHash ?? torrentUrl ?? title}`,
    title,
    sourceId: config.id,
    sourceName: config.name,
    fansubName: textValue(item["anibt:groupName"]),
    magnetUrl,
    torrentUrl,
    infoHash,
    size,
    episodeNo: parseOptionalNumber(textValue(item["anibt:episode"])),
    resolution: normalizeResolution(textValue(item["anibt:resolution"])),
    declaredVideoCodec: findCodecTag(
      toArray(item["anibt:customTag"])
        .map((tag) => textValue(tag))
        .filter((tag): tag is string => Boolean(tag))
    ),
    subtitle: normalizeSubtitle(textValue(item["anibt:language"])),
    publishedAt: textValue(item.pubDate) ?? textValue(item.torrent?.pubDate) ?? new Date().toISOString()
  };
}

async function fetchWithTimeout(httpClient: ReleaseHttpClient, url: string, init: RequestInit): Promise<Response> {
  return httpClient.fetch(url, {
    ...init,
    source: "anibt-release",
    timeoutMs: ANIBT_FETCH_TIMEOUT_MS
  });
}

function normalizeResolution(value?: string): Release["resolution"] {
  if (/2160p|4k/i.test(value ?? "")) {
    return "2160p";
  }
  if (/1080p/i.test(value ?? "")) {
    return "1080p";
  }
  if (/720p/i.test(value ?? "")) {
    return "720p";
  }
  return undefined;
}

function normalizeSubtitle(value?: string): SubtitlePreference | undefined {
  const normalized = value?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("chs") && normalized.includes("cht")) {
    return "multi";
  }
  if (normalized.includes("chs") || normalized.includes("sc")) {
    return "chs";
  }
  if (normalized.includes("cht") || normalized.includes("tc")) {
    return "cht";
  }
  if (normalized.includes("jpn") || normalized.includes("jp")) {
    return "jpn";
  }
  if (normalized.includes("eng") || normalized.includes("en")) {
    return "eng";
  }
  return undefined;
}

function findCodecTag(tags: string[]): string | undefined {
  return tags.find((tag) => /\b(?:avc|h\.?264|x264|hevc|h\.?265|x265|av1|vp9)\b/i.test(tag));
}

function findMagnet(value?: string): string | undefined {
  const match = value?.match(/magnet:\?[^"' <]+/i);
  return match ? decodeHtml(match[0]) : undefined;
}

function extractInfoHash(magnetUrl?: string): string | undefined {
  const match = magnetUrl?.match(/xt=urn:btih:([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase();
}

function parseOptionalNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function matchesKeyword(release: Release, keyword: string): boolean {
  return release.title.toLowerCase().includes(keyword.toLowerCase());
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 将 AniBT 访问保护响应转换为可执行的用户提示。 */
function createAniBtResponseError(operation: string, response: Response): Error {
  if (response.status === 403) {
    return new Error(`AniBT ${operation}暂时被站点拒绝（403），请保持单一网络出口并在熔断结束后重试`);
  }
  if (response.status === 429) {
    return new Error(`AniBT ${operation}请求过于频繁（429），请等待站点允许后重试`);
  }
  return new Error(`AniBT ${operation}请求失败：${response.status} ${response.statusText}`.trim());
}
