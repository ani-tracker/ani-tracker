import type { Anime } from "./domain";

const bracketPairPattern = /[「『《【\[(（]([^」』》】\])）]{2,80})[」』》】\])）]/g;
const separatorPattern = /[|｜／/]+|(?:\s+-\s+)|(?:\s+–\s+)|(?:\s+—\s+)|[:：]/g;
const punctuationPattern = /["'“”‘’「」『』《》【】[\]()（）.,，。:：;；!?！？·・~～_-]+/g;
const seasonSuffixPatterns = [
  /\s*第\s*[〇零一二三四五六七八九十百两\d]+\s*[季期部篇章]\s*$/u,
  /\s+\d+(?:st|nd|rd|th)\s+season\s*$/i,
  /\s+(?:season|part)\s*\d+\s*$/i,
  /\s+s\d+\s*$/i
];

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

/** 判断资源标题是否包含目标番剧的任一有效标题，过滤下载源的模糊误匹配。 */
export function matchesAnimeReleaseTitle(releaseTitle: string, animeTitleTerms: string[]): boolean {
  const normalizedTitle = normalizeReleaseSearchText(releaseTitle);
  const compactTitle = normalizedTitle.replace(/\s+/g, "");
  const terms = uniqueBySearchKey(animeTitleTerms.flatMap(expandSearchTerm))
    .map(normalizeReleaseSearchText)
    .filter(isDistinctiveSearchTerm);

  return terms.some((term) => {
    const compactTerm = term.replace(/\s+/g, "");
    return normalizedTitle.includes(term) || compactTitle.includes(compactTerm);
  });
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
  terms.push(stripSeasonSuffix(trimmed));
  terms.push(normalizeReleaseSearchText(trimmed));

  return terms.map((term) => term.trim()).filter(isUsefulSearchTerm);
}

function stripSeasonSuffix(value: string): string {
  let result = value.trim();
  for (const pattern of seasonSuffixPatterns) {
    result = result.replace(pattern, "").trim();
  }
  return result;
}

function isDistinctiveSearchTerm(value: string): boolean {
  const withoutSeason = stripSeasonSuffix(value);
  const compact = normalizeReleaseSearchText(withoutSeason).replace(/\s+/g, "");
  return compact.length >= 2 && /[\p{L}\p{N}]/u.test(compact);
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
