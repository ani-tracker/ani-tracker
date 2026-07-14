import type { Anime, AnimeAlias } from "@shared/domain";
import {
  formatMonthStartDate,
  getSeasonInfo,
  isDateInMonth,
  type MonthlyAnimeMetadataProvider
} from "./metadata-provider";
import { defaultMetadataHttpClient, type MetadataHttpClient } from "./metadata-http-client";

const BANGUMI_API_BASE_URL = "https://api.bgm.tv/";
const BANGUMI_ANIME_SUBJECT_TYPE = 2;

interface BangumiPagedSubject {
  data?: BangumiSubject[];
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
}

export class BangumiMetadataProvider implements MonthlyAnimeMetadataProvider {
  readonly id = "bangumi";

  constructor(
    private readonly baseUrl = BANGUMI_API_BASE_URL,
    private readonly httpClient: MetadataHttpClient = defaultMetadataHttpClient
  ) {}

  async getAnimeByMonth(year: number, month: number): Promise<Anime[]> {
    const seasonInfo = getSeasonInfo(month);
    const url = new URL("/v0/subjects", this.baseUrl);
    url.searchParams.set("type", String(BANGUMI_ANIME_SUBJECT_TYPE));
    url.searchParams.set("sort", "date");
    url.searchParams.set("year", String(year));
    url.searchParams.set("month", String(month));
    url.searchParams.set("limit", "50");
    url.searchParams.set("offset", "0");

    const response = await this.httpClient.fetch(url, {
      source: this.id,
      headers: {
        Accept: "application/json",
        "User-Agent": "AniTracker/0.1"
      }
    });

    if (!response.ok) {
      throw new Error(`Bangumi 请求失败: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as BangumiPagedSubject;
    return (json.data ?? [])
      .filter((item) => item.type === BANGUMI_ANIME_SUBJECT_TYPE)
      .filter((item) => !item.date || isDateInMonth(item.date, year, month))
      .map((item) => mapBangumiSubject(item, year, month, seasonInfo.season));
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
      bangumi: String(item.id)
    }
  };
}

function buildBangumiAliases(item: BangumiSubject, title: string): AnimeAlias[] {
  const candidates = [
    { alias: item.name, language: "ja" as const, priority: 95 },
    { alias: item.name_cn, language: "zh" as const, priority: 90 }
  ];

  return candidates
    .filter((candidate) => candidate.alias && candidate.alias !== title)
    .map((candidate, index) => ({
      id: `bangumi-${item.id}-alias-${index + 1}`,
      animeId: `bangumi-${item.id}`,
      alias: candidate.alias,
      language: candidate.language,
      priority: candidate.priority
    }));
}
