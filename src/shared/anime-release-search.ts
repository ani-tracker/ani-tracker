import type { Anime } from "./domain";

const bracketPairPattern = /[「『《【\[(（]([^」』》】\])）]{2,80})[」』》】\])）]/g;
const separatorPattern = /[|｜／/]+|(?:\s+-\s+)|(?:\s+–\s+)|(?:\s+—\s+)|[:：]/g;
const punctuationPattern = /["'“”‘’「」『』《》【】[\]()（）.,，。:：;；!?！？·・~～_-]+/g;

export function buildAnimeReleaseSearchTerms(anime: Anime, extraTerms: string[] = [], limit = 12): string[] {
  const rawTerms = [
    ...extraTerms,
    anime.title,
    anime.originalTitle ?? "",
    ...anime.aliases.map((alias) => alias.alias)
  ];
  const expanded = rawTerms.flatMap(expandSearchTerm);

  return uniqueBySearchKey(expanded).slice(0, limit);
}

export function normalizeReleaseSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(punctuationPattern, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function expandSearchTerm(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const terms = [trimmed];
  for (const match of trimmed.matchAll(bracketPairPattern)) {
    terms.push(match[1]);
  }

  terms.push(trimmed.replace(bracketPairPattern, " "));
  terms.push(...trimmed.split(separatorPattern));
  terms.push(normalizeReleaseSearchText(trimmed));

  return terms.map((term) => term.trim()).filter(isUsefulSearchTerm);
}

function isUsefulSearchTerm(value: string): boolean {
  if (value.length < 2) {
    return false;
  }

  return /[\p{L}\p{N}]/u.test(value);
}

function uniqueBySearchKey(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const key = normalizeReleaseSearchText(value);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(value);
  }

  return unique;
}
