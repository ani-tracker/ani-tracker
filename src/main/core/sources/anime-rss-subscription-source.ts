import type { AnimeRssSubscriptionSource, ReleaseSource } from "@shared/contracts";

/** 判断下载源是否实现单番 RSS 订阅能力。 */
export function isAnimeRssSubscriptionSource(source: ReleaseSource): source is AnimeRssSubscriptionSource {
  const candidate = source as Partial<AnimeRssSubscriptionSource>;
  return typeof candidate.buildAnimeRssSubscription === "function"
    && typeof candidate.fetchAnimeRssSubscription === "function";
}
