import type { Release } from "@shared/domain";
import {
  MAX_RELEASE_SOURCE_FETCH_LIMIT,
  normalizeReleaseSourceFetchLimit,
  normalizeReleaseSourceResultLimit
} from "./source-query";

export interface ReleasePageRequest {
  page: number;
  offset: number;
  limit: number;
}

export interface ReleasePageResult {
  items: Release[];
  hasNextPage?: boolean;
}

/** 按每页最多 50 条串行累计来源结果，并在空页、短页或重复页时停止。 */
export async function collectReleasePages(
  requestedLimit: number | undefined,
  fetchPage: (request: ReleasePageRequest) => Promise<ReleasePageResult>
): Promise<Release[]> {
  const targetLimit = normalizeReleaseSourceResultLimit(requestedLimit);
  const maximumPageCount = Math.ceil(targetLimit / MAX_RELEASE_SOURCE_FETCH_LIMIT);
  const releases: Release[] = [];
  const releaseIds = new Set<string>();

  for (let page = 1; page <= maximumPageCount && releases.length < targetLimit; page += 1) {
    const pageLimit = normalizeReleaseSourceFetchLimit(targetLimit - releases.length);
    const pageResult = await fetchPage({
      page,
      offset: (page - 1) * MAX_RELEASE_SOURCE_FETCH_LIMIT,
      limit: pageLimit
    });
    const pageItems = pageResult.items.slice(0, pageLimit);
    let addedCount = 0;

    for (const release of pageItems) {
      if (releaseIds.has(release.id)) {
        continue;
      }
      releaseIds.add(release.id);
      releases.push(release);
      addedCount += 1;
    }

    if (
      pageResult.hasNextPage === false
      || pageItems.length === 0
      || addedCount === 0
      || (pageResult.hasNextPage !== true && pageResult.items.length < pageLimit)
    ) {
      break;
    }
  }

  return releases.slice(0, targetLimit);
}
