import type {
  AnimeRssFeedDescriptor,
  AnimeRssSubscriptionContext,
  AnimeRssSubscriptionSource,
  AnimeSourceCandidate,
  ReleaseQuery,
  ReleaseSource
} from "@shared/contracts";
import type { Anime, Release, ReleaseSourceConfig } from "@shared/domain";
import { enrichReleaseFromTitle, normalizeFansubName } from "../releases/release-title-parser";
import { DESKTOP_BROWSER_USER_AGENT } from "../http/user-agents";
import { logger } from "../logger";
import { defaultMetadataHttpClient, type MetadataFetchOptions } from "../metadata/metadata-http-client";
import { parseMikanSeasonHtml } from "../metadata/mikan-metadata-provider";
import { RssReleaseSource } from "./rss-source";
import { collectReleasePages } from "./source-pagination";
import { normalizeReleaseSourceFetchLimit } from "./source-query";

const DEFAULT_MIKAN_BASE_URL = "https://mikanani.me/";
const MIKAN_FETCH_TIMEOUT_MS = 10_000;

export interface ReleaseHttpClient {
  fetch(input: string | URL, options?: MetadataFetchOptions): Promise<Response>;
}

export interface MikanSubgroup {
  id: string;
  name: string;
  rssUrl: string;
}

export class MikanReleaseSource implements ReleaseSource, AnimeRssSubscriptionSource {
  readonly animeRssBindingError = "请先确认蜜柑计划番剧匹配";

  constructor(
    public readonly config: ReleaseSourceConfig,
    private readonly httpClient: ReleaseHttpClient = defaultMetadataHttpClient
  ) {}

  async searchReleases(query: ReleaseQuery): Promise<Release[]> {
    if (this.config.kind === "rss") {
      return new RssReleaseSource(this.config, this.httpClient).searchReleases(query);
    }
    const keyword = query.keyword.trim();
    if (!keyword) {
      return [];
    }

    const baseUrl = this.config.baseUrl ?? DEFAULT_MIKAN_BASE_URL;
    return collectReleasePages(query.limit, async ({ page }) => {
      const url = buildMikanSearchUrl(baseUrl, keyword, page);
      const html = await fetchText(url, this.httpClient);
      return {
        items: parseMikanReleaseList(html, this.config),
        hasNextPage: hasMikanSearchPage(html, baseUrl, page + 1) || undefined
      };
    });
  }

  async listLatestByFansub(groupId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: groupId });
  }

  async listLatestByAnime(animeId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: animeId });
  }

  /** 根据已确认绑定或 Mikan 外部 ID 生成单番 RSS。 */
  buildAnimeRssSubscription(context: AnimeRssSubscriptionContext): AnimeRssFeedDescriptor | undefined {
    const boundSourceAnimeId = context.binding?.confirmed && context.binding.sourceId === this.config.id
      ? context.binding.sourceAnimeId.trim()
      : "";
    const sourceAnimeId = boundSourceAnimeId
      || (context.allowExternalIdFallback ? context.anime.externalIds.mikan?.trim() : "");
    if (!sourceAnimeId) {
      return undefined;
    }

    return createMikanAnimeRssDescriptor(this.config, sourceAnimeId, context.limit);
  }

  /** 读取 Mikan 单番 RSS，并补充字幕组订阅元数据。 */
  async fetchAnimeRssSubscription(subscription: AnimeRssFeedDescriptor): Promise<Release[]> {
    if (!subscription.sourceAnimeId) {
      throw new Error(this.animeRssBindingError);
    }
    const source = new RssReleaseSource(
      {
        ...this.config,
        kind: "rss",
        rssUrl: subscription.url
      },
      this.httpClient
    );
    const releases = await source.fetchAnimeRssSubscription(subscription);
    const subgroups = await this.readAnimeSubgroups(subscription.sourceAnimeId);
    return attachMikanSubgroupMeta(releases, subscription.sourceAnimeId, subgroups, this.config);
  }

  /** 按 Mikan 番组 ID 精确读取该番剧 RSS。 */
  async listReleasesByAnimeId(sourceAnimeId: string, limit = 50): Promise<Release[]> {
    return this.fetchAnimeRssSubscription(createMikanAnimeRssDescriptor(this.config, sourceAnimeId, limit));
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

  /** 读取番剧详情页中的字幕组 RSS 映射，失败时不阻断资源搜索。 */
  private async readAnimeSubgroups(sourceAnimeId: string): Promise<MikanSubgroup[]> {
    const url = new URL(`/Home/Bangumi/${encodeURIComponent(sourceAnimeId)}`, getMikanBaseUrl(this.config));
    try {
      const html = await fetchText(url.toString(), this.httpClient);
      return parseMikanSubgroups(html, this.config, sourceAnimeId);
    } catch (error) {
      logger.warn("Mikan 字幕组 RSS 映射读取失败", {
        sourceAnimeId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }
}

/** 构造 Mikan 单番 RSS 描述并统一限制返回数量。 */
function createMikanAnimeRssDescriptor(
  config: ReleaseSourceConfig,
  sourceAnimeId: string,
  limit = 50
): AnimeRssFeedDescriptor {
  const rssUrl = new URL("/RSS/Bangumi", getMikanBaseUrl(config));
  rssUrl.searchParams.set("bangumiId", sourceAnimeId);
  return {
    sourceId: config.id,
    sourceName: config.name,
    sourceAnimeId,
    url: rssUrl.toString(),
    limit: normalizeReleaseSourceFetchLimit(limit),
    exactAnimeMatch: true
  };
}

/** 生成 Mikan 资源搜索分页地址。 */
export function buildMikanSearchUrl(baseUrl: string, keyword: string, page = 1): string {
  const url = new URL("/Home/Search", baseUrl);
  url.searchParams.set("searchstr", keyword);
  if (page > 1) {
    url.searchParams.set("page", String(page));
  }
  return url.toString();
}

/** 从 Mikan 搜索页链接确认是否存在指定后续页。 */
function hasMikanSearchPage(html: string, baseUrl: string, expectedPage: number): boolean {
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(decodeHtml(match[1]), baseUrl);
      if (Number(url.searchParams.get("page")) === expectedPage) {
        return true;
      }
    } catch {
      // 忽略站点页面中无法解析的非标准链接。
    }
  }
  return false;
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

/** 从 Mikan 番剧详情页解析字幕组 ID、名称和对应 RSS 地址。 */
export function parseMikanSubgroups(html: string, config: ReleaseSourceConfig, sourceAnimeId?: string): MikanSubgroup[] {
  const groups = new Map<string, MikanSubgroup>();
  const patterns = [
    /<a\b[^>]*class=["'][^"']*\bsubgroup-name\b[^"']*\bsubgroup-(\d+)\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
    /<div\b[^>]*class=["'][^"']*\bsubgroup-text\b[^"']*["'][^>]*\bid=["'](\d+)["'][^>]*>\s*<a\b[^>]*href=["'][^"']*\/Home\/PublishGroup\/\d+[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const id = match[1]?.trim();
      const name = normalizeText(stripTags(match[2] ?? ""));
      if (!id || !name || groups.has(id)) {
        continue;
      }

      groups.set(id, {
        id,
        name,
        rssUrl: buildMikanSubgroupRssUrl(config, sourceAnimeId ?? parseMikanBangumiId(html), id)
      });
    }
  }

  return [...groups.values()];
}

/** 给 Mikan RSS 资源补充番剧和字幕组级订阅元信息。 */
function attachMikanSubgroupMeta(
  releases: Release[],
  sourceAnimeId: string,
  subgroups: MikanSubgroup[],
  config: ReleaseSourceConfig
): Release[] {
  const subgroupByName = new Map(
    subgroups.map((group) => [normalizeFansubName(group.name), group])
  );
  const animeRssUrl = buildMikanAnimeRssUrl(config, sourceAnimeId);

  return releases.map((release) => {
    const subgroup = release.fansubName
      ? subgroupByName.get(normalizeFansubName(release.fansubName))
      : undefined;
    return {
      ...release,
      sourceMeta: {
        ...release.sourceMeta,
        rssUrl: subgroup?.rssUrl ?? release.sourceMeta?.rssUrl ?? animeRssUrl,
        mikanBangumiId: sourceAnimeId,
        mikanSubgroupId: subgroup?.id,
        mikanSubgroupName: subgroup?.name
      }
    };
  });
}

function buildMikanAnimeRssUrl(config: ReleaseSourceConfig, sourceAnimeId: string): string {
  const url = new URL("/RSS/Bangumi", getMikanBaseUrl(config));
  url.searchParams.set("bangumiId", sourceAnimeId);
  return url.toString();
}

function buildMikanSubgroupRssUrl(config: ReleaseSourceConfig, sourceAnimeId: string | undefined, subgroupId: string): string {
  const url = new URL("/RSS/Bangumi", getMikanBaseUrl(config));
  if (sourceAnimeId) {
    url.searchParams.set("bangumiId", sourceAnimeId);
  }
  url.searchParams.set("subgroupid", subgroupId);
  return url.toString();
}

function parseMikanBangumiId(html: string): string | undefined {
  return html.match(/data-bangumiid=["'](\d+)["']/i)?.[1] ??
    html.match(/\/RSS\/Bangumi\?[^"']*\bbangumiId=(\d+)/i)?.[1];
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
