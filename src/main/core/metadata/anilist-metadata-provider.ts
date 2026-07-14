import type { Anime, AnimeAlias, Season } from "@shared/domain";
import { inferAnimeAliasLanguage } from "../../../shared/anime-title";
import { getSeasonInfo, type MonthlyAnimeMetadataProvider } from "./metadata-provider";
import { defaultMetadataHttpClient, type MetadataHttpClient } from "./metadata-http-client";

const ANILIST_GRAPHQL_ENDPOINT = "https://graphql.anilist.co";

interface AniListResponse {
  data?: {
    Page?: {
      media?: AniListMedia[];
    };
  };
  errors?: Array<{ message?: string }>;
}

interface AniListMedia {
  id: number;
  idMal?: number;
  averageScore?: number;
  title?: {
    native?: string;
    romaji?: string;
    english?: string;
  };
  startDate?: {
    year?: number;
    month?: number;
    day?: number;
  };
  season?: string;
  description?: string;
  synonyms?: string[];
  coverImage?: {
    large?: string;
  };
}

const anilistSeasonByLocalSeason: Record<Season, "WINTER" | "SPRING" | "SUMMER" | "FALL"> = {
  winter: "WINTER",
  spring: "SPRING",
  summer: "SUMMER",
  fall: "FALL"
};

export class AniListMetadataProvider implements MonthlyAnimeMetadataProvider {
  readonly id = "anilist";

  constructor(private readonly httpClient: MetadataHttpClient = defaultMetadataHttpClient) {}

  async getAnimeByMonth(year: number, month: number): Promise<Anime[]> {
    const seasonInfo = getSeasonInfo(month);

    const query = `
      query SeasonalAnime($season: MediaSeason!, $seasonYear: Int!, $page: Int!, $perPage: Int!) {
        Page(page: $page, perPage: $perPage) {
          media(type: ANIME, season: $season, seasonYear: $seasonYear, sort: POPULARITY_DESC) {
            id
            idMal
            averageScore
            title {
              native
              romaji
              english
            }
            startDate {
              year
              month
              day
            }
            season
            description(asHtml: false)
            synonyms
            coverImage {
              large
            }
          }
        }
      }
    `;

    const response = await this.httpClient.fetch(ANILIST_GRAPHQL_ENDPOINT, {
      source: this.id,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        query,
        variables: {
          season: anilistSeasonByLocalSeason[seasonInfo.season],
          seasonYear: year,
          page: 1,
          perPage: 50
        }
      })
    });

    if (!response.ok) {
      throw new Error(`AniList request failed: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as AniListResponse;
    if (json.errors?.length) {
      throw new Error(json.errors.map((error) => error.message).filter(Boolean).join("; "));
    }

    return (json.data?.Page?.media ?? [])
      .filter((item) => item.startDate?.year === year && item.startDate?.month === month)
      .map((item) => mapAniListMedia(item, seasonInfo.season));
  }
}

function mapAniListMedia(item: AniListMedia, season: Season): Anime {
  const title = item.title?.native ?? item.title?.romaji ?? item.title?.english ?? `AniList ${item.id}`;
  const aliases = buildAniListAliases(item, title);
  const year = item.startDate?.year ?? new Date().getFullYear();
  const month = item.startDate?.month ?? 1;
  const day = item.startDate?.day ?? 1;

  return {
    id: `anilist-${item.id}`,
    title,
    originalTitle: item.title?.native,
    aliases,
    premiereDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    premiereYear: year,
    premiereMonth: month,
    season,
    summary: item.description,
    coverUrl: item.coverImage?.large,
    rating: mapAniListRating(item),
    externalIds: {
      anilist: String(item.id),
      ...(item.idMal ? { mal: String(item.idMal) } : {})
    }
  };
}

/** 将 AniList 百分制平均分映射为统一的 10 分制评分。 */
function mapAniListRating(item: AniListMedia): Anime["rating"] {
  const averageScore = item.averageScore;
  if (!averageScore || !Number.isFinite(averageScore) || averageScore <= 0) {
    return undefined;
  }

  return {
    score: Math.round(Math.max(0, Math.min(100, averageScore)) / 10 * 10) / 10,
    source: "anilist"
  };
}

function buildAniListAliases(item: AniListMedia, title: string): AnimeAlias[] {
  const candidates = [
    { alias: item.title?.romaji, language: "romaji" as const, priority: 90 },
    { alias: item.title?.english, language: "en" as const, priority: 80 },
    ...(item.synonyms ?? []).map((alias) => ({
      alias,
      language: inferAnimeAliasLanguage(alias, "custom"),
      priority: 70
    }))
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
      id: `anilist-${item.id}-alias-${aliases.length + 1}`,
      animeId: `anilist-${item.id}`,
      alias,
      language: candidate.language,
      priority: candidate.priority
    });
  }

  return aliases;
}

function normalizeAlias(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
