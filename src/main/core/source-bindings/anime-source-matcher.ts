import type { AnimeSourceCandidate } from "@shared/contracts";
import type { Anime } from "@shared/domain";
import { normalizeReleaseSearchText } from "../../../shared/anime-release-search";

const TITLE_WEIGHT = 0.7;
const SEASON_WEIGHT = 0.2;
const EPISODE_WEIGHT = 0.1;

/** 按标题、季度和集数计算来源番剧候选分数。 */
export function scoreAnimeSourceCandidate(
  anime: Anime,
  candidate: Omit<AnimeSourceCandidate, "score" | "reasons">,
  localEpisodeCount: number
): AnimeSourceCandidate {
  const titleSimilarity = getBestTitleSimilarity(anime, candidate);
  const seasonSimilarity = getSeasonSimilarity(anime, candidate);
  const episodeSimilarity = getEpisodeSimilarity(localEpisodeCount, candidate.episodeCount);
  const score = Math.round(
    (titleSimilarity * TITLE_WEIGHT + seasonSimilarity * SEASON_WEIGHT + episodeSimilarity * EPISODE_WEIGHT) * 100
  );
  const reasons = [
    `标题 ${Math.round(titleSimilarity * 100)}%`,
    ...(seasonSimilarity > 0 ? [`季度 ${Math.round(seasonSimilarity * 100)}%`] : []),
    ...(episodeSimilarity > 0 ? [`集数 ${Math.round(episodeSimilarity * 100)}%`] : [])
  ];

  return { ...candidate, score, reasons };
}

function getBestTitleSimilarity(
  anime: Anime,
  candidate: Pick<AnimeSourceCandidate, "title" | "originalTitle" | "aliases">
): number {
  const localTitles = [anime.title, anime.originalTitle, ...anime.aliases.map((item) => item.alias)].filter(
    (value): value is string => Boolean(value)
  );
  const sourceTitles = [candidate.title, candidate.originalTitle, ...candidate.aliases].filter(
    (value): value is string => Boolean(value)
  );

  return Math.max(
    0,
    ...localTitles.flatMap((localTitle) => sourceTitles.map((sourceTitle) => calculateTitleSimilarity(localTitle, sourceTitle)))
  );
}

/** 计算两个番剧标题的规范化相似度。 */
export function calculateTitleSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeTitle(left);
  const normalizedRight = normalizeTitle(right);
  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }
  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const shorterLength = Math.min(normalizedLeft.length, normalizedRight.length);
  const longerLength = Math.max(normalizedLeft.length, normalizedRight.length);
  if (
    shorterLength >= 4 &&
    (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  ) {
    return Math.max(0.75, shorterLength / longerLength);
  }

  return 1 - levenshteinDistance(normalizedLeft, normalizedRight) / longerLength;
}

function normalizeTitle(value: string): string {
  return normalizeReleaseSearchText(value).replace(/\s+/g, "");
}

function getSeasonSimilarity(
  anime: Anime,
  candidate: Pick<AnimeSourceCandidate, "premiereYear" | "premiereMonth">
): number {
  if (!candidate.premiereYear) {
    return 0;
  }

  const yearScore = candidate.premiereYear === anime.premiereYear ? 0.6 : 0;
  if (!candidate.premiereMonth) {
    return yearScore;
  }

  return yearScore + (getSeason(candidate.premiereMonth) === getSeason(anime.premiereMonth) ? 0.4 : 0);
}

function getEpisodeSimilarity(localEpisodeCount: number, sourceEpisodeCount?: number): number {
  if (localEpisodeCount <= 0 || !sourceEpisodeCount || sourceEpisodeCount <= 0) {
    return 0;
  }

  return Math.min(localEpisodeCount, sourceEpisodeCount) / Math.max(localEpisodeCount, sourceEpisodeCount);
}

function getSeason(month: number): number {
  return Math.floor((month - 1) / 3);
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}
