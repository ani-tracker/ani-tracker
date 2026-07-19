import type { Anime, AnimeAlias, AnimeBroadcastSchedule, AnimeStaffCredit, Season } from "@shared/domain";
import { inferAnimeAliasLanguage } from "../../../shared/anime-title";
import {
  formatMonthStartDate,
  getSeasonInfo,
  isDateInMonth,
  type AnimeDetailMetadataProvider,
  type MonthlyAnimeMetadataProvider
} from "./metadata-provider";
import { defaultMetadataHttpClient, type MetadataHttpClient } from "./metadata-http-client";
import { DESKTOP_BROWSER_USER_AGENT } from "../http/user-agents";

const DEFAULT_MIKAN_BASE_URL = "https://mikanani.me/";
const MIKAN_FETCH_TIMEOUT_MS = 10_000;
const MIKAN_DETAIL_LIMIT = 60;
const MIKAN_DETAIL_CONCURRENCY = 6;

interface MikanCandidate {
  id: string;
  title: string;
  detailUrl: string;
}

interface MikanDetail {
  title?: string;
  originalTitle?: string;
  summary?: string;
  coverUrl?: string;
  premiereDate?: string;
  bangumiId?: string;
  episodeCount?: number;
  broadcast?: AnimeBroadcastSchedule;
  genres?: string[];
  studios?: string[];
  staff?: AnimeStaffCredit[];
  durationMinutes?: number;
}

export class MikanMetadataProvider implements MonthlyAnimeMetadataProvider, AnimeDetailMetadataProvider {
  readonly id = "mikan";

  constructor(
    private readonly baseUrl = DEFAULT_MIKAN_BASE_URL,
    private readonly httpClient: MetadataHttpClient = defaultMetadataHttpClient
  ) {}

  async getAnimeByMonth(year: number, month: number): Promise<Anime[]> {
    const seasonInfo = getSeasonInfo(month);
    const html = await this.fetchSeasonHtml(year, seasonInfo.mikanSeason);
    const candidates = parseMikanSeasonHtml(html, this.baseUrl);
    const detailedCandidates = await mapWithConcurrency(
      candidates.slice(0, MIKAN_DETAIL_LIMIT),
      MIKAN_DETAIL_CONCURRENCY,
      async (candidate) => ({
        candidate,
        detail: await this.fetchDetail(candidate.detailUrl)
      })
    );

    return detailedCandidates
      .filter(({ detail }) =>
        // Mikan 只暴露季度列表；没有明确首播日期时只归入该季度第一个月。
        detail.premiereDate ? isDateInMonth(detail.premiereDate, year, month) : isSeasonStartMonth(month)
      )
      .map(({ candidate, detail }) => mapMikanCandidate(candidate, detail, year, month, seasonInfo.season));
  }

  /** 按 Mikan external id 读取单部番剧详情。 */
  async getAnimeDetail(externalId: string, fallback: Anime): Promise<Anime> {
    if (!/^\d+$/.test(externalId)) {
      throw new Error("Mikan 标识无效");
    }
    const detailUrl = new URL(`/Home/Bangumi/${externalId}`, this.baseUrl).toString();
    const detail = await this.fetchDetailStrict(detailUrl);
    return mapMikanCandidate(
      { id: externalId, title: fallback.title, detailUrl },
      detail,
      fallback.premiereYear,
      fallback.premiereMonth,
      fallback.season ?? getSeasonInfo(fallback.premiereMonth).season
    );
  }

  private async fetchSeasonHtml(year: number, season: string): Promise<string> {
    const endpoints = ["/Home/BangumiCoverFlowByDayOfWeek", "/Home/Classic"];
    const errors: string[] = [];

    for (const endpoint of endpoints) {
      const url = new URL(endpoint, this.baseUrl);
      url.searchParams.set("year", String(year));
      url.searchParams.set("seasonStr", season);

      try {
        const html = await fetchText(url.toString(), this.httpClient);
        if (parseMikanSeasonHtml(html, this.baseUrl).length) {
          return html;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(errors.length ? errors.join("; ") : "Mikan 季度页未返回番组条目");
  }

  private async fetchDetail(detailUrl: string): Promise<MikanDetail> {
    try {
      return await this.fetchDetailStrict(detailUrl);
    } catch {
      return {};
    }
  }

  /** 请求并解析 Mikan 详情页，主动刷新时保留失败信息。 */
  private async fetchDetailStrict(detailUrl: string): Promise<MikanDetail> {
    return parseMikanDetailHtml(await fetchText(detailUrl, this.httpClient), detailUrl);
  }
}

export function parseMikanSeasonHtml(html: string, baseUrl = DEFAULT_MIKAN_BASE_URL): MikanCandidate[] {
  const links = [
    ...html.matchAll(/<a\b([^>]*href=["']([^"']*\/Home\/Bangumi\/(\d+)[^"']*)["'][^>]*)>([\s\S]*?)<\/a>/gi)
  ];
  const byId = new Map<string, MikanCandidate>();

  for (const match of links) {
    const [, attrs, href, id, body] = match;
    const title = pickMikanTitle([readAttribute(attrs, "title"), readAttribute(attrs, "alt"), stripTags(body)]);
    if (!title) {
      continue;
    }

    const existing = byId.get(id);
    if (existing && existing.title.length >= title.length) {
      continue;
    }

    byId.set(id, {
      id,
      title,
      detailUrl: new URL(decodeHtml(href), baseUrl).toString()
    });
  }

  return [...byId.values()];
}

export function parseMikanDetailHtml(html: string, detailUrl: string): MikanDetail {
  const title = pickMikanTitle([
    readMetaContent(html, "og:title"),
    readTagText(html, "h1"),
    readTitleTag(html)
  ]);
  const summary = sanitizeMikanSummary(readMetaContent(html, "description") ?? readMetaContent(html, "og:description"));
  const coverUrl = absolutizeOptionalUrl(
    readMetaContent(html, "og:image") ?? readImageSource(html),
    detailUrl
  );

  return {
    title,
    originalTitle: pickMikanTitle([readLabeledValue(html, "原名"), readLabeledValue(html, "日文名")]),
    summary,
    coverUrl,
    premiereDate: parsePremiereDate(html),
    bangumiId: html.match(/(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)/i)?.[1],
    episodeCount: parsePositiveInteger(readLabeledValue(html, "话数") ?? readLabeledValue(html, "集数")),
    broadcast: parseMikanBroadcast(readLabeledValue(html, "放送星期") ?? readLabeledValue(html, "播放时间")),
    genres: splitMetadataValues(readLabeledValue(html, "类型") ?? readLabeledValue(html, "标签")),
    studios: splitMetadataValues(readLabeledValue(html, "动画制作") ?? readLabeledValue(html, "制作")),
    staff: buildMikanStaff(html),
    durationMinutes: parseDurationMinutes(readLabeledValue(html, "片长") ?? readLabeledValue(html, "时长"))
  };
}

function mapMikanCandidate(
  candidate: MikanCandidate,
  detail: MikanDetail,
  fallbackYear: number,
  fallbackMonth: number,
  season: Season
): Anime {
  const title = detail.title ?? candidate.title;
  const originalTitle = detail.originalTitle && detail.originalTitle !== title ? detail.originalTitle : undefined;
  const premiereDate = detail.premiereDate ?? formatMonthStartDate(fallbackYear, fallbackMonth);
  const [year, month] = premiereDate.split("-").map(Number);

  return {
    id: `mikan-${candidate.id}`,
    title,
    originalTitle,
    aliases: buildMikanAliases(candidate, detail, title),
    premiereDate,
    premiereYear: Number.isFinite(year) ? year : fallbackYear,
    premiereMonth: Number.isFinite(month) ? month : fallbackMonth,
    season,
    summary: detail.summary,
    coverUrl: detail.coverUrl,
    externalIds: {
      mikan: candidate.id,
      ...(detail.bangumiId ? { bangumi: detail.bangumiId } : {})
    },
    detail: {
      episodeCount: detail.episodeCount,
      broadcast: detail.broadcast,
      genres: detail.genres,
      studios: detail.studios,
      staff: detail.staff,
      durationMinutes: detail.durationMinutes,
      metadataSources: ["mikan"],
      refreshedAt: new Date().toISOString()
    }
  };
}

function buildMikanAliases(candidate: MikanCandidate, detail: MikanDetail, title: string): AnimeAlias[] {
  const candidates: Array<{ alias?: string; fallbackLanguage: AnimeAlias["language"]; priority: number }> = [
    { alias: candidate.title, fallbackLanguage: "zh" as const, priority: 90 },
    { alias: detail.originalTitle, fallbackLanguage: "ja" as const, priority: 85 }
  ];

  return candidates
    .filter((item): item is { alias: string; fallbackLanguage: AnimeAlias["language"]; priority: number } =>
      Boolean(item.alias && item.alias !== title)
    )
    .map((item, index) => ({
      id: `mikan-${candidate.id}-alias-${index + 1}`,
      animeId: `mikan-${candidate.id}`,
      alias: item.alias,
      language: inferAnimeAliasLanguage(item.alias, item.fallbackLanguage),
      priority: item.priority
    }));
}

function parseMikanBroadcast(value: string | undefined): AnimeBroadcastSchedule | undefined {
  if (!value) return undefined;
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const weekdayText = value.match(/[周週星期]([日一二三四五六天])/u)?.[1];
  const weekday = weekdayText ? (weekdayText === "天" ? 0 : weekdays.indexOf(weekdayText)) : undefined;
  const time = value.match(/(?:[01]\d|2[0-3]):[0-5]\d/)?.[0];
  return (weekday !== undefined && weekday >= 0) || time
    ? { weekday, time, timezone: "Asia/Tokyo" }
    : undefined;
}

function buildMikanStaff(html: string): AnimeStaffCredit[] | undefined {
  const roles = ["导演", "原作", "系列构成", "脚本", "人物设定", "音乐"];
  const staff = roles.flatMap((role) =>
    splitMetadataValues(readLabeledValue(html, role))?.map((name) => ({ name, role, source: "mikan" })) ?? []
  );
  return staff.length ? staff : undefined;
}

function splitMetadataValues(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(/[、,，/|]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? [...new Set(items)] : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const number = Number(value?.match(/\d+/)?.[0]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function parseDurationMinutes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const hours = Number(value.match(/(\d+(?:\.\d+)?)\s*(?:小时|h)/i)?.[1] ?? 0);
  const minutes = Number(value.match(/(\d+)\s*(?:分钟|min)/i)?.[1] ?? 0);
  const total = Math.round(hours * 60 + minutes);
  return total > 0 ? total : parsePositiveInteger(value);
}

async function fetchText(url: string, httpClient: MetadataHttpClient): Promise<string> {
  const response = await httpClient.fetch(url, {
    source: "mikan",
    timeoutMs: MIKAN_FETCH_TIMEOUT_MS,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": DESKTOP_BROWSER_USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Mikan 请求失败: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function parsePremiereDate(html: string): string | undefined {
  const labelValue = readLabeledValue(html, "放送开始") ?? readLabeledValue(html, "开播") ?? readLabeledValue(html, "首播");
  return normalizeDate(labelValue) ?? normalizeDate(html);
}

function normalizeDate(value?: string): string | undefined {
  const yearFirstMatch = value?.match(/(20\d{2})[年./-]\s*(\d{1,2})(?:[月./-]\s*(\d{1,2}))?/);
  if (yearFirstMatch) {
    const [, year, month, day] = yearFirstMatch;
    return `${year}-${padDatePart(Number(month))}-${padDatePart(Number(day ?? 1))}`;
  }

  const monthFirstMatch = value?.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
  if (!monthFirstMatch) {
    return undefined;
  }

  const [, month, day, year] = monthFirstMatch;
  return `${year}-${padDatePart(Number(month))}-${padDatePart(Number(day ?? 1))}`;
}

function isSeasonStartMonth(month: number): boolean {
  return month === 1 || month === 4 || month === 7 || month === 10;
}

function readMetaContent(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match =
    html.match(new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i")) ??
    html.match(new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escaped}["'][^>]*>`, "i"));

  return normalizeText(match?.[1]);
}

function readTitleTag(html: string): string | undefined {
  return normalizeText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s*[-|].*$/g, ""));
}

function readTagText(html: string, tag: string): string | undefined {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return normalizeText(stripTags(match?.[1] ?? ""));
}

function readLabeledValue(html: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`${escaped}\\s*[：:]\\s*([^<\\n\\r]+)`, "i"));
  return normalizeText(match?.[1]);
}

function readImageSource(html: string): string | undefined {
  const match = html.match(/<img\b[^>]*src=["']([^"']+)["'][^>]*(?:Bangumi|bangumi|cover|Cover)[^>]*>/i);
  return decodeHtml(match?.[1] ?? "");
}

function readAttribute(attrs: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return normalizeText(attrs.match(new RegExp(`${escaped}=["']([^"']+)["']`, "i"))?.[1]);
}

function pickMikanTitle(values: Array<string | undefined>): string | undefined {
  return values.map(normalizeText).find((value) => Boolean(value && value.length > 1 && !isIgnoredMikanTitle(value)));
}

function isIgnoredMikanTitle(value: string): boolean {
  return /^(详情|订阅|更多|Mikan Project)$/i.test(value.trim());
}

function sanitizeMikanSummary(value: string | undefined): string | undefined {
  if (!value || /蜜柑计划|Mikan Project/i.test(value)) {
    return undefined;
  }

  return value;
}

function absolutizeOptionalUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return new URL(value, baseUrl).toString();
}

function stripTags(value: string | undefined): string {
  return (value ?? "").replace(/<[^>]+>/g, " ");
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = decodeHtml(stripTags(value)).replace(/\s+/g, " ").trim();
  return normalized || undefined;
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

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}
