import type { Anime, AnimeAlias, Season } from "@shared/domain";
import { inferAnimeAliasLanguage } from "../../../shared/anime-title";
import {
  formatMonthStartDate,
  getSeasonInfo,
  isDateInMonth,
  type MonthlyAnimeMetadataProvider
} from "./metadata-provider";

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
}

export class MikanMetadataProvider implements MonthlyAnimeMetadataProvider {
  readonly id = "mikan";

  constructor(private readonly baseUrl = DEFAULT_MIKAN_BASE_URL) {}

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

  private async fetchSeasonHtml(year: number, season: string): Promise<string> {
    const endpoints = ["/Home/BangumiCoverFlowByDayOfWeek", "/Home/Classic"];
    const errors: string[] = [];

    for (const endpoint of endpoints) {
      const url = new URL(endpoint, this.baseUrl);
      url.searchParams.set("year", String(year));
      url.searchParams.set("seasonStr", season);

      try {
        const html = await fetchText(url.toString());
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
      return parseMikanDetailHtml(await fetchText(detailUrl), detailUrl);
    } catch {
      return {};
    }
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
  const summary = readMetaContent(html, "description") ?? readMetaContent(html, "og:description");
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
    bangumiId: html.match(/(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)/i)?.[1]
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

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MIKAN_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "AniTracker/0.1"
      }
    });

    if (!response.ok) {
      throw new Error(`Mikan 请求失败: ${response.status} ${response.statusText}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
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
  const match = value?.match(/(20\d{2})[年./-]\s*(\d{1,2})(?:[月./-]\s*(\d{1,2}))?/);
  if (!match) {
    return undefined;
  }

  const [, year, month, day] = match;
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
  return values.map(normalizeText).find((value) => Boolean(value && value.length > 1 && !/^(详情|订阅|更多)$/.test(value)));
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
