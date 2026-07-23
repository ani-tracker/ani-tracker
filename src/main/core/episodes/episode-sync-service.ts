import type { Episode, MyAnime, Release } from "@shared/domain";
import { logger } from "../logger";
import type { AppRepository } from "../repositories/app-repository";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_METADATA_EPISODES = 2_000;
const MAX_RELEASE_RANGE_EPISODES = 200;

interface EpisodeSeed {
  episodeNo: number;
  airTime?: string;
  hasRelease: boolean;
}

export interface EpisodeSyncResult {
  animeId: string;
  createdCount: number;
  updatedCount: number;
  promotedCount: number;
  totalCount: number;
}

export interface EpisodeSyncServiceOptions {
  now?: () => Date;
}

/** 根据番剧元数据和本地资源缓存幂等补齐单集记录。 */
export class EpisodeSyncService {
  constructor(
    private readonly repository: AppRepository,
    private readonly options: EpisodeSyncServiceOptions = {}
  ) {}

  /** 同步单部追番，保留已有单集标识、人工时间和生命周期状态。 */
  async sync(item: MyAnime, discoveredReleases: readonly Release[] = []): Promise<EpisodeSyncResult> {
    const [existingEpisodes, cachedReleases] = await Promise.all([
      this.repository.listEpisodes(item.anime.id),
      this.repository.listCachedReleases({ animeId: item.anime.id, limit: 2_000 })
    ]);
    const now = this.options.now?.() ?? new Date();
    const seeds = buildEpisodeSeeds(item, [...cachedReleases, ...discoveredReleases]);
    const existingByNumber = new Map(existingEpisodes.map((episode) => [episode.episodeNo, episode]));
    let createdCount = 0;
    let updatedCount = 0;
    let promotedCount = 0;

    for (const seed of seeds) {
      const existing = existingByNumber.get(seed.episodeNo);
      const shouldBeAired = seed.hasRelease || isPastOrNow(seed.airTime, now);
      if (!existing) {
        const created: Episode = {
          id: createEpisodeId(item.anime.id, seed.episodeNo),
          animeId: item.anime.id,
          episodeNo: seed.episodeNo,
          status: shouldBeAired ? "aired" : "upcoming",
          airTime: seed.airTime
        };
        await this.repository.upsertEpisode(created);
        existingByNumber.set(seed.episodeNo, created);
        createdCount += 1;
        continue;
      }

      const nextStatus = existing.status === "upcoming" && shouldBeAired ? "aired" : existing.status;
      const nextAirTime = existing.airTime ?? seed.airTime;
      if (nextStatus === existing.status && nextAirTime === existing.airTime) {
        continue;
      }

      const updated = { ...existing, status: nextStatus, airTime: nextAirTime };
      await this.repository.upsertEpisode(updated);
      existingByNumber.set(seed.episodeNo, updated);
      updatedCount += 1;
      if (existing.status === "upcoming" && nextStatus === "aired") {
        promotedCount += 1;
      }
    }

    const result: EpisodeSyncResult = {
      animeId: item.anime.id,
      createdCount,
      updatedCount,
      promotedCount,
      totalCount: existingByNumber.size
    };
    if (createdCount > 0 || updatedCount > 0) {
      logger.info("追番单集同步完成", {
        ...result,
        animeTitle: item.anime.title,
        metadataEpisodeCount: item.anime.detail?.episodeCount,
        discoveredReleaseCount: discoveredReleases.length,
        cachedReleaseCount: cachedReleases.length
      });
    }
    return result;
  }
}

/** 汇总元数据集数、播出时间和资源覆盖集数。 */
function buildEpisodeSeeds(item: MyAnime, releases: readonly Release[]): EpisodeSeed[] {
  const seeds = new Map<number, EpisodeSeed>();
  const episodeCount = normalizeMetadataEpisodeCount(item.anime.detail?.episodeCount);
  const resolveAirTime = createAirTimeResolver(item);

  for (let episodeNo = 1; episodeNo <= episodeCount; episodeNo += 1) {
    seeds.set(episodeNo, {
      episodeNo,
      airTime: resolveAirTime(episodeNo),
      hasRelease: false
    });
  }

  for (const release of releases) {
    const episodeNumbers = resolveReleaseEpisodeNumbers(release);
    for (const episodeNo of episodeNumbers) {
      const current = seeds.get(episodeNo);
      seeds.set(episodeNo, {
        episodeNo,
        airTime: current?.airTime ?? resolveAirTime(episodeNo),
        hasRelease: true
      });
    }
  }

  return [...seeds.values()].sort((left, right) => left.episodeNo - right.episodeNo);
}

/** 创建按周计算的单集播出时间解析器。 */
function createAirTimeResolver(item: MyAnime): (episodeNo: number) => string | undefined {
  const nextAiringAtMs = Date.parse(item.anime.detail?.nextAiringAt ?? "");
  const nextAiringEpisodeNo = normalizeEpisodeNo(item.anime.detail?.nextAiringEpisodeNo);
  if (Number.isFinite(nextAiringAtMs) && nextAiringEpisodeNo && Number.isSafeInteger(nextAiringEpisodeNo)) {
    return (episodeNo) => new Date(nextAiringAtMs + (episodeNo - nextAiringEpisodeNo) * WEEK_MS).toISOString();
  }

  const premiereAtMs = resolvePremiereAtMs(item);
  if (premiereAtMs === undefined) {
    return () => undefined;
  }
  return (episodeNo) => new Date(premiereAtMs + (episodeNo - 1) * WEEK_MS).toISOString();
}

/** 将首播日期和节目时区转换为 UTC 时间。 */
function resolvePremiereAtMs(item: MyAnime): number | undefined {
  const dateMatch = item.anime.premiereDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    return undefined;
  }
  const [, yearText, monthText, dayText] = dateMatch;
  const [hourText, minuteText] = (item.anime.detail?.broadcast?.time ?? "00:00").split(":");
  const parts = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText)
  };
  const utcFallback = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  if (!Number.isFinite(utcFallback)) {
    return undefined;
  }

  const timeZone = item.anime.detail?.broadcast?.timezone;
  if (!timeZone) {
    return utcFallback;
  }
  try {
    return zonedDateTimeToUtc(parts, timeZone);
  } catch (error) {
    logger.warn("追番单集同步时区无效，已按 UTC 计算", {
      animeId: item.anime.id,
      timeZone,
      message: error instanceof Error ? error.message : String(error)
    });
    return utcFallback;
  }
}

/** 将指定时区的墙上时间换算为 UTC 毫秒。 */
function zonedDateTimeToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string
): number {
  const targetMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  let utcMs = targetMs;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = Object.fromEntries(
      formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value])
    );
    const observedMs = Date.UTC(
      Number(observed.year),
      Number(observed.month) - 1,
      Number(observed.day),
      Number(observed.hour),
      Number(observed.minute)
    );
    utcMs += targetMs - observedMs;
  }
  return utcMs;
}

/** 读取资源覆盖的单集编号，并限制异常范围资源的展开规模。 */
function resolveReleaseEpisodeNumbers(release: Release): number[] {
  const episodeNo = normalizeEpisodeNo(release.episodeNo);
  if (episodeNo) {
    return [episodeNo];
  }

  const start = normalizeEpisodeNo(release.episodeRange?.start);
  const end = normalizeEpisodeNo(release.episodeRange?.end);
  if (!start || !end || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    return [];
  }
  if (end - start + 1 > MAX_RELEASE_RANGE_EPISODES) {
    return [];
  }
  return Array.from({ length: end - start + 1 }, (_value, index) => start + index);
}

/** 规范化元数据总集数并限制异常数据的写入规模。 */
function normalizeMetadataEpisodeCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, MAX_METADATA_EPISODES) : 0;
}

/** 规范化资源集数，保留 OVA 等小数集编号。 */
function normalizeEpisodeNo(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value! > 0 ? value : undefined;
}

/** 判断计划播出时间是否已经到达。 */
function isPastOrNow(value: string | undefined, now: Date): boolean {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

/** 为自动同步的单集生成稳定标识。 */
function createEpisodeId(animeId: string, episodeNo: number): string {
  return `episode-${animeId}-${String(episodeNo).replace(".", "-")}`;
}
