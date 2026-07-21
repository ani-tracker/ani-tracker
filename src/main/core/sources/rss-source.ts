import type { ReleaseQuery, ReleaseSource } from "@shared/contracts";
import type { Release, ReleaseSourceConfig } from "@shared/domain";
import { normalizeReleaseSearchText } from "../../../shared/anime-release-search";
import { enrichReleaseFromTitle } from "../releases/release-title-parser";
import { DESKTOP_BROWSER_ACCEPT_LANGUAGE, DESKTOP_BROWSER_USER_AGENT } from "../http/user-agents";
import { defaultMetadataHttpClient, type MetadataFetchOptions } from "../metadata/metadata-http-client";
import { normalizeReleaseSourceFetchLimit } from "./source-query";
import { parseXml, textValue, toArray } from "./xml";

export interface RssHttpClient {
  fetch(input: string | URL, options?: MetadataFetchOptions): Promise<Response>;
}

export interface RssFeedRequestOptions {
  requestSource?: string;
  errorName?: string;
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
  "media:content"?: {
    "@url"?: string;
    "@fileSize"?: string;
  };
  "torrent:contentLength"?: unknown;
  "nyaa:seeders"?: unknown;
  "nyaa:infoHash"?: unknown;
  "nyaa:size"?: unknown;
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

  /** 读取固定 RSS，并按标题关键词过滤资源。 */
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

    return filtered.slice(0, normalizeReleaseSourceFetchLimit(query.limit));
  }

  /** 读取固定 RSS 中的最新字幕组资源。 */
  async listLatestByFansub(groupId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: groupId });
  }

  /** 读取固定 RSS 中的最新番剧资源。 */
  async listLatestByAnime(animeId: string): Promise<Release[]> {
    return this.searchReleases({ keyword: animeId });
  }

  /** 使用当前来源配置读取 RSS。 */
  private async readFeed(): Promise<Release[]> {
    if (!this.config.rssUrl) {
      return [];
    }

    return fetchRssReleases(this.config, this.httpClient, this.config.rssUrl);
  }
}

/** 拉取指定 RSS 地址，并复用统一请求头、错误处理和解析逻辑。 */
export async function fetchRssReleases(
  config: ReleaseSourceConfig,
  httpClient: RssHttpClient,
  rssUrl: string,
  options: RssFeedRequestOptions = {}
): Promise<Release[]> {
  const response = await httpClient.fetch(rssUrl, {
    source: options.requestSource ?? "rss-release",
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
    throw new Error(`${options.errorName ?? "RSS"} source failed: ${response.status} ${response.statusText}`);
  }

  return parseRssReleases(await response.text(), config, rssUrl);
}

/** 将通用 RSS、Nyaa 扩展和 ACG.RIP 扩展字段映射为统一资源。 */
export function parseRssReleases(
  xml: string,
  config: ReleaseSourceConfig,
  rssUrl = config.rssUrl
): Release[] {
  const parsed = parseXml<RssDocument>(xml);
  const items = [
    ...toArray(parsed.rss?.channel?.item),
    ...toArray(parsed.feed?.entry)
  ];

  return items.map((item, index) => enrichReleaseFromTitle(mapRssItem(item, index, config, rssUrl)));
}

/** 将单条 RSS 数据转换为下载资源，并补齐种子摘要和磁力地址。 */
function mapRssItem(
  item: RssItem,
  index: number,
  config: ReleaseSourceConfig,
  rssUrl?: string
): Release {
  const title = textValue(item.title) ?? `RSS Item ${index + 1}`;
  const link = textValue(item.link);
  const guid = textValue(item.guid);
  const enclosureUrl = item.enclosure?.["@url"];
  const mediaUrl = item["media:content"]?.["@url"];
  const torrentLink = textValue(item.torrent?.link);
  const explicitInfoHash = normalizeInfoHash(textValue(item["nyaa:infoHash"]));
  const feedMagnetUrl = [link, enclosureUrl, mediaUrl, torrentLink].find(isMagnet);
  const infoHash = explicitInfoHash ?? extractInfoHash(feedMagnetUrl);
  const magnetUrl = feedMagnetUrl ?? buildMagnetUrl(infoHash, title);
  const torrentUrl = [enclosureUrl, mediaUrl, torrentLink, link].find(isTorrentDownloadUrl);
  const sourceUrl = [guid, link].find(isSourcePageUrl) ?? link ?? guid;
  const sourceMeta = buildRssSourceMeta(rssUrl, sourceUrl);

  return {
    id: `${config.id}:${guid ?? infoHash ?? magnetUrl ?? torrentUrl ?? link ?? title}`,
    title,
    sourceId: config.id,
    sourceName: config.name,
    magnetUrl,
    torrentUrl,
    infoHash,
    size: firstDefinedNumber([
      item.enclosure?.["@length"],
      textValue(item.torrent?.contentLength),
      textValue(item["torrent:contentLength"]),
      item["media:content"]?.["@fileSize"],
      textValue(item["nyaa:size"])
    ]),
    seeders: parseOptionalNumber(textValue(item["nyaa:seeders"])),
    publishedAt:
      textValue(item.pubDate) ??
      textValue(item.published) ??
      textValue(item.updated) ??
      textValue(item.torrent?.pubDate) ??
      new Date().toISOString(),
    sourceMeta
  };
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

/** 判断链接是否可作为资源详情页，而不是种子下载地址。 */
function isSourcePageUrl(value?: string): value is string {
  return Boolean(value && /^https?:\/\//i.test(value) && !isTorrentDownloadUrl(value));
}

function isTorrentDownloadUrl(value?: string): value is string {
  return Boolean(value && !isMagnet(value) && /(?:\.torrent\b|\/Download\/|\/download\/|\/topics\/download\/)/i.test(value));
}

/** 从多个候选字段中读取第一个合法字节数。 */
function firstDefinedNumber(values: Array<string | undefined>): number | undefined {
  for (const value of values) {
    const parsed = parseByteSize(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

/** 解析纯数字或 KiB、MiB、GiB、TiB 体积文本。 */
function parseByteSize(value?: string): number | undefined {
  const numeric = parseOptionalNumber(value);
  if (numeric !== undefined) {
    return numeric;
  }
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)$/i);
  if (!match) {
    return undefined;
  }
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
  return Math.round(Number(match[1]) * multipliers[match[2].toLowerCase()]);
}

/** 规范 RSS 提供的 BT 摘要。 */
function normalizeInfoHash(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z0-9]{8,64}$/.test(normalized) ? normalized : undefined;
}

/** 从磁力地址中提取 BT 摘要。 */
function extractInfoHash(magnetUrl?: string): string | undefined {
  return normalizeInfoHash(magnetUrl?.match(/(?:^|[?&])xt=urn:btih:([a-z0-9]+)/i)?.[1]);
}

/** 使用摘要和标题生成可直接交给下载引擎的磁力地址。 */
function buildMagnetUrl(infoHash: string | undefined, title: string): string | undefined {
  if (!infoHash) {
    return undefined;
  }
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
}

function parseOptionalNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
