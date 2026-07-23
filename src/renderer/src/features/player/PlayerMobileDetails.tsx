import { ChevronDown, ChevronUp, ImageOff } from "lucide-react";
import { useState } from "react";
import { CachedImage } from "@/components/cached-image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import type { RemotePlaybackSession } from "@shared/contracts";
import type { Anime, Episode } from "@shared/domain";
import type { RemotePlaylistItem } from "@/features/remote/remote-player-model";
import { formatPlaybackTime } from "./player-ui-model";

interface PlayerMobileDetailsProps {
  activeItem: RemotePlaylistItem | null;
  anime?: Anime;
  currentTimeSeconds: number;
  episodes: Episode[];
  session: RemotePlaybackSession | null;
}

/** 在竖屏播放器下方展示番剧摘要、媒体规格和可展开简介。 */
export function PlayerMobileDetails({
  activeItem,
  anime,
  currentTimeSeconds,
  episodes,
  session
}: PlayerMobileDetailsProps) {
  const [synopsisOpen, setSynopsisOpen] = useState(false);
  const title = anime?.title ?? activeItem?.task.animeTitle ?? "当前番剧";
  const episode = episodes.find((item) => item.episodeNo === activeItem?.task.episodeNo);
  const summary = anime?.summary?.trim();

  return (
    <section className="px-4 pb-3 pt-4 sm:px-5" aria-labelledby="player-now-playing-title">
      <div className="flex items-start gap-3">
        <div className="flex aspect-[2/3] w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
          {anime?.coverUrl ? (
            <CachedImage alt={title} className="size-full object-cover" sourceUrl={anime.coverUrl} />
          ) : (
            <ImageOff className="text-muted-foreground" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 id="player-now-playing-title" className="line-clamp-2 text-base font-semibold">
              {title}
            </h1>
            <Badge tone="primary-soft">正在播放</Badge>
          </div>
          {anime?.originalTitle && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{anime.originalTitle}</p>
          )}
          <p className="mt-1 text-sm font-medium">
            {formatEpisodeLabel(activeItem?.task.episodeNo)}
            {episode?.title ? ` · ${episode.title}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {activeItem?.task.resolution && <Badge>{activeItem.task.resolution.toUpperCase()}</Badge>}
            {activeItem?.task.normalizedVideoCodec && (
              <Badge>{activeItem.task.normalizedVideoCodec.replace("H.265/", "").replace("H.264/", "")}</Badge>
            )}
            {session && <Badge>{session.mode === "hls" ? "实时转码" : "原文件直传"}</Badge>}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {anime?.premiereYear && <span>{anime.premiereYear}</span>}
        {anime?.detail?.format && <span>{formatAnimeFormat(anime.detail.format)}</span>}
        {(anime?.detail?.episodeCount ?? episodes.length) > 0 && (
          <span>全 {anime?.detail?.episodeCount ?? episodes.length} 集</span>
        )}
        {anime?.rating?.score !== undefined && <span>评分 {anime.rating.score.toFixed(1)}</span>}
        {anime?.detail?.airingStatus && <span>{formatAiringStatus(anime.detail.airingStatus)}</span>}
        {activeItem?.task.fansubName && <span>{activeItem.task.fansubName}</span>}
        {currentTimeSeconds > 0 && <span>已观看 {formatPlaybackTime(currentTimeSeconds)}</span>}
      </div>

      {summary && (
        <Collapsible className="mt-3" open={synopsisOpen} onOpenChange={setSynopsisOpen}>
          <CollapsibleContent forceMount>
            <p className={synopsisOpen ? "text-sm leading-6 text-muted-foreground" : "line-clamp-3 text-sm leading-6 text-muted-foreground"}>
              {summary}
            </p>
          </CollapsibleContent>
          <CollapsibleTrigger asChild>
            <Button className="mt-1 h-auto min-h-0 px-0 py-1 text-xs" variant="ghost">
              {synopsisOpen ? <ChevronUp data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}
              {synopsisOpen ? "收起简介" : "展开简介"}
            </Button>
          </CollapsibleTrigger>
        </Collapsible>
      )}
      <Separator className="mt-3" />
    </section>
  );
}

/** 将当前集数格式化为紧凑中文标签。 */
function formatEpisodeLabel(episodeNo?: number): string {
  return episodeNo === undefined ? "当前视频" : `第 ${String(episodeNo).padStart(2, "0")} 集`;
}

/** 将番剧类型转成界面标签。 */
function formatAnimeFormat(format: NonNullable<Anime["detail"]>["format"]): string {
  return ({ tv: "TV", movie: "电影", ova: "OVA", ona: "ONA", special: "特别篇", music: "音乐", unknown: "未知" })[format ?? "unknown"];
}

/** 将播出状态转成界面标签。 */
function formatAiringStatus(status: NonNullable<Anime["detail"]>["airingStatus"]): string {
  return ({
    upcoming: "未开播",
    airing: "连载中",
    finished: "已完结",
    hiatus: "暂停播出",
    cancelled: "已取消",
    unknown: "状态未知"
  })[status ?? "unknown"];
}
