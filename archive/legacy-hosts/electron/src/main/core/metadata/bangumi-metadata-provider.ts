import type {
  Anime,
  AnimeAiringStatus,
  AnimeAlias,
  AnimeBroadcastSchedule,
  AnimeFormat,
  AnimeStaffCredit
} from "@shared/domain";
import { inferAnimeAliasLanguage } from "../../../shared/anime-title";
import {
  formatMonthStartDate,
  getSeasonInfo,
  isDateInMonth,
  type AnimeDetailMetadataProvider,
  type MonthlyAnimeMetadataProvider,
  type SearchableAnimeMetadataProvider
} from "./metadata-provider";
import { defaultMetadataHttpClient, type MetadataHttpTransport } from "./metadata-http-client";
import { logger } from "../logger";
import { BANGUMI_USER_AGENT } from "../http/user-agents";

const BANGUMI_API_BASE_URL = "https://api.bgm.tv/";
const BANGUMI_ANIME_SUBJECT_TYPE = 2;
const BANGUMI_PAGE_LIMIT = 50;
const BANGUMI_MAX_MONTHLY_ITEMS = 300;
const BANGUMI_DETAIL_CONCURRENCY = 6;
const BANGUMI_SEARCH_LIMIT = 30;

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
  rating?: {
    score?: number;
    total?: number;
  };
  platform?: string;
  total_episodes?: number;
  tags?: Array<{ name?: string; count?: number }>;
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

export class BangumiMetadataProvider implements
  MonthlyAnimeMetadataProvider,
  SearchableAnimeMetadataProvider,
  AnimeDetailMetadataProvider {
  readonly id = "bangumi";

  constructor(
    private readonly baseUrl = BANGUMI_API_BASE_URL,
    private readonly httpClient: MetadataHttpTransport = defaultMetadataHttpClient
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

  /** 使用 Bangumi 关键词接口搜索跨日期动画条目。 */
  async searchAnime(keyword: string): Promise<Anime[]> {
    const search = keyword.trim();
    if (!search) {
      return [];
    }
    const subjects = (await this.fetchSearchSubjects(search))
      .filter((item) => item.type === BANGUMI_ANIME_SUBJECT_TYPE);
    const detailedSubjects = await mapWithConcurrency(subjects, BANGUMI_DETAIL_CONCURRENCY, (item) =>
      this.fetchDetail(item)
    );

    return detailedSubjects.map((item) => {
      const { year, month } = resolveBangumiSearchDate(item.date);
      return mapBangumiSubject(item, year, month, getSeasonInfo(month).season);
    });
  }

  /** 按 Bangumi external id 读取单部番剧详情。 */
  async getAnimeDetail(externalId: string, fallback: Anime): Promise<Anime> {
    const id = Number(externalId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("Bangumi 标识无效");
    }
    const subject = await this.fetchDetailById(id);
    return mapBangumiSubject(
      subject,
      fallback.premiereYear,
      fallback.premiereMonth,
      fallback.season ?? getSeasonInfo(fallback.premiereMonth).season
    );
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

  /** 请求 Bangumi 关键词搜索第一页，详情补全由调用方并发控制。 */
  private async fetchSearchSubjects(keyword: string): Promise<BangumiSubject[]> {
    const url = new URL("/v0/search/subjects", this.baseUrl);
    url.searchParams.set("limit", String(BANGUMI_SEARCH_LIMIT));
    url.searchParams.set("offset", "0");
    const response = await this.httpClient.fetch(url, {
      source: this.id,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": BANGUMI_USER_AGENT
      },
      body: JSON.stringify({
        keyword,
        sort: "match",
        filter: { type: [BANGUMI_ANIME_SUBJECT_TYPE] }
      })
    });
    if (!response.ok) {
      throw new Error(`Bangumi 搜索请求失败: ${response.status} ${response.statusText}`);
    }
    return ((await response.json()) as BangumiPagedSubject).data ?? [];
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
    try {
      return {
        ...item,
        ...(await this.fetchDetailById(item.id))
      };
    } catch {
      // Detail enrichment is best-effort; the list record is still useful as a Chinese metadata source.
      return item;
    }
  }

  /** 请求 Bangumi 单条详情，供月度补全和主动刷新共用。 */
  private async fetchDetailById(id: number): Promise<BangumiSubject> {
    const url = new URL(`/v0/subjects/${id}`, this.baseUrl);
    const response = await this.httpClient.fetch(url, {
      source: this.id,
      headers: {
        Accept: "application/json",
        "User-Agent": BANGUMI_USER_AGENT
      }
    });
    if (!response.ok) {
      throw new Error(`Bangumi 详情请求失败: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as BangumiSubject;
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
    rating: mapBangumiRating(item),
    externalIds: {
      bangumi: String(item.id),
      ...buildBangumiExternalIds(item)
    },
    detail: buildBangumiDetail(item, date)
  };
}

/** 读取搜索条目日期，缺失时使用当前年月作为安全回退。 */
function resolveBangumiSearchDate(value: string | undefined): { year: number; month: number } {
  const [parsedYear, parsedMonth] = (value ?? "").split("-").map(Number);
  const now = new Date();
  return {
    year: Number.isSafeInteger(parsedYear) && parsedYear > 0 ? parsedYear : now.getFullYear(),
    month: Number.isSafeInteger(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12
      ? parsedMonth
      : now.getMonth() + 1
  };
}

/** 从 Bangumi 结构化字段和 infobox 中提取详情元数据。 */
function buildBangumiDetail(item: BangumiSubject, premiereDate: string): Anime["detail"] {
  const endDate = readFirstInfoboxValue(item.infobox, ["放送终了", "播放结束", "上映年度"]);
  const normalizedEndDate = normalizeBangumiDate(endDate);
  const episodeCount = normalizePositiveInteger(item.total_episodes)
    ?? parseFirstPositiveInteger(readFirstInfoboxValue(item.infobox, ["话数", "集数"]));
  const format = mapBangumiFormat(item.platform ?? readFirstInfoboxValue(item.infobox, ["平台", "类型"]));
  const studios = readInfoboxValuesByKeys(item.infobox, ["动画制作", "制作", "製作"]);
  const staff = buildBangumiStaff(item.infobox);
  const durationMinutes = parseDurationMinutes(
    readFirstInfoboxValue(item.infobox, ["片长", "单集片长", "时长"])
  );

  return {
    format,
    episodeCount,
    airingStatus: inferBangumiAiringStatus(premiereDate, normalizedEndDate),
    endDate: normalizedEndDate,
    broadcast: buildBangumiBroadcast(item.infobox),
    genres: item.tags
      ?.filter((tag) => Boolean(tag.name))
      .sort((left, right) => (right.count ?? 0) - (left.count ?? 0))
      .slice(0, 8)
      .map((tag) => tag.name!),
    studios,
    staff,
    sourceMaterial: readFirstInfoboxValue(item.infobox, ["原作", "原案"]),
    durationMinutes,
    contentRating: readFirstInfoboxValue(item.infobox, ["分级", "等级"]),
    metadataSources: ["bangumi"],
    refreshedAt: new Date().toISOString()
  };
}

function mapBangumiFormat(value: string | undefined): AnimeFormat | undefined {
  const normalized = value?.toLocaleLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("tv") || normalized.includes("电视")) return "tv";
  if (normalized.includes("剧场") || normalized.includes("电影") || normalized.includes("movie")) return "movie";
  if (normalized.includes("ova")) return "ova";
  if (normalized.includes("web") || normalized.includes("ona") || normalized.includes("网络")) return "ona";
  if (normalized.includes("music") || normalized.includes("音乐")) return "music";
  if (normalized.includes("special") || normalized.includes("特别")) return "special";
  return "unknown";
}

function inferBangumiAiringStatus(
  premiereDate: string | undefined,
  endDate: string | undefined
): AnimeAiringStatus | undefined {
  const now = Date.now();
  if (premiereDate && Date.parse(`${premiereDate}T00:00:00Z`) > now) return "upcoming";
  if (endDate && Date.parse(`${endDate}T23:59:59Z`) < now) return "finished";
  if (premiereDate && Date.parse(`${premiereDate}T00:00:00Z`) <= now) return "airing";
  return undefined;
}

function buildBangumiBroadcast(infobox: BangumiInfoboxItem[] | undefined): AnimeBroadcastSchedule | undefined {
  const value = readFirstInfoboxValue(infobox, ["放送星期", "播放星期", "放送时间"]);
  if (!value) return undefined;
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const weekdayText = value.match(/[周週星期]([日一二三四五六天])/u)?.[1];
  const weekday = weekdayText ? (weekdayText === "天" ? 0 : weekdays.indexOf(weekdayText)) : undefined;
  const time = value.match(/(?:[01]\d|2[0-3]):[0-5]\d/)?.[0];
  return (weekday !== undefined && weekday >= 0) || time
    ? { weekday, time, timezone: "Asia/Tokyo" }
    : undefined;
}

function buildBangumiStaff(infobox: BangumiInfoboxItem[] | undefined): AnimeStaffCredit[] | undefined {
  const roles = ["导演", "原作", "系列构成", "脚本", "人物设定", "音乐", "总作画监督"];
  const credits = roles.flatMap((role) =>
    readInfoboxValues(infobox, role).map((name) => ({ name, role, source: "bangumi" }))
  );
  return credits.length ? credits : undefined;
}

function readInfoboxValuesByKeys(infobox: BangumiInfoboxItem[] | undefined, keys: string[]): string[] | undefined {
  const values = keys.flatMap((key) => readInfoboxValues(infobox, key));
  return values.length ? [...new Set(values)] : undefined;
}

function readFirstInfoboxValue(infobox: BangumiInfoboxItem[] | undefined, keys: string[]): string | undefined {
  return keys.flatMap((key) => readInfoboxValues(infobox, key))[0];
}

function normalizeBangumiDate(value: string | undefined): string | undefined {
  const match = value?.match(/(20\d{2})[年./-]\s*(\d{1,2})[月./-]\s*(\d{1,2})/);
  if (!match) return undefined;
  return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
}

function parseFirstPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value?.match(/\d+/)?.[0]);
  return normalizePositiveInteger(parsed);
}

function parseDurationMinutes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const hours = Number(value.match(/(\d+(?:\.\d+)?)\s*(?:小时|h)/i)?.[1] ?? 0);
  const minutes = Number(value.match(/(\d+)\s*(?:分钟|min)/i)?.[1] ?? 0);
  const total = Math.round(hours * 60 + minutes);
  return normalizePositiveInteger(total || Number(value.match(/\d+/)?.[0]));
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return value && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 将 Bangumi 评分映射为统一的 10 分制评分。 */
function mapBangumiRating(item: BangumiSubject): Anime["rating"] {
  const score = item.rating?.score;
  if (!score || !Number.isFinite(score) || score <= 0) {
    return undefined;
  }

  return {
    score: normalizeRatingScore(score),
    count: normalizeRatingCount(item.rating?.total),
    source: "bangumi"
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

function normalizeRatingScore(value: number): number {
  return Math.round(Math.max(0, Math.min(10, value)) * 10) / 10;
}

function normalizeRatingCount(value: number | undefined): number | undefined {
  return value && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
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
