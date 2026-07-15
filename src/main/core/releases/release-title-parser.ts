import type { FansubGroup, NormalizedVideoCodec, Release, SubtitlePreference } from "@shared/domain";
import { createHash } from "node:crypto";
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
  { pattern: /(?:\b(?:chs|gb)\b|简体|简日)/i, value: "chs" },
  { pattern: /(?:\b(?:cht|big5)\b|繁体|繁日)/i, value: "cht" },
  { pattern: /(?:\bmulti\b|简繁|繁简)/i, value: "multi" },
  { pattern: /(?:\b(?:jpn|jp)\b|日文)/i, value: "jpn" },
  { pattern: /(?:\beng\b|英文)/i, value: "eng" }
];

const episodePatterns = [
  /(?:^|[\s_-])s\d{1,2}e(\d{1,3}(?:\.\d)?)(?:[\s_.\-[\]]|$)/i,
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
  const fansubName = release.fansubName ?? parsed.fansubName;
  const fansubGroup = fansubName
    ? groups.find((group) =>
        [group.name, ...group.aliases].some((alias) => normalizeFansubName(alias) === normalizeFansubName(fansubName))
      )
    : undefined;
  const discoveredFansubGroupId = fansubName && isMeaningfulFansubName(fansubName)
    ? createDiscoveredFansubId(fansubName)
    : undefined;
  const existingFansubGroupId = release.fansubGroupId?.startsWith("fansub-auto-")
    ? undefined
    : release.fansubGroupId;

  return {
    ...release,
    episodeNo: release.episodeNo ?? parsed.episodeNo,
    fansubGroupId: existingFansubGroupId ?? fansubGroup?.id ?? release.fansubGroupId ?? discoveredFansubGroupId,
    fansubName,
    resolution: release.resolution ?? parsed.resolution,
    declaredVideoCodec: release.declaredVideoCodec ?? parsed.declaredVideoCodec,
    normalizedVideoCodec:
      release.normalizedVideoCodec ??
      (parsed.normalizedVideoCodec === "Unknown" ? undefined : parsed.normalizedVideoCodec),
    subtitle: release.subtitle ?? parsed.subtitle
  };
}

/** 生成跨搜索和重启保持稳定的动态字幕组 ID。 */
export function createDiscoveredFansubId(name: string): string {
  const digest = createHash("sha256").update(normalizeFansubName(name)).digest("hex").slice(0, 16);
  return `fansub-auto-${digest}`;
}

/** 规范化字幕组名称，用于保守合并大小写和全半角差异。 */
export function normalizeFansubName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** 排除分辨率、编码和占位文字，避免把技术标签保存成字幕组。 */
export function isMeaningfulFansubName(name: string): boolean {
  const normalized = normalizeFansubName(name);
  if (!normalized || normalized.length > 80) {
    return false;
  }
  if (["字幕组", "压制组", "fansub", "unknown", "未知", "未识别字幕组"].includes(normalized)) {
    return false;
  }
  return !/^(?:\d{1,4}(?:\.\d+)?|\d{3,4}p|4k|8k|x26[45]|h\.?26[45]|avc|hevc|av1|vp9|web-?dl|bdrip|webrip|mkv|mp4|简体|繁体|简繁|chs|cht|multi)$/i.test(normalized);
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
