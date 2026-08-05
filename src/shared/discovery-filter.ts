import type { Anime, AnimeAiringStatus, AnimeFormat } from "./domain";

export type DiscoveryBrowseSortKey = "bangumiRank" | "recent" | "rating";
export type DiscoverySourceMaterial = "original" | "manga" | "lightNovel" | "game" | "other";
export type DiscoveryGenre = "action" | "fantasy" | "sciFi" | "sliceOfLife" | "mystery" | "comedy";
export type DiscoveryDemographic = "shounen" | "shoujo" | "seinen" | "josei" | "kids";
export type DiscoveryRegion = "japan" | "china" | "korea" | "western" | "other";

export interface DiscoveryBrowseFilters {
  formats: AnimeFormat[];
  sourceMaterials: DiscoverySourceMaterial[];
  genres: DiscoveryGenre[];
  demographics: DiscoveryDemographic[];
  regions: DiscoveryRegion[];
  airingStatuses: AnimeAiringStatus[];
  years: number[];
  minRating: number;
}

/** 创建互不共享引用的分类浏览默认筛选。 */
export function createEmptyDiscoveryBrowseFilters(): DiscoveryBrowseFilters {
  return {
    formats: [],
    sourceMaterials: [],
    genres: [],
    demographics: [],
    regions: [],
    airingStatuses: [],
    years: [],
    minRating: 0
  };
}

/** 统计筛选器中已选择的离散条件和最低评分条件。 */
export function countDiscoveryBrowseFilters(filters: DiscoveryBrowseFilters): number {
  return filters.formats.length
    + filters.sourceMaterials.length
    + filters.genres.length
    + filters.demographics.length
    + filters.regions.length
    + filters.airingStatuses.length
    + filters.years.length
    + (filters.minRating > 0 ? 1 : 0);
}

/** 使用真实目录元数据筛选并排序分类浏览结果。 */
export function filterDiscoveryBrowseItems(
  items: Anime[],
  keyword: string,
  filters: DiscoveryBrowseFilters,
  sortKey: DiscoveryBrowseSortKey
): Anime[] {
  const normalizedKeyword = normalizeValue(keyword);
  return items
    .filter((anime) => matchesKeyword(anime, normalizedKeyword) && matchesFilters(anime, filters))
    .sort((left, right) => compareBrowseItems(left, right, sortKey));
}

/** 返回目录中实际出现的元数据来源，供结果状态栏展示。 */
export function collectDiscoveryMetadataSources(items: Anime[]): string[] {
  const sources = new Set<string>();
  for (const anime of items) {
    for (const source of anime.detail?.metadataSources ?? []) sources.add(source);
    for (const source of Object.keys(anime.externalIds)) {
      if (source === "bangumi" || source === "anilist" || source === "mikan") sources.add(source);
    }
  }
  return [...sources];
}

function matchesKeyword(anime: Anime, keyword: string): boolean {
  if (!keyword) return true;
  return [anime.title, anime.originalTitle, ...anime.aliases.map((alias) => alias.alias)]
    .some((value) => normalizeValue(value).includes(keyword));
}

function matchesFilters(anime: Anime, filters: DiscoveryBrowseFilters): boolean {
  const detail = anime.detail;
  if (filters.formats.length > 0 && (!detail?.format || !filters.formats.includes(detail.format))) return false;
  if (filters.sourceMaterials.length > 0 && !matchesMappedValue(detail?.sourceMaterial, filters.sourceMaterials, sourceMaterialPatterns)) return false;
  if (filters.genres.length > 0 && !filters.genres.some((genre) => (detail?.genres ?? []).some((value) => matchesPatterns(value, genrePatterns[genre])))) return false;
  if (filters.demographics.length > 0 && !matchesMappedValue(detail?.demographic, filters.demographics, demographicPatterns)) return false;
  if (filters.regions.length > 0 && !matchesRegion(detail?.countryOfOrigin, filters.regions)) return false;
  if (filters.airingStatuses.length > 0 && (!detail?.airingStatus || !filters.airingStatuses.includes(detail.airingStatus))) return false;
  if (filters.years.length > 0 && !filters.years.includes(anime.premiereYear)) return false;
  if (filters.minRating > 0 && (!anime.rating || anime.rating.score < filters.minRating)) return false;
  return true;
}

function compareBrowseItems(left: Anime, right: Anime, sortKey: DiscoveryBrowseSortKey): number {
  if (sortKey === "bangumiRank") {
    const leftRank = left.detail?.ranking?.source === "bangumi" ? left.detail.ranking.rank : undefined;
    const rightRank = right.detail?.ranking?.source === "bangumi" ? right.detail.ranking.rank : undefined;
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
  }
  if (sortKey === "recent") {
    const dateOrder = premiereValue(right).localeCompare(premiereValue(left));
    if (dateOrder !== 0) return dateOrder;
  } else {
    const scoreOrder = (right.rating?.score ?? -1) - (left.rating?.score ?? -1);
    if (scoreOrder !== 0) return scoreOrder;
    const countOrder = (right.rating?.count ?? -1) - (left.rating?.count ?? -1);
    if (countOrder !== 0) return countOrder;
  }
  return left.title.localeCompare(right.title, "zh-CN");
}

function premiereValue(anime: Anime): string {
  return anime.premiereDate ?? `${anime.premiereYear}-${String(anime.premiereMonth).padStart(2, "0")}-01`;
}

function matchesMappedValue<T extends string>(
  value: string | undefined,
  selected: T[],
  patterns: Record<T, readonly string[]>
): boolean {
  if (!value) return false;
  return selected.some((key) => matchesPatterns(value, patterns[key]));
}

function matchesRegion(value: string | undefined, selected: DiscoveryRegion[]): boolean {
  if (!value) return false;
  const normalized = normalizeValue(value);
  const matched = (Object.keys(regionPatterns) as Array<Exclude<DiscoveryRegion, "other">>)
    .find((key) => matchesPatterns(normalized, regionPatterns[key]));
  return selected.includes(matched ?? "other");
}

function matchesPatterns(value: string, patterns: readonly string[]): boolean {
  const normalized = normalizeValue(value);
  return patterns.some((pattern) => normalized.includes(normalizeValue(pattern)));
}

function normalizeValue(value: string | undefined): string {
  return value?.normalize("NFKC").trim().toLocaleLowerCase() ?? "";
}

const sourceMaterialPatterns: Record<DiscoverySourceMaterial, readonly string[]> = {
  original: ["original", "原创", "オリジナル"],
  manga: ["manga", "漫画"],
  lightNovel: ["light_novel", "light novel", "轻小说", "ライトノベル"],
  game: ["video_game", "game", "游戏", "ゲーム"],
  other: ["novel", "visual_novel", "web_novel", "book", "other", "小说", "其他"]
};

const genrePatterns: Record<DiscoveryGenre, readonly string[]> = {
  action: ["action", "动作", "热血"],
  fantasy: ["fantasy", "奇幻", "魔法"],
  sciFi: ["sci-fi", "science fiction", "科幻"],
  sliceOfLife: ["slice of life", "日常"],
  mystery: ["mystery", "悬疑", "推理"],
  comedy: ["comedy", "搞笑", "喜剧"]
};

const demographicPatterns: Record<DiscoveryDemographic, readonly string[]> = {
  shounen: ["shounen", "少年"],
  shoujo: ["shoujo", "少女"],
  seinen: ["seinen", "青年"],
  josei: ["josei", "女性"],
  kids: ["kids", "儿童", "子供"]
};

const regionPatterns: Record<Exclude<DiscoveryRegion, "other">, readonly string[]> = {
  japan: ["jp", "japan", "日本"],
  china: ["cn", "china", "中国", "大陆"],
  korea: ["kr", "korea", "韩国"],
  western: ["us", "gb", "fr", "de", "usa", "europe", "美国", "英国", "法国", "德国", "欧美"]
};
