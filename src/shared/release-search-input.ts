import type { Release } from "./domain";

export interface ParsedReleaseSearchInput {
  keyword: string;
  episodeNo?: number;
}

interface EpisodeMarker {
  episodeNo: number;
  index: number;
  length: number;
  replacement: string;
}

/** 从资源搜索输入中提取集数，并返回可直接交给下载源的关键词。 */
export function parseReleaseSearchInput(value: string): ParsedReleaseSearchInput {
  const input = value.normalize("NFKC").trim();
  if (!input) {
    return { keyword: "" };
  }

  const marker = findEpisodeMarker(input);
  if (!marker) {
    return { keyword: input };
  }

  const keyword = cleanSearchKeyword(
    `${input.slice(0, marker.index)}${marker.replacement}${input.slice(marker.index + marker.length)}`
  );
  if (!keyword) {
    return { keyword: input };
  }

  return { keyword, episodeNo: marker.episodeNo };
}

/** 判断资源的单集或合集范围是否包含目标集数。 */
export function releaseMatchesEpisode(release: Release, episodeNo: number | undefined): boolean {
  if (episodeNo === undefined) {
    return true;
  }
  if (release.episodeNo === episodeNo) {
    return true;
  }

  return Boolean(
    release.episodeRange &&
    episodeNo >= release.episodeRange.start &&
    episodeNo <= release.episodeRange.end
  );
}

/** 按常见中文、EP、SxxExx 和标题末尾数字格式查找集数标记。 */
function findEpisodeMarker(value: string): EpisodeMarker | undefined {
  const seasonEpisode = /(?:^|[\s._\-[(【])S(\d{1,2})\s*E(\d{1,4}(?:\.\d+)?)(?:V\d+)?(?=$|[\s._\-\])】])/i.exec(value);
  if (seasonEpisode?.index !== undefined) {
    const episodeNo = parseEpisodeNumber(seasonEpisode[2]);
    if (episodeNo !== undefined) {
      const prefix = seasonEpisode[0].match(/^[\s._\-[(【]/)?.[0] ?? "";
      return {
        episodeNo,
        index: seasonEpisode.index,
        length: seasonEpisode[0].length,
        replacement: `${prefix}S${seasonEpisode[1]}`
      };
    }
  }

  const chineseEpisode = /第\s*(\d{1,4}(?:\.\d+)?)\s*(?:集|话|話)(?:\s*(?:上|中|下))?/u.exec(value);
  if (chineseEpisode?.index !== undefined) {
    const episodeNo = parseEpisodeNumber(chineseEpisode[1]);
    if (episodeNo !== undefined) {
      return {
        episodeNo,
        index: chineseEpisode.index,
        length: chineseEpisode[0].length,
        replacement: ""
      };
    }
  }

  const latinEpisode = /(?:^|[\s._\-[(【])(?:EP(?:ISODE)?|E)\s*[._-]?\s*(\d{1,4}(?:\.\d+)?)(?:V\d+)?(?=$|[\s._\-\])】])/i.exec(value);
  if (latinEpisode?.index !== undefined) {
    const episodeNo = parseEpisodeNumber(latinEpisode[1]);
    if (episodeNo !== undefined) {
      const prefix = latinEpisode[0].match(/^[\s._\-[(【]/)?.[0] ?? "";
      return {
        episodeNo,
        index: latinEpisode.index,
        length: latinEpisode[0].length,
        replacement: prefix
      };
    }
  }

  const trailingEpisode = /(?:^|[\s._\-[(【])(\d{1,3}(?:\.\d+)?)(?=\s*(?:[\])】])?\s*$)/.exec(value);
  if (trailingEpisode?.index !== undefined) {
    const episodeNo = parseEpisodeNumber(trailingEpisode[1]);
    const precedingText = value.slice(0, trailingEpisode.index);
    const isTechnicalDecimal = trailingEpisode[0].startsWith(".") && /[\dHh]$/.test(precedingText);
    const isAudioChannelLayout = /^(?:1\.0|2\.0|5\.1|7\.1)$/.test(trailingEpisode[1]);
    const isCommonResolution = episodeNo !== undefined && [360, 480, 720].includes(episodeNo);
    if (episodeNo !== undefined && !isTechnicalDecimal && !isAudioChannelLayout && !isCommonResolution) {
      return {
        episodeNo,
        index: trailingEpisode.index,
        length: trailingEpisode[0].length,
        replacement: ""
      };
    }
  }

  return undefined;
}

/** 规范化移除集数后的分隔符和空白。 */
function cleanSearchKeyword(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[\s._-]+$/g, "")
    .replace(/^[_-]+\s*/g, "")
    .trim();
}

/** 将集数字符串转换为有效的非负数。 */
function parseEpisodeNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
