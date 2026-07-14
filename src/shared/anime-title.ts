import type { Anime, AnimeAlias } from "./domain";

export interface AnimeTitleDisplay {
  title: string;
  subtitle?: string;
  aliases: AnimeAlias[];
}

interface AnimeNameCandidate {
  value: string;
  language?: AnimeAlias["language"];
  priority: number;
  explicitLanguage: boolean;
}

const chinesePattern = /[\u3400-\u9fff]/;
const kanaPattern = /[\u3040-\u30ff]/;
const latinPattern = /[a-z]/i;

export function resolveAnimeTitleDisplay(anime: Anime): AnimeTitleDisplay {
  const candidates = collectAnimeNameCandidates(anime);
  const title = pickPreferredTitle(candidates, anime.title);
  const subtitle = pickSubtitle(candidates, title);
  const normalizedTitle = normalizeDisplayTitle(title);
  const normalizedSubtitle = normalizeDisplayTitle(subtitle);

  return {
    title,
    subtitle,
    aliases: anime.aliases
      .filter((alias) => {
        const normalizedAlias = normalizeDisplayTitle(alias.alias);
        return normalizedAlias && normalizedAlias !== normalizedTitle && normalizedAlias !== normalizedSubtitle;
      })
      .sort((left, right) => right.priority - left.priority)
  };
}

export function isLikelyChineseTitle(value: string | undefined): boolean {
  const text = value?.trim();
  return Boolean(text && chinesePattern.test(text) && !kanaPattern.test(text));
}

export function isLikelyJapaneseTitle(value: string | undefined): boolean {
  return Boolean(value?.trim() && kanaPattern.test(value));
}

export function inferAnimeAliasLanguage(
  value: string | undefined,
  fallback: AnimeAlias["language"] = "custom"
): AnimeAlias["language"] {
  if (isLikelyJapaneseTitle(value)) {
    return "ja";
  }

  if (isLikelyChineseTitle(value)) {
    return "zh";
  }

  if (latinPattern.test(value ?? "")) {
    return fallback === "en" ? "en" : "romaji";
  }

  return fallback;
}

function collectAnimeNameCandidates(anime: Anime): AnimeNameCandidate[] {
  return [
    createNameCandidate(anime.title, inferAnimeAliasLanguage(anime.title), 100),
    createNameCandidate(anime.originalTitle, inferAnimeAliasLanguage(anime.originalTitle, "ja"), 95),
    ...anime.aliases.map((alias) => createNameCandidate(alias.alias, alias.language, alias.priority, true))
  ]
    .filter((candidate): candidate is AnimeNameCandidate => Boolean(candidate))
    .sort((left, right) => right.priority - left.priority);
}

function pickPreferredTitle(candidates: AnimeNameCandidate[], fallback: string): string {
  const primaryTitle = candidates.find((candidate) => candidate.priority === 100 && !candidate.explicitLanguage);

  return (
    primaryTitle && (primaryTitle.language === "zh" || isLikelyChineseTitle(primaryTitle.value))
      ? primaryTitle.value
      : undefined
  ) ?? (
    candidates.find((candidate) => candidate.language === "zh" && candidate.explicitLanguage)?.value ??
    candidates.find((candidate) => candidate.language === "zh")?.value ??
    candidates.find((candidate) => isLikelyChineseTitle(candidate.value))?.value ??
    fallback
  );
}

function pickSubtitle(candidates: AnimeNameCandidate[], title: string): string | undefined {
  const normalizedTitle = normalizeDisplayTitle(title);
  const subtitle =
    candidates.find((candidate) => candidate.language === "ja" && normalizeDisplayTitle(candidate.value) !== normalizedTitle) ??
    candidates.find((candidate) => isLikelyJapaneseTitle(candidate.value) && normalizeDisplayTitle(candidate.value) !== normalizedTitle) ??
    candidates.find((candidate) => normalizeDisplayTitle(candidate.value) !== normalizedTitle);

  return subtitle?.value;
}

function createNameCandidate(
  value: string | undefined,
  language: AnimeAlias["language"],
  priority: number,
  explicitLanguage = false
): AnimeNameCandidate | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return {
    value: trimmed,
    language,
    priority,
    explicitLanguage
  };
}

function normalizeDisplayTitle(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
