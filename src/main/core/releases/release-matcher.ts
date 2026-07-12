import type { FansubGroup, MyAnime, Release } from "@shared/domain";
import { enrichReleaseFromTitle } from "./release-title-parser";

export interface ReleaseMatchContext {
  anime: MyAnime;
  episodeNo?: number;
  episodeFansubOverrideId?: string;
  candidateFansubGroupIds?: string[];
}

export interface ReleaseMatchResult {
  release: Release;
  score: number;
  reasons: string[];
}

export function rankReleases(
  releases: Release[],
  context: ReleaseMatchContext,
  groups: FansubGroup[] = []
): ReleaseMatchResult[] {
  return releases
    .map((release) => scoreRelease(enrichReleaseFromTitle(release, groups), context))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function scoreRelease(release: Release, context: ReleaseMatchContext): ReleaseMatchResult {
  const reasons: string[] = [];
  let score = 0;

  if (matchesAnimeAlias(release.title, context.anime)) {
    score += 30;
    reasons.push("标题匹配番剧别名");
  }

  if (context.episodeNo && release.episodeNo === context.episodeNo) {
    score += 35;
    reasons.push("集数精确匹配");
  }

  const preferredFansubId = context.episodeFansubOverrideId ?? context.anime.defaultFansubGroupId;
  if (preferredFansubId && release.fansubGroupId === preferredFansubId) {
    score += 40;
    reasons.push(context.episodeFansubOverrideId ? "匹配单集字幕组覆盖" : "匹配默认字幕组");
  } else if (release.fansubGroupId && context.candidateFansubGroupIds?.includes(release.fansubGroupId)) {
    score += 12;
    reasons.push("匹配候补字幕组");
  }

  if (context.anime.preferredResolution && release.resolution === context.anime.preferredResolution) {
    score += 10;
    reasons.push("匹配清晰度偏好");
  }

  if (context.anime.preferredCodec && release.normalizedVideoCodec === context.anime.preferredCodec) {
    score += 8;
    reasons.push("匹配编码偏好");
  }

  if (context.anime.preferredSubtitle && release.subtitle === context.anime.preferredSubtitle) {
    score += 6;
    reasons.push("匹配字幕语言偏好");
  }

  if (release.seeders && release.seeders > 0) {
    score += Math.min(8, Math.ceil(Math.log2(release.seeders + 1)));
    reasons.push("存在做种");
  }

  return {
    release,
    score,
    reasons
  };
}

function matchesAnimeAlias(title: string, myAnime: MyAnime): boolean {
  const lowerTitle = title.toLowerCase();
  const aliases = [myAnime.anime.title, myAnime.anime.originalTitle, ...myAnime.anime.aliases.map((alias) => alias.alias)]
    .filter(Boolean)
    .map((alias) => alias!.toLowerCase());

  return aliases.some((alias) => lowerTitle.includes(alias));
}
