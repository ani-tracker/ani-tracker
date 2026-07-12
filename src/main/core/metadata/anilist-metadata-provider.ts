import type { Anime, Season } from "@shared/domain";

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

const seasonByMonth: Record<number, { season: "WINTER" | "SPRING" | "SUMMER" | "FALL"; localSeason: Season }> = {
  1: { season: "WINTER", localSeason: "winter" },
  2: { season: "WINTER", localSeason: "winter" },
  3: { season: "WINTER", localSeason: "winter" },
  4: { season: "SPRING", localSeason: "spring" },
  5: { season: "SPRING", localSeason: "spring" },
  6: { season: "SPRING", localSeason: "spring" },
  7: { season: "SUMMER", localSeason: "summer" },
  8: { season: "SUMMER", localSeason: "summer" },
  9: { season: "SUMMER", localSeason: "summer" },
  10: { season: "FALL", localSeason: "fall" },
  11: { season: "FALL", localSeason: "fall" },
  12: { season: "FALL", localSeason: "fall" }
};

export class AniListMetadataProvider {
  async getAnimeByMonth(year: number, month: number): Promise<Anime[]> {
    const seasonInfo = seasonByMonth[month];
    if (!seasonInfo) {
      throw new Error(`Invalid month: ${month}`);
    }

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
          season: seasonInfo.season,
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
      .map((item) => mapAniListMedia(item, seasonInfo.localSeason));
  }
}

function mapAniListMedia(item: AniListMedia, season: Season): Anime {
  const title = item.title?.native ?? item.title?.romaji ?? item.title?.english ?? `AniList ${item.id}`;
  const aliases = [item.title?.romaji, item.title?.english]
    .filter((alias): alias is string => Boolean(alias && alias !== title))
    .map((alias, index) => ({
      id: `anilist-${item.id}-alias-${index + 1}`,
      animeId: `anilist-${item.id}`,
      alias,
      language: index === 0 ? ("romaji" as const) : ("en" as const),
      priority: 90 - index
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
