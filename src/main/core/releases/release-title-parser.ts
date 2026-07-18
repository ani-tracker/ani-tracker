import type {
  FansubGroup,
  NormalizedVideoCodec,
  Release,
  ReleaseContentKind,
  ReleaseEpisodeRange,
  SubtitleLanguage,
  SubtitlePreference,
  VideoBitDepth
} from "@shared/domain";
import { normalizeSubtitleLanguages, toLegacySubtitlePreference } from "@shared/release-metadata";
import { createHash } from "node:crypto";
import { detectSeriesSeasonNo } from "../../../shared/anime-release-search";
import { normalizeVideoCodec } from "../media-extraction";

export interface ParsedReleaseTitle {
  fansubName?: string;
  episodeNo?: number;
  episodeRange?: ReleaseEpisodeRange;
  seriesSeasonNo?: number;
  contentKind: ReleaseContentKind;
  resolution?: "720p" | "1080p" | "2160p";
  declaredVideoCodec?: string;
  normalizedVideoCodec: NormalizedVideoCodec;
  bitDepth?: VideoBitDepth;
  subtitleLanguages: SubtitleLanguage[];
  subtitle?: SubtitlePreference;
}

const resolutionPatterns: Array<{ pattern: RegExp; value: "720p" | "1080p" | "2160p" }> = [
  { pattern: /\b(?:2160p|4k|3840x2160)\b/i, value: "2160p" },
  { pattern: /\b(?:1080p|1920x1080)\b/i, value: "1080p" },
  { pattern: /\b(?:720p|1280x720)\b/i, value: "720p" }
];

const fansubVariantCharacters: Record<string, string> = {
  "綠": "绿",
  "緑": "绿",
  "組": "组",
  "櫻": "樱",
  "桜": "樱",
  "國": "国",
  "動": "动",
  "畫": "画",
  "華": "华",
  "風": "风",
  "夢": "梦",
  "貓": "猫",
  "龍": "龙",
  "異": "异",
  "鄉": "乡",
  "聲": "声",
  "葉": "叶",
  "蘿": "萝",
  "與": "与",
  "體": "体",
  "簡": "简",
  "壓": "压",
  "製": "制",
  "學": "学",
  "園": "园"
};

const episodeRangePatterns = [
  /(?:^|[\s_-])s\d{1,2}e(\d{1,3}(?:\.\d)?)\s*[-~]\s*(\d{1,3}(?:\.\d)?)(?:[\s_.\-[\]]|$)/i,
  /\[\s*(\d{1,3}(?:\.\d)?)\s*[-~]\s*(\d{1,3}(?:\.\d)?)\s*]/,
  /(?:^|[\s_-])(?:ep|episode|第)?\s*(\d{1,3}(?:\.\d)?)\s*[-~]\s*(\d{1,3}(?:\.\d)?)(?:\s*话|\s*集)?(?:[\s_.\-[\]]|$)/i
];

const episodePatterns = [
  /(?:^|[\s_-])s\d{1,2}e(\d{1,3}(?:\.\d)?)(?:[\s_.\-[\]]|$)/i,
  /\[\s*(\d{1,3}(?:\.\d)?)\s*]/,
  /-\s*(\d{1,3}(?:\.\d)?)\s*(?:v\d)?(?:\s|\[|$)/i,
  /(?:^|[\s_-])(?:ep|episode|第)?\s*(\d{1,3}(?:\.\d)?)(?:\s*话|\s*集)?(?:[\s_.-]|$)/i
];
const technicalNumberPattern = /\b\d{1,4}(?:\.\d+)?\s*[- ]?\s*(?:bits?|gib|gb|mib|mb|fps|hz|khz)\b/gi;
const batchPatterns = [
  /(?:全集|合集|合輯|总集篇|總集篇|完结|完結|全\s*\d+\s*[集话話])/iu,
  /\b(?:complete(?:\s+series)?|collection|blu-?ray\s+box|bd\s*box)\b/i,
  /[\[【(（]\s*s?\d{0,2}\s*(?:fin|complete)\s*[\]】)）]/i,
  /(?:^|[\s_.\-[【(（])s\d{1,2}\s*(?:fin|complete)(?=$|[\s_.\-\]】)）])/i
];

export function parseReleaseTitle(title: string, groups: FansubGroup[] = []): ParsedReleaseTitle {
  const normalizedVideoCodec = normalizeVideoCodec(title);
  const episodeRange = detectEpisodeRange(title);
  const episodeNo = episodeRange ? undefined : detectEpisodeNo(stripTechnicalNumberTokens(title));
  const subtitleMetadata = detectSubtitleMetadata(title);

  return {
    fansubName: detectFansubName(title, groups),
    episodeNo,
    episodeRange,
    seriesSeasonNo: detectSeriesSeasonNo(title),
    contentKind: resolveReleaseContentKind(title, episodeNo, episodeRange),
    resolution: resolutionPatterns.find((item) => item.pattern.test(title))?.value,
    declaredVideoCodec: detectCodecLabel(title),
    normalizedVideoCodec,
    bitDepth: detectBitDepth(title),
    subtitleLanguages: subtitleMetadata.languages,
    subtitle: subtitleMetadata.legacyPreference
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
  const subtitleLanguages = normalizeSubtitleLanguages(
    release.subtitleLanguages?.length
      ? release.subtitleLanguages
      : parsed.subtitleLanguages.length
        ? parsed.subtitleLanguages
        : release.subtitle && release.subtitle !== "multi"
          ? [release.subtitle]
          : []
  );

  return {
    ...release,
    episodeNo: release.episodeNo ?? parsed.episodeNo,
    episodeRange: release.episodeRange ?? parsed.episodeRange,
    seriesSeasonNo: release.seriesSeasonNo ?? parsed.seriesSeasonNo,
    contentKind: release.contentKind ?? parsed.contentKind,
    fansubGroupId: existingFansubGroupId ?? fansubGroup?.id ?? release.fansubGroupId ?? discoveredFansubGroupId,
    fansubName,
    resolution: release.resolution ?? parsed.resolution,
    declaredVideoCodec: release.declaredVideoCodec ?? parsed.declaredVideoCodec,
    normalizedVideoCodec:
      release.normalizedVideoCodec ??
      (parsed.normalizedVideoCodec === "Unknown" ? undefined : parsed.normalizedVideoCodec),
    bitDepth: release.bitDepth ?? parsed.bitDepth,
    subtitleLanguages,
    subtitle: release.subtitle ?? parsed.subtitle ?? toLegacySubtitlePreference(subtitleLanguages)
  };
}

/** 移除容量、位深和帧率等技术数字，避免被通用集数规则误判。 */
function stripTechnicalNumberTokens(title: string): string {
  return title.replace(technicalNumberPattern, " ");
}

/** 根据集数、范围和标题关键词判断资源内容类型。 */
function resolveReleaseContentKind(
  title: string,
  episodeNo: number | undefined,
  episodeRange: ReleaseEpisodeRange | undefined
): ReleaseContentKind {
  if (episodeRange) {
    return "range";
  }
  if (episodeNo !== undefined) {
    return "episode";
  }
  return batchPatterns.some((pattern) => pattern.test(title)) ? "batch" : "unknown";
}

/** 生成跨搜索和重启保持稳定的动态字幕组 ID。 */
export function createDiscoveredFansubId(name: string): string {
  const digest = createHash("sha256").update(normalizeFansubName(name)).digest("hex").slice(0, 16);
  return `fansub-auto-${digest}`;
}

/** 规范化字幕组名称，用于保守合并大小写、全半角和常见中日异体字。 */
export function normalizeFansubName(name: string): string {
  return [...name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()]
    .map((character) => fansubVariantCharacters[character] ?? character)
    .join("");
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
  return !/^(?:\d{1,4}(?:\.\d+)?|(?:8|10|12)\s*-?\s*bits?|hi10p|main10|\d{3,4}p|4k|8k|x26[45]|h\.?26[45]|avc|hevc|av1|vp9|web-?dl|bdrip|webrip|mkv|mp4|简体|繁体|简繁|chs|cht|multi)$/i.test(normalized);
}

/** 从标题识别具体字幕语言，泛化“多语”不会虚构语言组成。 */
function detectSubtitleMetadata(title: string): {
  languages: SubtitleLanguage[];
  legacyPreference?: SubtitlePreference;
} {
  const languages: SubtitleLanguage[] = [];
  const add = (language: SubtitleLanguage) => {
    if (!languages.includes(language)) {
      languages.push(language);
    }
  };

  if (/(?:简繁|繁简)/i.test(title)) {
    add("chs");
    add("cht");
  }
  if (/(?:简日|简中日)/i.test(title)) {
    add("chs");
    add("jpn");
  }
  if (/(?:繁日|繁中日)/i.test(title)) {
    add("cht");
    add("jpn");
  }
  if (/(?:\b(?:chs|gb)\b|简体|简中)/i.test(title)) {
    add("chs");
  }
  if (/(?:\b(?:cht|big5)\b|繁体|繁中)/i.test(title)) {
    add("cht");
  }
  if (/(?:\b(?:jpn|jp)\b|日文|日语|日語)/i.test(title)) {
    add("jpn");
  }
  if (/(?:\beng\b|英文|英语|英語)/i.test(title)) {
    add("eng");
  }

  const normalized = normalizeSubtitleLanguages(languages);
  const isGenericMulti = /(?:\bmulti\b|多语|多語|多国语言|多國語言)/i.test(title);
  return {
    languages: normalized,
    legacyPreference: isGenericMulti || normalized.length > 1
      ? "multi"
      : toLegacySubtitlePreference(normalized)
  };
}

/** 仅根据标题中的显式标记识别位深，不从编码格式推断。 */
function detectBitDepth(title: string): VideoBitDepth | undefined {
  if (/\b(?:hi10p|main\s*10)\b/i.test(title)) {
    return 10;
  }
  const match = title.match(/\b(8|10|12)\s*[- ]?\s*bits?\b/i);
  if (!match?.[1]) {
    return undefined;
  }
  return Number(match[1]) as VideoBitDepth;
}

/** 从标题识别 `[01-02]`、`第01-02集` 等连集范围。 */
function detectEpisodeRange(title: string): ReleaseEpisodeRange | undefined {
  for (const pattern of episodeRangePatterns) {
    const match = title.match(pattern);
    if (!match?.[1] || !match?.[2]) {
      continue;
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return { start, end };
    }
  }

  return undefined;
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
