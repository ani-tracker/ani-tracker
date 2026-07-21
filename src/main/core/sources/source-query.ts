export const MAX_RELEASE_SOURCE_FETCH_LIMIT = 50;
export const MAX_RELEASE_SOURCE_RESULT_LIMIT = 200;

/** 将单个下载源的单页请求数量限制在站点可接受范围内。 */
export function normalizeReleaseSourceFetchLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return MAX_RELEASE_SOURCE_FETCH_LIMIT;
  }

  return Math.max(1, Math.min(MAX_RELEASE_SOURCE_FETCH_LIMIT, Math.trunc(limit)));
}

/** 规范化单个下载源需要累计返回的目标数量，避免无界翻页。 */
export function normalizeReleaseSourceResultLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return MAX_RELEASE_SOURCE_FETCH_LIMIT;
  }

  return Math.max(1, Math.min(MAX_RELEASE_SOURCE_RESULT_LIMIT, Math.trunc(limit)));
}
