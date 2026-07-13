import type { Anime, Season } from "@shared/domain";
import { getSeasonInfo, type MonthlyAnimeMetadataProvider } from "./metadata-provider";

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

  async getAnimeByMonth(year: number, month: number): Promise<Anime[]> {
    const seasonInfo = getSeasonInfo(month);

    const query = `
      query SeasonalAnime($season: MediaSeason!, $seasonYear: Int!, $page: Int!, $perPage: Int!) {
        Page(page: $page, perPage: $perPage) {
          media(type: ANIME, season: $season, seasonYear: $seasonYear, sort: POPULARITY_DESC) {
            id
            idMal
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
            coverImage {
              large
            }
          }
        }
      }
    `;

    const response = await fetch(ANILIST_GRAPHQL_ENDPOINT, {
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
  const aliases = [
    { alias: item.title?.romaji, language: "romaji" as const, priority: 90 },
    { alias: item.title?.english, language: "en" as const, priority: 80 }
  ]
    .filter((candidate): candidate is { alias: string; language: "romaji" | "en"; priority: number } =>
      Boolean(candidate.alias && candidate.alias !== title)
    )
    .map((alias, index) => ({
      id: `anilist-${item.id}-alias-${index + 1}`,
      animeId: `anilist-${item.id}`,
      alias: alias.alias,
      language: alias.language,
      priority: alias.priority
    }));
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
    externalIds: {
      anilist: String(item.id),
      ...(item.idMal ? { mal: String(item.idMal) } : {})
    }
  };
}
