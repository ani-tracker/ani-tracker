import type {
  Anime,
  AnimeAiringStatus,
  AnimeAlias,
  AnimeFormat,
  AnimeRanking,
  Season
} from "@shared/domain";
import { inferAnimeAliasLanguage } from "../../../shared/anime-title";
import {
  getSeasonInfo,
  type AnimeDetailMetadataProvider,
  type MonthlyAnimeMetadataProvider
} from "./metadata-provider";
import { defaultMetadataHttpClient, type MetadataHttpTransport } from "./metadata-http-client";
import { logger } from "../logger";

const ANILIST_GRAPHQL_ENDPOINT = "https://graphql.anilist.co";

interface AniListResponse {
  data?: {
    Page?: {
      media?: AniListMedia[];
    };
    Media?: AniListMedia;
  };
  errors?: Array<{ message?: string }>;
}

interface AniListMedia {
  id: number;
  idMal?: number;
  averageScore?: number;
  bannerImage?: string;
  format?: string;
  episodes?: number;
  status?: string;
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
  endDate?: {
    year?: number;
    month?: number;
    day?: number;
  };
  nextAiringEpisode?: {
    airingAt?: number;
  };
  season?: string;
  description?: string;
  synonyms?: string[];
  coverImage?: {
    large?: string;
    extraLarge?: string;
  };
  genres?: string[];
  duration?: number;
  source?: string;
  isAdult?: boolean;
  studios?: {
    nodes?: Array<{ name?: string; isAnimationStudio?: boolean }>;
  };
  staff?: {
    edges?: Array<{
      role?: string;
      node?: { name?: { full?: string } };
    }>;
  };
  rankings?: Array<{
    rank?: number;
    type?: string;
    context?: string;
    allTime?: boolean;
  }>;
}

const anilistSeasonByLocalSeason: Record<Season, "WINTER" | "SPRING" | "SUMMER" | "FALL"> = {
  winter: "WINTER",
  spring: "SPRING",
  summer: "SUMMER",
  fall: "FALL"
};

export class AniListMetadataProvider implements MonthlyAnimeMetadataProvider, AnimeDetailMetadataProvider {
  readonly id = "anilist";

  constructor(private readonly httpClient: MetadataHttpTransport = defaultMetadataHttpClient) {}

  async getAnimeByMonth(year: number, month: number): Promise<Anime[]> {
    const seasonInfo = getSeasonInfo(month);

    const query = `
      query SeasonalAnime($season: MediaSeason!, $seasonYear: Int!, $page: Int!, $perPage: Int!) {
        Page(page: $page, perPage: $perPage) {
          media(type: ANIME, season: $season, seasonYear: $seasonYear, sort: POPULARITY_DESC) {
            id
            idMal
            averageScore
            bannerImage
            format
            episodes
            status
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
            endDate {
              year
              month
              day
            }
            nextAiringEpisode {
              airingAt
            }
            season
            description(asHtml: false)
            synonyms
            coverImage {
              large
              extraLarge
            }
            genres
            duration
            source
            isAdult
            studios(isMain: true) {
              nodes {
                name
                isAnimationStudio
              }
            }
            staff(perPage: 12, sort: RELEVANCE) {
              edges {
                role
                node {
                  name {
                    full
                  }
                }
              }
            }
            rankings {
              rank
              type
              context
              allTime
            }
          }
        }
      }
    `;

    const json = await this.request(query, {
      season: anilistSeasonByLocalSeason[seasonInfo.season],
      seasonYear: year,
      page: 1,
      perPage: 50
    });

    return (json.data?.Page?.media ?? [])
      .filter((item) => item.startDate?.year === year && item.startDate?.month === month)
      .map((item) => mapAniListMedia(item, seasonInfo.season));
  }

  /** 按 AniList external id 读取单部番剧的完整详情。 */
  async getAnimeDetail(externalId: string, fallback: Anime): Promise<Anime> {
    const id = Number(externalId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("AniList 标识无效");
    }

    const query = `
      query AnimeDetail($id: Int!) {
        Media(id: $id, type: ANIME) {
          id
          idMal
          averageScore
          bannerImage
          format
          episodes
          status
          title { native romaji english }
          startDate { year month day }
          endDate { year month day }
          nextAiringEpisode { airingAt }
          season
          description(asHtml: false)
          synonyms
          coverImage { large extraLarge }
          genres
          duration
          source
          isAdult
          studios(isMain: true) { nodes { name isAnimationStudio } }
          staff(perPage: 12, sort: RELEVANCE) {
            edges { role node { name { full } } }
          }
          rankings { rank type context allTime }
        }
      }
    `;
    const json = await this.request(query, { id });
    if (!json.data?.Media) {
      throw new Error("AniList 未返回番剧详情");
    }
    return mapAniListMedia(json.data.Media, fallback.season ?? getSeasonInfo(fallback.premiereMonth).season);
  }

  /** 执行 AniList GraphQL 请求并统一输出失败诊断。 */
  private async request(query: string, variables: Record<string, unknown>): Promise<AniListResponse> {
    const response = await this.httpClient.fetch(ANILIST_GRAPHQL_ENDPOINT, {
      source: this.id,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      logger.info("AniList error detail", {
        host: ANILIST_GRAPHQL_ENDPOINT,
        status: response.status,
        body: response.body
      });
      throw new Error(`AniList request failed: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as AniListResponse;
    if (json.errors?.length) {
      throw new Error(json.errors.map((error) => error.message).filter(Boolean).join("; "));
    }
    return json;
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
    coverUrl: item.coverImage?.extraLarge ?? item.coverImage?.large,
    rating: mapAniListRating(item),
    externalIds: {
      anilist: String(item.id),
      ...(item.idMal ? { mal: String(item.idMal) } : {})
    },
    detail: {
      bannerUrl: item.bannerImage,
      format: mapAniListFormat(item.format),
      episodeCount: normalizePositiveInteger(item.episodes),
      airingStatus: mapAniListStatus(item.status),
      endDate: formatAniListDate(item.endDate),
      nextAiringAt: mapNextAiringAt(item.nextAiringEpisode?.airingAt),
      genres: item.genres,
      studios: item.studios?.nodes?.flatMap((studio) => studio.name ? [studio.name] : []),
      staff: item.staff?.edges?.flatMap((credit) => {
        const name = credit.node?.name?.full?.trim();
        const role = credit.role?.trim();
        return name && role ? [{ name, role, source: "anilist" }] : [];
      }),
      sourceMaterial: item.source,
      durationMinutes: normalizePositiveInteger(item.duration),
      contentRating: item.isAdult ? "18+" : undefined,
      ranking: mapAniListRanking(item.rankings),
      metadataSources: ["anilist"],
      refreshedAt: new Date().toISOString()
    }
  };
}

function mapAniListFormat(value: string | undefined): AnimeFormat | undefined {
  const normalized = value?.toUpperCase();
  if (normalized === "TV" || normalized === "TV_SHORT") return "tv";
  if (normalized === "MOVIE") return "movie";
  if (normalized === "OVA") return "ova";
  if (normalized === "ONA") return "ona";
  if (normalized === "SPECIAL") return "special";
  if (normalized === "MUSIC") return "music";
  return value ? "unknown" : undefined;
}

function mapAniListStatus(value: string | undefined): AnimeAiringStatus | undefined {
  const normalized = value?.toUpperCase();
  if (normalized === "NOT_YET_RELEASED") return "upcoming";
  if (normalized === "RELEASING") return "airing";
  if (normalized === "FINISHED") return "finished";
  if (normalized === "HIATUS") return "hiatus";
  if (normalized === "CANCELLED") return "cancelled";
  return value ? "unknown" : undefined;
}

function formatAniListDate(value: AniListMedia["endDate"]): string | undefined {
  if (!value?.year || !value.month || !value.day) return undefined;
  return `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function mapNextAiringAt(value: number | undefined): string | undefined {
  if (!value || !Number.isSafeInteger(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now() ? date.toISOString() : undefined;
}

function mapAniListRanking(items: AniListMedia["rankings"]): AnimeRanking | undefined {
  const ranking = items?.find((item) => item.type === "RATED" && item.allTime)
    ?? items?.find((item) => item.type === "RATED");
  const rank = normalizePositiveInteger(ranking?.rank);
  return rank ? { rank, source: "anilist", category: ranking?.context || "评分排行" } : undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return value && Number.isSafeInteger(value) && value > 0 ? value : undefined;
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
