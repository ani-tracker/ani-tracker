import type { Anime, AnimeAlias, Season } from "@shared/domain";

export interface MonthlyAnimeMetadataProvider {
  readonly id: string;
  getAnimeByMonth(year: number, month: number): Promise<Anime[]>;
}

export interface MonthSeasonInfo {
  season: Season;
  mikanSeason: "冬" | "春" | "夏" | "秋";
}

export interface AnimeMetadataBatch {
  source: string;
  items: Anime[];
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
    .toLowerCase()
    .replace(/[\s\u3000()[\]【】「」『』,，.!！?？:：;；_-]+/g, "");
}

export function uniqueByNormalizedTitle<
  T extends {
    title: string;
    originalTitle?: string;
    aliases: Array<{ alias: string }>;
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
  const merged: Anime[] = [];

  for (const batch of batches) {
    for (const item of batch.items) {
      const index = merged.findIndex((existing) => isSameAnimeMetadata(existing, item));
      if (index < 0) {
        merged.push(item);
        continue;
      }

      merged[index] = mergeAnimeMetadata(merged[index], item);
    }
  }

  return merged;
}

function isSameAnimeMetadata(left: Anime, right: Anime): boolean {
  return hasSharedExternalId(left, right) || hasSharedTitle(left, right);
}

function hasSharedExternalId(left: Anime, right: Anime): boolean {
  return Object.entries(right.externalIds).some(([key, value]) => Boolean(value && left.externalIds[key] === value));
}

function mergeAnimeMetadata(primary: Anime, secondary: Anime): Anime {
  const premiereDate = pickPremiereDate(primary, secondary);
  const parsedDate = parseDateParts(premiereDate);

  return {
    ...primary,
    originalTitle: primary.originalTitle ?? secondary.originalTitle,
    aliases: normalizeAliases(primary.id, mergeAliases(primary.aliases, secondary.aliases)),
    premiereDate,
    premiereYear: parsedDate?.year ?? primary.premiereYear,
    premiereMonth: parsedDate?.month ?? primary.premiereMonth,
    season: primary.season ?? secondary.season,
    summary: primary.summary ?? secondary.summary,
    coverUrl: primary.coverUrl ?? secondary.coverUrl,
    externalIds: {
      ...primary.externalIds,
      ...secondary.externalIds
    }
  };
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

function mergeAnimeLike<T extends { aliases: Array<{ alias: string }>; externalIds: Record<string, string> }>(
  left: T,
  right: T
): T {
  return {
    ...left,
    aliases: mergeAliases(left.aliases, right.aliases),
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

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}
