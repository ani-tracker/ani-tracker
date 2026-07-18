import type { Release, SubtitleLanguage, SubtitlePreference, VideoBitDepth } from "./domain";

export const subtitleLanguageText: Record<SubtitleLanguage, string> = {
  chs: "简体",
  cht: "繁体",
  jpn: "日语",
  eng: "英语"
};

const subtitleLanguageOrder: SubtitleLanguage[] = ["chs", "cht", "jpn", "eng"];

/** 规范化字幕语言集合，去重并保持稳定展示顺序。 */
export function normalizeSubtitleLanguages(values: readonly SubtitleLanguage[] | undefined): SubtitleLanguage[] {
  const selected = new Set(values ?? []);
  return subtitleLanguageOrder.filter((language) => selected.has(language));
}

/** 将旧版单值字幕偏好转换为多语言集合。 */
export function subtitlePreferenceToLanguages(value?: SubtitlePreference): SubtitleLanguage[] {
  if (!value) {
    return [];
  }
  return value === "multi" ? ["chs", "cht"] : [value];
}

/** 优先读取多语言字段，旧数据则回退到单值字幕偏好。 */
export function resolveSubtitleLanguages(
  languages?: readonly SubtitleLanguage[],
  legacyPreference?: SubtitlePreference
): SubtitleLanguage[] {
  const normalized = normalizeSubtitleLanguages(languages);
  return normalized.length > 0 ? normalized : subtitlePreferenceToLanguages(legacyPreference);
}

/** 将多语言集合转换为旧版兼容字段。 */
export function toLegacySubtitlePreference(
  languages?: readonly SubtitleLanguage[]
): SubtitlePreference | undefined {
  const normalized = normalizeSubtitleLanguages(languages);
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.length === 1 ? normalized[0] : "multi";
}

/** 读取资源实际声明的字幕语言；泛化 multi 不虚构具体语言。 */
export function getReleaseSubtitleLanguages(release: Pick<Release, "subtitleLanguages" | "subtitle">): SubtitleLanguage[] {
  const normalized = normalizeSubtitleLanguages(release.subtitleLanguages);
  if (normalized.length > 0 || release.subtitle === "multi") {
    return normalized;
  }
  return subtitlePreferenceToLanguages(release.subtitle);
}

/** 计算资源字幕对用户偏好集合的覆盖率。 */
export function getSubtitleCoverage(
  release: Pick<Release, "subtitleLanguages" | "subtitle">,
  preferredLanguages?: readonly SubtitleLanguage[]
): number {
  const preferred = normalizeSubtitleLanguages(preferredLanguages);
  if (preferred.length === 0) {
    return 1;
  }

  const actual = getReleaseSubtitleLanguages(release);
  if (actual.length === 0) {
    return release.subtitle === "multi" ? 0.6 : 0;
  }

  const matched = preferred.filter((language) => actual.includes(language)).length;
  return matched / preferred.length;
}

/** 生成字幕语言展示文案，无法确认时明确标记未知。 */
export function formatSubtitleLanguages(
  languages?: readonly SubtitleLanguage[],
  legacyPreference?: SubtitlePreference
): string {
  const normalized = normalizeSubtitleLanguages(languages);
  if (normalized.length > 0) {
    return normalized.map((language) => subtitleLanguageText[language]).join(" + ");
  }
  if (legacyPreference === "multi") {
    return "多语";
  }
  if (legacyPreference) {
    return subtitleLanguageText[legacyPreference];
  }
  return "字幕未知";
}

/** 生成位深展示文案，编码格式不会用于推断位深。 */
export function formatVideoBitDepth(bitDepth?: VideoBitDepth): string {
  return bitDepth ? `${bitDepth}bit` : "位深未知";
}
