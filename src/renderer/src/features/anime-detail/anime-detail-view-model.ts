import type { AnimeDetailResult } from "@shared/contracts";
import type { Anime, AnimeAiringStatus, AnimeBroadcastSchedule, AnimeFormat, AnimeStatus } from "@shared/domain";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";

const formatLabels: Record<AnimeFormat, string> = {
  tv: "TV 动画",
  movie: "剧场版",
  ova: "OVA",
  ona: "网络动画",
  special: "特别篇",
  music: "音乐动画",
  unknown: "类型未知"
};

const airingStatusLabels: Record<AnimeAiringStatus, string> = {
  upcoming: "即将开播",
  airing: "放送中",
  finished: "已完结",
  hiatus: "暂停放送",
  cancelled: "已取消",
  unknown: "状态未知"
};

const trackerStatusLabels: Record<AnimeStatus, string> = {
  watching: "在追",
  planned: "想看",
  completed: "已完成",
  paused: "暂停",
  dropped: "已弃"
};

const sourceLabels: Record<string, string> = {
  bangumi: "Bangumi",
  anilist: "AniList",
  mikan: "Mikan",
  mal: "MyAnimeList"
};

export interface AnimeDetailExternalLink {
  key: string;
  label: string;
  value: string;
  url: string;
}

export interface AnimeDetailViewModel {
  title: string;
  subtitle?: string;
  aliases: string[];
  followed: boolean;
  trackerStatus?: string;
  format?: string;
  airingStatus?: string;
  premiere: string;
  endDate?: string;
  nextAiring?: string;
  broadcast?: string;
  watchedCount: number;
  downloadedCount: number;
  totalEpisodes?: number;
  progress?: number;
  externalLinks: AnimeDetailExternalLink[];
  metadataSources: string[];
}

/** 将详情聚合结果转换为无业务分支的页面显示模型。 */
export function buildAnimeDetailViewModel(result: AnimeDetailResult): AnimeDetailViewModel {
  const titleDisplay = resolveAnimeTitleDisplay(result.anime);
  const watchedCount = result.episodes.filter((episode) => episode.status === "watched").length;
  const downloadedCount = result.episodes.filter((episode) =>
    episode.status === "downloaded" || episode.status === "watched"
  ).length;
  const totalEpisodes = result.anime.detail?.episodeCount;

  return {
    title: titleDisplay.title,
    subtitle: titleDisplay.subtitle,
    aliases: titleDisplay.aliases.map((alias) => alias.alias),
    followed: Boolean(result.myAnime),
    trackerStatus: result.myAnime ? trackerStatusLabels[result.myAnime.status] : undefined,
    format: result.anime.detail?.format && result.anime.detail.format !== "unknown"
      ? formatLabels[result.anime.detail.format]
      : undefined,
    airingStatus: result.anime.detail?.airingStatus && result.anime.detail.airingStatus !== "unknown"
      ? airingStatusLabels[result.anime.detail.airingStatus]
      : undefined,
    premiere: formatPremiere(result.anime),
    endDate: formatDate(result.anime.detail?.endDate),
    nextAiring: formatDateTime(result.anime.detail?.nextAiringAt),
    broadcast: formatBroadcast(result.anime.detail?.broadcast),
    watchedCount,
    downloadedCount,
    totalEpisodes,
    progress: totalEpisodes ? Math.min(1, watchedCount / totalEpisodes) : undefined,
    externalLinks: buildExternalLinks(result.anime),
    metadataSources: (result.anime.detail?.metadataSources ?? []).map((source) => sourceLabels[source] ?? source)
  };
}

/** 构造公开元数据详情页链接白名单。 */
export function buildExternalLinks(anime: Anime): AnimeDetailExternalLink[] {
  return Object.entries(anime.externalIds).flatMap(([key, value]) => {
    const url = buildExternalUrl(key, value);
    return url ? [{ key, label: sourceLabels[key] ?? key, value, url }] : [];
  });
}

function buildExternalUrl(key: string, value: string): string | undefined {
  const encoded = encodeURIComponent(value);
  if (key === "bangumi") return `https://bgm.tv/subject/${encoded}`;
  if (key === "anilist") return `https://anilist.co/anime/${encoded}`;
  if (key === "mikan") return `https://mikanani.me/Home/Bangumi/${encoded}`;
  if (key === "mal") return `https://myanimelist.net/anime/${encoded}`;
  return undefined;
}

function formatPremiere(anime: Anime): string {
  return formatDate(anime.premiereDate) ?? `${anime.premiereYear} 年 ${anime.premiereMonth} 月`;
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function formatDateTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatBroadcast(value: AnimeBroadcastSchedule | undefined): string | undefined {
  if (!value) return undefined;
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const parts = [
    value.weekday !== undefined ? weekdays[value.weekday] : undefined,
    value.time,
    value.timezone
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}
