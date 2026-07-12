import type { FansubGroup, NormalizedVideoCodec, Release, SubtitlePreference } from "@shared/domain";
import { normalizeVideoCodec } from "../media-extraction";

export interface ParsedReleaseTitle {
  fansubName?: string;
  episodeNo?: number;
  resolution?: "720p" | "1080p" | "2160p";
  declaredVideoCodec?: string;
  normalizedVideoCodec: NormalizedVideoCodec;
  subtitle?: SubtitlePreference;
}

const resolutionPatterns: Array<{ pattern: RegExp; value: "720p" | "1080p" | "2160p" }> = [
  { pattern: /\b(?:2160p|4k|3840x2160)\b/i, value: "2160p" },
  { pattern: /\b(?:1080p|1920x1080)\b/i, value: "1080p" },
  { pattern: /\b(?:720p|1280x720)\b/i, value: "720p" }
];

const subtitlePatterns: Array<{ pattern: RegExp; value: SubtitlePreference }> = [
  { pattern: /\b(?:chs|gb|简体|简日)\b/i, value: "chs" },
  { pattern: /\b(?:cht|big5|繁体|繁日)\b/i, value: "cht" },
  { pattern: /\b(?:简繁|繁简|multi)\b/i, value: "multi" },
  { pattern: /\b(?:jpn|jp|日文)\b/i, value: "jpn" },
  { pattern: /\b(?:eng|英文)\b/i, value: "eng" }
];

const episodePatterns = [
  /\[\s*(\d{1,3}(?:\.\d)?)\s*]/,
  /(?:^|[\s_-])(?:ep|episode|第)?\s*(\d{1,3}(?:\.\d)?)(?:\s*话|\s*集)?(?:[\s_.-]|$)/i,
  /-\s*(\d{1,3}(?:\.\d)?)\s*(?:v\d)?(?:\s|\[|$)/i
];

export function parseReleaseTitle(title: string, groups: FansubGroup[] = []): ParsedReleaseTitle {
  const normalizedVideoCodec = normalizeVideoCodec(title);

  return {
    fansubName: detectFansubName(title, groups),
    episodeNo: detectEpisodeNo(title),
    resolution: resolutionPatterns.find((item) => item.pattern.test(title))?.value,
    declaredVideoCodec: detectCodecLabel(title),
    normalizedVideoCodec,
    subtitle: subtitlePatterns.find((item) => item.pattern.test(title))?.value
  };
}

export function enrichReleaseFromTitle(release: Release, groups: FansubGroup[] = []): Release {
  const parsed = parseReleaseTitle(release.title, groups);
  const fansubGroup = parsed.fansubName
    ? groups.find((group) =>
        [group.name, ...group.aliases].some((alias) => alias.toLowerCase() === parsed.fansubName?.toLowerCase())
      )
    : undefined;

  return {
    ...release,
    episodeNo: release.episodeNo ?? parsed.episodeNo,
    fansubGroupId: release.fansubGroupId ?? fansubGroup?.id,
    resolution: release.resolution ?? parsed.resolution,
    declaredVideoCodec: release.declaredVideoCodec ?? parsed.declaredVideoCodec,
    normalizedVideoCodec:
      release.normalizedVideoCodec ??
      (parsed.normalizedVideoCodec === "Unknown" ? undefined : parsed.normalizedVideoCodec),
    subtitle: release.subtitle ?? parsed.subtitle
  };
}

function detectFansubName(title: string, groups: FansubGroup[]): string | undefined {
  const bracketMatch = title.match(/^\s*[\[【]([^\]】]+)[\]】]/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim();
  }

  for (const group of groups) {
    const names = [group.name, ...group.aliases];
    const matched = names.find((name) => title.toLowerCase().includes(name.toLowerCase()));
    if (matched) {
      return matched;
    }
  }

  return undefined;
}

function detectEpisodeNo(title: string): number | undefined {
  for (const pattern of episodePatterns) {
    const match = title.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        return value;
      }
    }
  }

  return undefined;
}

function detectCodecLabel(title: string): string | undefined {
  const patterns = [
    /\b(h\.?265|x265|hevc)\b/i,
    /\b(h\.?264|x264|avc)\b/i,
    /\bav1\b/i,
    /\bvp9\b/i
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
    if (match?.[0]) {
      return match[0];
    }
  }

  return undefined;
}
