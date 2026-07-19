import type { Anime, AnimeAlias, AnimeRating, Season } from "@shared/domain";
import { mergeAnimeDetailMetadata } from "@shared/anime-detail";
import { inferAnimeAliasLanguage, isLikelyChineseTitle, isLikelyJapaneseTitle } from "../../../shared/anime-title";

export interface MonthlyAnimeMetadataProvider {
  readonly id: string;
  getAnimeByMonth(year: number, month: number): Promise<Anime[]>;
}

export interface AnimeDetailMetadataProvider {
  readonly id: string;
  getAnimeDetail(externalId: string, fallback: Anime): Promise<Anime>;
}

export interface MonthSeasonInfo {
  season: Season;
  mikanSeason: "冬" | "春" | "夏" | "秋";
}

export interface AnimeMetadataBatch {
  source: string;
  items: Anime[];
}

interface MetadataTitleCandidate {
  value: string;
  language: AnimeAlias["language"];
  priority: number;
  explicitLanguage: boolean;
  kind: "title" | "originalTitle" | "alias";
}

export const seasonByMonth: Record<number, MonthSeasonInfo> = {
  1: { season: "winter", mikanSeason: "冬" },
  2: { season: "winter", mikanSeason: "冬" },
  3: { season: "winter", mikanSeason: "冬" },
  4: { season: "spring", mikanSeason: "春" },
  5: { season: "spring", mikanSeason: "春" },
  6: { season: "spring", mikanSeason: "春" },
  7: { season: "summer", mikanSeason: "夏" },
  8: { season: "summer", mikanSeason: "夏" },
  9: { season: "summer", mikanSeason: "夏" },
  10: { season: "fall", mikanSeason: "秋" },
  11: { season: "fall", mikanSeason: "秋" },
  12: { season: "fall", mikanSeason: "秋" }
};

export function getSeasonInfo(month: number): MonthSeasonInfo {
  const seasonInfo = seasonByMonth[month];
  if (!seasonInfo) {
    throw new Error(`无效月份: ${month}`);
  }

  return seasonInfo;
}

export function formatMonthStartDate(year: number, month: number): string {
  return `${year}-${padDatePart(month)}-01`;
}

export function isDateInMonth(value: string | undefined, year: number, month: number): boolean {
  const parts = parseDateParts(value);
  if (!parts) {
    return false;
  }

  return parts.year === year && parts.month === month;
}

export function parseDateParts(value: string | undefined): { year: number; month: number; day: number } | null {
  const match = value?.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day)
  };
}

export function normalizeTitle(value: string | undefined): string {
  return (value ?? "")
    .trim()
    // NFKC folds title variants such as Roman numerals "Ⅱ" into "II" before matching.
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000()[\]（）【】「」『』,，、.!！?？:：;；・／/~～_-]+/g, "");
}

export function uniqueByNormalizedTitle<
  T extends {
    title: string;
    originalTitle?: string;
    aliases: Array<{ alias: string }>;
    rating?: AnimeRating;
    externalIds: Record<string, string>;
  }
>(items: T[]): T[] {
  const merged: T[] = [];

  for (const item of items) {
    const index = merged.findIndex((existing) => hasSharedTitle(existing, item));
    if (index < 0) {
      merged.push(item);
      continue;
    }

    merged[index] = mergeAnimeLike(merged[index], item);
  }

  return merged;
}

export function mergeAnimeMetadataBatches(batches: AnimeMetadataBatch[]): Anime[] {
  const candidates = batches.flatMap((batch, batchIndex) =>
    batch.items.map((item, itemIndex) => ({
      source: batch.source,
      batchIndex,
      itemIndex,
      item
    }))
  );
  const unionFind = new UnionFind(candidates.length);

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const reason = getMergeReason(candidates[leftIndex].item, candidates[rightIndex].item);
      if (!reason) {
        continue;
      }

      unionFind.union(leftIndex, rightIndex);
    }
  }

  const groups = new Map<number, typeof candidates>();
  candidates.forEach((candidate, index) => {
    const root = unionFind.find(index);
    groups.set(root, [...(groups.get(root) ?? []), candidate]);
  });

  return [...groups.values()].map((group) => {
    const ordered = group
      .sort((left, right) => left.batchIndex - right.batchIndex || left.itemIndex - right.itemIndex)
      .map((candidate) => candidate.item);

    return ordered.slice(1).reduce((merged, item) => mergeAnimeMetadata(merged, item), ordered[0]);
  });
}

function isSameAnimeMetadata(left: Anime, right: Anime): boolean {
  return Boolean(getMergeReason(left, right));
}

function getMergeReason(left: Anime, right: Anime): string | null {
  if (hasConflictingExternalId(left, right)) {
    return null;
  }

  const sharedExternalId = getSharedExternalId(left, right);
  if (sharedExternalId) {
    return `external-id:${sharedExternalId}`;
  }

  // Title-only matches are accepted only inside the same broadcast window to avoid cross-season false positives.
  if (isSameBroadcastWindow(left, right) && hasSharedTitle(left, right)) {
    return "title";
  }

  return null;
}

function getSharedExternalId(left: Anime, right: Anime): string | null {
  const shared = Object.entries(right.externalIds).find(([key, value]) => Boolean(value && left.externalIds[key] === value));
  return shared ? shared[0] : null;
}

function hasConflictingExternalId(left: Anime, right: Anime): boolean {
  return Object.entries(right.externalIds).some(([key, value]) => Boolean(value && left.externalIds[key] && left.externalIds[key] !== value));
}

function isSameBroadcastWindow(left: Anime, right: Anime): boolean {
  return left.premiereYear === right.premiereYear && left.season === right.season;
}

function mergeAnimeMetadata(primary: Anime, secondary: Anime): Anime {
  const premiereDate = pickPremiereDate(primary, secondary);
  const parsedDate = parseDateParts(premiereDate);
  const title = pickPreferredTitle(primary, secondary);
  const originalTitle = pickOriginalTitle(title, primary, secondary);

  return {
    ...primary,
    title,
    originalTitle,
    aliases: normalizeAliases(primary.id, buildMergedAliases(primary, secondary, title, originalTitle)),
    premiereDate,
    premiereYear: parsedDate?.year ?? primary.premiereYear,
    premiereMonth: parsedDate?.month ?? primary.premiereMonth,
    season: primary.season ?? secondary.season,
    summary: primary.summary ?? secondary.summary,
    coverUrl: primary.coverUrl ?? secondary.coverUrl,
    rating: pickPreferredRating(primary.rating, secondary.rating),
    detail: mergeAnimeDetailMetadata(primary.detail, secondary.detail),
    externalIds: {
      ...primary.externalIds,
      ...secondary.externalIds
    }
  };
}

/** 多来源合并时优先保留更可信的评分来源。 */
function pickPreferredRating(primary: AnimeRating | undefined, secondary: AnimeRating | undefined): AnimeRating | undefined {
  if (!primary) {
    return secondary;
  }

  if (!secondary) {
    return primary;
  }

  const primaryRank = getRatingSourceRank(primary.source);
  const secondaryRank = getRatingSourceRank(secondary.source);
  if (primaryRank !== secondaryRank) {
    return primaryRank < secondaryRank ? primary : secondary;
  }

  return (secondary.count ?? 0) > (primary.count ?? 0) ? secondary : primary;
}

function getRatingSourceRank(source: string): number {
  if (source === "bangumi") {
    return 0;
  }

  if (source === "anilist") {
    return 1;
  }

  return 10;
}

function pickPremiereDate(primary: Anime, secondary: Anime): string | undefined {
  if (!primary.premiereDate) {
    return secondary.premiereDate;
  }

  if (!secondary.premiereDate) {
    return primary.premiereDate;
  }

  const primaryDate = parseDateParts(primary.premiereDate);
  const secondaryDate = parseDateParts(secondary.premiereDate);
  if (!primaryDate || !secondaryDate) {
    return primary.premiereDate;
  }

  if (primaryDate.day === 1 && secondaryDate.day > 1 && primaryDate.year === secondaryDate.year && primaryDate.month === secondaryDate.month) {
    return secondary.premiereDate;
  }

  return primary.premiereDate;
}

function normalizeAliases(animeId: string, aliases: AnimeAlias[]): AnimeAlias[] {
  return aliases.map((alias, index) => ({
    ...alias,
    id: `${animeId}-alias-${index + 1}`,
    animeId
  }));
}

function pickPreferredTitle(primary: Anime, secondary: Anime): string {
  const candidates = [...collectTitleCandidates(primary), ...collectTitleCandidates(secondary)];
  const titleCandidates = candidates.filter((candidate) => candidate.kind === "title");

  return (
    titleCandidates.find((candidate) => candidate.language === "zh")?.value ??
    titleCandidates.find((candidate) => isLikelyChineseTitle(candidate.value))?.value ??
    candidates.find((candidate) => candidate.kind === "alias" && candidate.language === "zh" && candidate.explicitLanguage)
      ?.value ??
    candidates.find((candidate) => candidate.language === "zh")?.value ??
    candidates.find((candidate) => isLikelyChineseTitle(candidate.value))?.value ??
    primary.title
  );
}

function pickOriginalTitle(title: string, primary: Anime, secondary: Anime): string | undefined {
  const normalizedTitle = normalizeTitle(title);
  const candidates = [...collectTitleCandidates(primary), ...collectTitleCandidates(secondary)].filter(
    (candidate) => normalizeTitle(candidate.value) !== normalizedTitle
  );

  return (
    candidates.find((candidate) => candidate.language === "ja")?.value ??
    candidates.find((candidate) => isLikelyJapaneseTitle(candidate.value))?.value ??
    undefined
  );
}

function buildMergedAliases(
  primary: Anime,
  secondary: Anime,
  title: string,
  originalTitle: string | undefined
): AnimeAlias[] {
  const ignored = new Set([normalizeTitle(title), normalizeTitle(originalTitle)].filter(Boolean));
  const aliases = [
    ...primary.aliases,
    ...secondary.aliases,
    createAliasCandidate(primary.id, primary.title, inferAnimeAliasLanguage(primary.title), 100),
    createAliasCandidate(primary.id, primary.originalTitle, inferAnimeAliasLanguage(primary.originalTitle, "ja"), 95),
    createAliasCandidate(secondary.id, secondary.title, inferAnimeAliasLanguage(secondary.title), 90),
    createAliasCandidate(secondary.id, secondary.originalTitle, inferAnimeAliasLanguage(secondary.originalTitle, "ja"), 85)
  ].filter((alias): alias is AnimeAlias => Boolean(alias && !ignored.has(normalizeTitle(alias.alias))));

  return mergeAliases([], aliases);
}

function collectTitleCandidates(anime: Anime): MetadataTitleCandidate[] {
  return [
    createTitleCandidate(anime.title, inferAnimeAliasLanguage(anime.title), 100, false, "title"),
    createTitleCandidate(anime.originalTitle, inferAnimeAliasLanguage(anime.originalTitle, "ja"), 95, false, "originalTitle"),
    ...anime.aliases.map((alias) => createTitleCandidate(alias.alias, alias.language, alias.priority, true, "alias"))
  ]
    .filter((candidate): candidate is MetadataTitleCandidate => Boolean(candidate))
    .sort((left, right) => right.priority - left.priority);
}

function createTitleCandidate(
  value: string | undefined,
  language: AnimeAlias["language"],
  priority: number,
  explicitLanguage = false,
  kind: MetadataTitleCandidate["kind"] = "alias"
): MetadataTitleCandidate | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return {
    value: trimmed,
    language,
    priority,
    explicitLanguage,
    kind
  };
}

function createAliasCandidate(
  animeId: string,
  alias: string | undefined,
  language: AnimeAlias["language"],
  priority: number
): AnimeAlias | null {
  const trimmed = alias?.trim();
  if (!trimmed) {
    return null;
  }

  return {
    id: `${animeId}-alias-preserved-${priority}`,
    animeId,
    alias: trimmed,
    language,
    priority
  };
}

function hasSharedTitle(
  left: { title: string; originalTitle?: string; aliases: Array<{ alias: string }> },
  right: { title: string; originalTitle?: string; aliases: Array<{ alias: string }> }
): boolean {
  const leftNames = collectNames(left).map(normalizeTitle).filter(Boolean);
  const rightNames = new Set(collectNames(right).map(normalizeTitle).filter(Boolean));

  return leftNames.some((name) => rightNames.has(name));
}

function collectNames(item: { title: string; originalTitle?: string; aliases: Array<{ alias: string }> }): string[] {
  return [item.title, item.originalTitle, ...item.aliases.map((alias) => alias.alias)].filter(
    (name): name is string => Boolean(name)
  );
}

function mergeAnimeLike<T extends { aliases: Array<{ alias: string }>; rating?: AnimeRating; externalIds: Record<string, string> }>(
  left: T,
  right: T
): T {
  return {
    ...left,
    aliases: mergeAliases(left.aliases, right.aliases),
    rating: pickPreferredRating(left.rating, right.rating),
    externalIds: {
      ...left.externalIds,
      ...right.externalIds
    }
  };
}

function mergeAliases<T extends { alias: string }>(left: T[], right: T[]): T[] {
  const aliases = [...left];
  for (const alias of right) {
    const normalized = normalizeTitle(alias.alias);
    if (!aliases.some((item) => normalizeTitle(item.alias) === normalized)) {
      aliases.push(alias);
    }
  }

  return aliases;
}

// Keeps transitive source matches together: A=B by Mikan->Bangumi, B=C by MAL, therefore A/B/C become one record.
class UnionFind {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parents[index];
    if (parent === index) {
      return index;
    }

    const root = this.find(parent);
    this.parents[index] = root;
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parents[rightRoot] = leftRoot;
    }
  }
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}
