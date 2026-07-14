import type { Anime, AnimeAlias } from "@shared/domain";
import { inferAnimeAliasLanguage } from "../../../shared/anime-title";
import {
  formatMonthStartDate,
  getSeasonInfo,
  isDateInMonth,
  type MonthlyAnimeMetadataProvider
} from "./metadata-provider";
import { defaultMetadataHttpClient, type MetadataHttpClient } from "./metadata-http-client";
import { logger } from "../logger";
import { BANGUMI_USER_AGENT } from "../http/user-agents";

const BANGUMI_API_BASE_URL = "https://api.bgm.tv/";
const BANGUMI_ANIME_SUBJECT_TYPE = 2;
const BANGUMI_PAGE_LIMIT = 50;
const BANGUMI_MAX_MONTHLY_ITEMS = 300;
const BANGUMI_DETAIL_CONCURRENCY = 6;

interface BangumiPagedSubject {
  data?: BangumiSubject[];
  total?: number;
  limit?: number;
  offset?: number;
}

interface BangumiSubject {
  id: number;
  type: number;
  name: string;
  name_cn: string;
  summary?: string;
  date?: string;
  images?: {
    large?: string;
    common?: string;
    medium?: string;
    small?: string;
    grid?: string;
  };
  infobox?: BangumiInfoboxItem[];
}

interface BangumiInfoboxItem {
  key?: string;
  value?: unknown;
}

interface BangumiAliasCandidate {
  alias?: string;
  language: AnimeAlias["language"];
  priority: number;
}

export class BangumiMetadataProvider implements MonthlyAnimeMetadataProvider {
  readonly id = "bangumi";

  constructor(
    private readonly baseUrl = BANGUMI_API_BASE_URL,
    private readonly httpClient: MetadataHttpClient = defaultMetadataHttpClient
  ) {}

  async getAnimeByMonth(year: number, month: number): Promise<Anime[]> {
    const seasonInfo = getSeasonInfo(month);
    const subjects = (await this.fetchMonthlySubjects(year, month))
      .filter((item) => item.type === BANGUMI_ANIME_SUBJECT_TYPE)
      .filter((item) => !item.date || isDateInMonth(item.date, year, month));
    // The monthly list lacks aliases and external links; detail pages provide the bridge fields used for cross-source merge.
    const detailedSubjects = await mapWithConcurrency(subjects, BANGUMI_DETAIL_CONCURRENCY, (item) =>
      this.fetchDetail(item)
    );

    return detailedSubjects.map((item) => mapBangumiSubject(item, year, month, seasonInfo.season));
  }

  /** Fetches every Bangumi monthly page so second-page shows still get detail aliases for cross-source merge. */
  private async fetchMonthlySubjects(year: number, month: number): Promise<BangumiSubject[]> {
    const subjects: BangumiSubject[] = [];
    let offset = 0;
    let pageCount = 0;
    let reportedTotal: number | undefined;

    while (offset < BANGUMI_MAX_MONTHLY_ITEMS) {
      const page = await this.fetchSubjectPage(year, month, offset);
      const pageItems = page.data ?? [];
      const pageOffset = normalizePageNumber(page.offset, offset);
      const pageLimit = normalizePageNumber(page.limit, BANGUMI_PAGE_LIMIT);
      const total = normalizeOptionalPageNumber(page.total);

      pageCount += 1;
      reportedTotal = total ?? reportedTotal;
      subjects.push(...pageItems);

      if (!pageItems.length || pageOffset + pageItems.length >= (total ?? Number.POSITIVE_INFINITY)) {
        break;
      }

      const nextOffset = pageOffset + pageLimit;
      if (nextOffset <= offset) {
        break;
      }

      offset = nextOffset;
    }

    if (reportedTotal && offset < reportedTotal && offset >= BANGUMI_MAX_MONTHLY_ITEMS) {
      logger.warn("Bangumi 月度分页达到上限", {
        year,
        month,
        fetchedCount: subjects.length,
        total: reportedTotal,
        maxItems: BANGUMI_MAX_MONTHLY_ITEMS
      });
    }

    logger.info("Bangumi 月度分页采集完成", {
      year,
      month,
      pages: pageCount,
      count: subjects.length,
      total: reportedTotal
    });

    return subjects;
  }

  /** Reads one Bangumi monthly page; pagination control stays in fetchMonthlySubjects. */
  private async fetchSubjectPage(year: number, month: number, offset: number): Promise<BangumiPagedSubject> {
    const url = new URL("/v0/subjects", this.baseUrl);
    url.searchParams.set("type", String(BANGUMI_ANIME_SUBJECT_TYPE));
    url.searchParams.set("sort", "date");
    url.searchParams.set("year", String(year));
    url.searchParams.set("month", String(month));
    url.searchParams.set("limit", String(BANGUMI_PAGE_LIMIT));
    url.searchParams.set("offset", String(offset));

    const response = await this.httpClient.fetch(url, {
      source: this.id,
      headers: {
        Accept: "application/json",
        "User-Agent": BANGUMI_USER_AGENT
      }
    });

    if (!response.ok) {
      throw new Error(`Bangumi 请求失败: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as BangumiPagedSubject;
  }

  private async fetchDetail(item: BangumiSubject): Promise<BangumiSubject> {
    const url = new URL(`/v0/subjects/${item.id}`, this.baseUrl);

    try {
      const response = await this.httpClient.fetch(url, {
        source: this.id,
        headers: {
          Accept: "application/json",
          "User-Agent": BANGUMI_USER_AGENT
        }
      });

      if (!response.ok) {
        return item;
      }

      return {
        ...item,
        ...((await response.json()) as BangumiSubject)
      };
    } catch {
      // Detail enrichment is best-effort; the list record is still useful as a Chinese metadata source.
      return item;
    }
  }
}

function mapBangumiSubject(
  item: BangumiSubject,
  fallbackYear: number,
  fallbackMonth: number,
  season: Anime["season"]
): Anime {
  const title = item.name_cn || item.name || `Bangumi ${item.id}`;
  const originalTitle = item.name || undefined;
  const aliases = buildBangumiAliases(item, title);
  const date = item.date || formatMonthStartDate(fallbackYear, fallbackMonth);
  const [year, month] = date.split("-").map(Number);

  return {
    id: `bangumi-${item.id}`,
    title,
    originalTitle,
    aliases,
    premiereDate: date,
    premiereYear: Number.isFinite(year) ? year : fallbackYear,
    premiereMonth: Number.isFinite(month) ? month : fallbackMonth,
    season,
    summary: item.summary,
    coverUrl: item.images?.large ?? item.images?.common ?? item.images?.medium ?? item.images?.grid,
    externalIds: {
      bangumi: String(item.id),
      ...buildBangumiExternalIds(item)
    }
  };
}

function buildBangumiAliases(item: BangumiSubject, title: string): AnimeAlias[] {
  const candidates: BangumiAliasCandidate[] = [
    { alias: item.name, language: "ja" as const, priority: 95 },
    { alias: item.name_cn, language: "zh" as const, priority: 90 },
    ...readInfoboxValues(item.infobox, "中文名").map((alias) => ({
      alias,
      language: "zh" as const,
      priority: 88
    })),
    ...readInfoboxAliasValues(item.infobox)
  ];
  const seen = new Set([normalizeAlias(title)]);
  const aliases: AnimeAlias[] = [];

  for (const candidate of candidates) {
    const alias = candidate.alias?.trim();
    const normalized = normalizeAlias(alias);
    if (!alias || !normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    aliases.push({
      id: `bangumi-${item.id}-alias-${aliases.length + 1}`,
      animeId: `bangumi-${item.id}`,
      alias,
      language: candidate.language,
      priority: candidate.priority
    });
  }

  return aliases;
}

function readInfoboxAliasValues(infobox: BangumiInfoboxItem[] | undefined): BangumiAliasCandidate[] {
  return readInfoboxValues(infobox, "别名").map((alias) => ({
    alias,
    language: inferAnimeAliasLanguage(alias, isEnglishAliasLabel(alias) ? "en" : "custom"),
    priority: isEnglishAliasLabel(alias) ? 78 : 82
  }));
}

function readInfoboxValues(infobox: BangumiInfoboxItem[] | undefined, key: string): string[] {
  const item = infobox?.find((entry) => entry.key === key);
  if (!item) {
    return [];
  }

  return collectInfoboxStrings(item.value);
}

function collectInfoboxStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value.trim()].filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectInfoboxStrings);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record.v, record.value].flatMap(collectInfoboxStrings);
  }

  return [];
}

function buildBangumiExternalIds(item: BangumiSubject): Record<string, string> {
  const externalIds: Record<string, string> = {};
  // Bangumi infobox links can contain MAL/AniList ids; these are the strongest bridge to AniList records.
  for (const value of collectInfoboxStrings(item.infobox)) {
    const anilist = value.match(/anilist\.co\/anime\/(\d+)/i)?.[1];
    const mal = value.match(/myanimelist\.net\/anime\/(\d+)/i)?.[1];

    if (anilist) {
      externalIds.anilist = anilist;
    }
    if (mal) {
      externalIds.mal = mal;
    }
  }

  return externalIds;
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

function isEnglishAliasLabel(value: string | undefined): boolean {
  return Boolean(value && /^[\x00-\x7f]+$/.test(value));
}

function normalizeAlias(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizePageNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? value! : fallback;
}

function normalizeOptionalPageNumber(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value! >= 0 ? value : undefined;
}
