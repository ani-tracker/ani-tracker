import type { FansubGroup, MyAnime, Release } from "@shared/domain";
import {
  buildAnimeReleaseSearchTerms,
  classifyAnimeRelease,
  matchesAnimeReleaseTitle
} from "../../../shared/anime-release-search";
import { getSubtitleCoverage, resolveSubtitleLanguages } from "../../../shared/release-metadata";
import { matchesCandidateFansub } from "../../../shared/fansub-name-matcher";
import { enrichReleaseFromTitle } from "./release-title-parser";

export const AUTOMATIC_DOWNLOAD_MIN_SCORE = 75;
export const AUTOMATIC_DOWNLOAD_MIN_MATCH_SCORE = 40;
export const AUTOMATIC_DOWNLOAD_MIN_LEAD = 5;

export interface ReleaseMatchContext {
  anime: MyAnime;
  episodeNo?: number;
  episodeFansubOverrideId?: string;
  candidateFansubGroupIds?: string[];
  candidateFansubNames?: string[];
}

export interface ReleaseMatchResult {
  release: Release;
  score: number;
  matchScore: number;
  preferenceScore: number;
  availabilityScore: number;
  reasons: string[];
  warnings: string[];
}

export interface AutomaticDownloadDecision {
  accepted: boolean;
  reason: string;
}

export function rankReleases(
  releases: Release[],
  context: ReleaseMatchContext,
  groups: FansubGroup[] = []
): ReleaseMatchResult[] {
  return releases
    .map((release) => scoreRelease(enrichReleaseFromTitle(release, groups), context, groups))
    .filter((result) => result.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      if ((a.release.seeders ?? -1) !== (b.release.seeders ?? -1)) {
        return (b.release.seeders ?? -1) - (a.release.seeders ?? -1);
      }
      return b.release.publishedAt.localeCompare(a.release.publishedAt);
    });
}

/** 按追番规则排列展示资源，保留低分资源且不改变自动下载判定。 */
export function sortReleasesByRules(
  releases: Release[],
  resolveContext: (release: Release) => ReleaseMatchContext,
  groups: FansubGroup[] = []
): Release[] {
  return releases
    .map((release, index) => {
      const enrichedRelease = enrichReleaseFromTitle(release, groups);
      return {
        index,
        result: scoreRelease(enrichedRelease, resolveContext(enrichedRelease), groups)
      };
    })
    .sort((left, right) => {
      if (left.result.preferenceScore !== right.result.preferenceScore) {
        return right.result.preferenceScore - left.result.preferenceScore;
      }
      if (left.result.matchScore !== right.result.matchScore) {
        return right.result.matchScore - left.result.matchScore;
      }
      if ((left.result.release.seeders ?? -1) !== (right.result.release.seeders ?? -1)) {
        return (right.result.release.seeders ?? -1) - (left.result.release.seeders ?? -1);
      }
      const publishedAtDelta = right.result.release.publishedAt.localeCompare(left.result.release.publishedAt);
      return publishedAtDelta || left.index - right.index;
    })
    .map(({ result }) => result.release);
}

export function scoreRelease(
  release: Release,
  context: ReleaseMatchContext,
  groups: FansubGroup[] = []
): ReleaseMatchResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let matchScore = 0;
  let preferenceScore = 0;
  let availabilityScore = 0;

  if (classifyAnimeRelease(release, context.anime.anime) !== "current") {
    return createResult(release, 0, 0, 0, ["资源季度不兼容"], warnings);
  }

  if (!matchesReleaseAnime(release, context.anime)) {
    return createResult(release, 0, 0, 0, ["资源番剧不匹配"], warnings);
  }

  const episodeMatched = context.episodeNo === undefined ||
    release.episodeNo === context.episodeNo ||
    isEpisodeInRange(context.episodeNo, release.episodeRange);
  if (!episodeMatched) {
    return createResult(release, 0, 0, 0, ["资源未覆盖目标集数"], warnings);
  }

  matchScore += 20;
  reasons.push(release.animeId ? "资源已关联目标番剧" : "标题匹配番剧别名");
  if (release.animeId === context.anime.anime.id) {
    matchScore += 5;
  }

  if (context.episodeNo && release.episodeNo === context.episodeNo) {
    matchScore += 25;
    reasons.push("集数精确匹配");
  } else if (context.episodeNo && isEpisodeInRange(context.episodeNo, release.episodeRange)) {
    matchScore += 15;
    reasons.push("集数范围覆盖");
  } else if (context.episodeNo === undefined) {
    matchScore += 25;
  }

  const preferredFansubId = context.episodeFansubOverrideId ?? context.anime.defaultFansubGroupId;
  if (!preferredFansubId) {
    preferenceScore += 14;
  } else if (release.fansubGroupId === preferredFansubId) {
    preferenceScore += 14;
    reasons.push(context.episodeFansubOverrideId ? "匹配单集字幕组覆盖" : "匹配默认字幕组");
  } else if (
    Boolean(release.fansubGroupId && context.candidateFansubGroupIds?.includes(release.fansubGroupId)) ||
    matchesCandidateFansub(release, context.candidateFansubNames ?? [], groups)
  ) {
    preferenceScore += 5;
    reasons.push("匹配候补字幕组");
  }

  if (!context.anime.preferredResolution) {
    preferenceScore += 5;
  } else if (release.resolution === context.anime.preferredResolution) {
    preferenceScore += 5;
    reasons.push("匹配清晰度偏好");
  }

  if (!context.anime.preferredCodec) {
    preferenceScore += 5;
  } else if (release.normalizedVideoCodec === context.anime.preferredCodec) {
    preferenceScore += 5;
    reasons.push("匹配编码偏好");
  } else if (!release.normalizedVideoCodec) {
    warnings.push("编码未知");
  }

  if (!context.anime.preferredBitDepth) {
    preferenceScore += 6;
  } else if (release.bitDepth === context.anime.preferredBitDepth) {
    preferenceScore += 6;
    reasons.push("匹配位深偏好");
  } else if (!release.bitDepth) {
    warnings.push("位深未知");
  }

  const preferredSubtitleLanguages = resolveSubtitleLanguages(
    context.anime.preferredSubtitleLanguages,
    context.anime.preferredSubtitle
  );
  const subtitleCoverage = getSubtitleCoverage(release, preferredSubtitleLanguages);
  if (release.subtitle === "multi" && !release.subtitleLanguages?.length) {
    warnings.push("多语字幕组成未知");
  }
  preferenceScore += Math.round(subtitleCoverage * 10);
  if (preferredSubtitleLanguages.length > 0 && subtitleCoverage > 0) {
    reasons.push(subtitleCoverage === 1 ? "完整覆盖字幕语言偏好" : "部分覆盖字幕语言偏好");
  } else if (preferredSubtitleLanguages.length > 0 && subtitleCoverage === 0) {
    warnings.push("字幕语言未命中");
  }

  if (release.magnetUrl || release.torrentUrl) {
    availabilityScore += 2;
  }
  if (release.seeders === undefined) {
    availabilityScore += 2;
  } else if (release.seeders > 0) {
    availabilityScore += Math.min(6, Math.ceil(Math.log2(release.seeders + 1)));
    reasons.push("存在做种");
  }

  const metadataCount = [
    Boolean(release.normalizedVideoCodec),
    Boolean(release.bitDepth),
    Boolean(release.subtitleLanguages?.length || release.subtitle)
  ].filter(Boolean).length;
  availabilityScore += metadataCount === 3 ? 2 : metadataCount >= 1 ? 1 : 0;

  return createResult(release, matchScore, preferenceScore, availabilityScore, reasons, warnings);
}

/** 判断最高分候选是否足够可信，防止低分或近似并列时误下载。 */
export function evaluateAutomaticDownload(results: ReleaseMatchResult[]): AutomaticDownloadDecision {
  const best = results[0];
  if (!best) {
    return { accepted: false, reason: "未找到匹配资源" };
  }
  if (best.matchScore < AUTOMATIC_DOWNLOAD_MIN_MATCH_SCORE) {
    return { accepted: false, reason: `资源匹配可信度不足（${best.matchScore}/50）` };
  }
  if (best.score < AUTOMATIC_DOWNLOAD_MIN_SCORE) {
    return { accepted: false, reason: `资源综合评分不足（${best.score}/100）` };
  }

  const second = results[1];
  if (second && best.score - second.score < AUTOMATIC_DOWNLOAD_MIN_LEAD) {
    return { accepted: false, reason: `最高候选领先不足 ${AUTOMATIC_DOWNLOAD_MIN_LEAD} 分` };
  }
  return { accepted: true, reason: `资源可信度通过（${best.score}/100）` };
}

/** 汇总各评分维度，保证结果限制在 0-100。 */
function createResult(
  release: Release,
  matchScore: number,
  preferenceScore: number,
  availabilityScore: number,
  reasons: string[],
  warnings: string[]
): ReleaseMatchResult {
  return {
    release,
    score: Math.min(100, matchScore + preferenceScore + availabilityScore),
    matchScore,
    preferenceScore,
    availabilityScore,
    reasons,
    warnings
  };
}

function isEpisodeInRange(episodeNo: number, range: Release["episodeRange"]): boolean {
  return Boolean(range && episodeNo >= range.start && episodeNo <= range.end);
}

/** 优先使用已确认的本地番剧关联，无关联时复用统一标题匹配。 */
function matchesReleaseAnime(release: Release, myAnime: MyAnime): boolean {
  if (release.animeId) {
    return release.animeId === myAnime.anime.id;
  }
  return matchesAnimeReleaseTitle(release.title, buildAnimeReleaseSearchTerms(myAnime.anime));
}
