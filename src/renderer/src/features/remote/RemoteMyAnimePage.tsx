import { CalendarDays, Eye, Library, Play, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { CachedImage } from "@/components/cached-image";
import { appApi } from "@/lib/api";
import { formatMonth, formatPercent } from "@/lib/format";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
import type { DownloadTask, Episode, EpisodePreference, FansubGroup, MyAnime } from "@shared/domain";

const animeStatusText: Record<MyAnime["status"], string> = {
  watching: "在追",
  planned: "想看",
  completed: "已完成",
  paused: "暂停",
  dropped: "已弃"
};

const episodeStatusText: Record<Episode["status"], string> = {
  upcoming: "未开播",
  aired: "已开播",
  matched: "已匹配",
  downloading: "下载中",
  downloaded: "已下载",
  watched: "已观看"
};

const downloadStatusText: Record<DownloadTask["status"], string> = {
  queued: "排队中",
  fetching_metadata: "获取元数据",
  downloading: "下载中",
  stalled: "等待连接",
  paused: "已暂停",
  checking: "校验中",
  moving: "移动文件",
  completed: "已完成",
  seeding: "做种中",
  error: "错误",
  missing_files: "文件缺失"
};

/** 渲染远程客户端的追番列表与只读剧集详情。 */
export function RemoteMyAnimePage() {
  const [items, setItems] = useState<MyAnime[]>([]);
  const [fansubs, setFansubs] = useState<FansubGroup[]>([]);
  const [downloadTasks, setDownloadTasks] = useState<DownloadTask[]>([]);
  const [selectedItem, setSelectedItem] = useState<MyAnime | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodePreferences, setEpisodePreferences] = useState<EpisodePreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fansubNames = useMemo(() => new Map(fansubs.map((group) => [group.id, group.name])), [fansubs]);

  /** 在新标签页打开独立播放器，使播放生命周期与追番详情解耦。 */
  const openPlayback = (task: DownloadTask): void => {
    const playerUrl = new URL(`/player/${encodeURIComponent(task.id)}`, window.location.origin);
    window.open(playerUrl, "_blank", "noopener,noreferrer");
    console.info("[remote] 已打开独立播放器标签页", { taskId: task.id });
  };

  useEffect(() => {
    let active = true;
    Promise.all([appApi.listMyAnime(), appApi.listFansubs(), appApi.listDownloads()])
      .then(([animeItems, groups, downloads]) => {
        if (!active) return;
        setItems(animeItems);
        setFansubs(groups);
        setDownloadTasks(downloads);
        setError(null);
        console.info("[remote] 追番列表读取完成", { itemCount: animeItems.length, downloadCount: downloads.length });
      })
      .catch((caught) => {
        if (active) {
          console.error("[remote] 追番列表读取失败", { error: caught });
          setError(caught instanceof Error ? caught.message : "加载追番数据失败");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!selectedItem) {
      setEpisodes([]);
      setEpisodePreferences([]);
      return;
    }

    setDetailsLoading(true);
    Promise.all([
      appApi.listEpisodes(selectedItem.anime.id),
      appApi.listEpisodePreferences(selectedItem.anime.id),
      appApi.listFansubs(selectedItem.anime.id),
      appApi.listDownloads()
    ])
      .then(([loadedEpisodes, preferences, groups, downloads]) => {
        if (!active) return;
        setEpisodes(loadedEpisodes);
        setEpisodePreferences(preferences);
        setFansubs((current) => mergeFansubGroups(current, groups));
        setDownloadTasks(downloads);
        setError(null);
        console.info("[remote] 追番详情读取完成", {
          animeId: selectedItem.anime.id,
          episodeCount: loadedEpisodes.length
        });
      })
      .catch((caught) => {
        if (active) {
          console.error("[remote] 追番详情读取失败", { animeId: selectedItem.anime.id, error: caught });
          setError(caught instanceof Error ? caught.message : "加载追番详情失败");
        }
      })
      .finally(() => {
        if (active) setDetailsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedItem]);

  if (loading) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="正在加载追番列表">
        <Skeleton className="h-8 w-32" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-normal">我的追番</h1>
        <p className="mt-1 text-sm text-muted-foreground">查看追番状态、剧集进度和关联下载。</p>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>追番数据读取失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {items.length > 0 ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const titleDisplay = resolveAnimeTitleDisplay(item.anime);
            const summary = summarizeDownloads(downloadTasks, item.anime.id);
            return (
              <Card key={item.id} className="flex min-w-0 flex-col overflow-hidden">
                {item.anime.coverUrl ? (
                  <CachedImage
                    alt={titleDisplay.title}
                    className="aspect-video w-full bg-muted object-cover"
                    loading="lazy"
                    sourceUrl={item.anime.coverUrl}
                  />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center bg-muted text-muted-foreground">
                    <Library />
                  </div>
                )}
                <CardHeader>
                  <CardTitle className="truncate" title={titleDisplay.title}>{titleDisplay.title}</CardTitle>
                  <CardDescription className="truncate" title={titleDisplay.subtitle}>
                    {titleDisplay.subtitle ?? formatMonth(item.anime.premiereYear, item.anime.premiereMonth)}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-wrap content-start gap-2">
                  <Badge>{animeStatusText[item.status]}</Badge>
                  <Badge>{summary.completed} 集完成</Badge>
                  <Badge tone={summary.active > 0 ? "blue" : "neutral"}>{summary.active} 集下载中</Badge>
                  {item.preferredResolution && <Badge>{item.preferredResolution}</Badge>}
                  {item.preferredCodec && <Badge tone="blue">{item.preferredCodec}</Badge>}
                </CardContent>
                <CardFooter>
                  <Button className="w-full" variant="outline" onClick={() => setSelectedItem(item)}>
                    <Eye data-icon="inline-start" />
                    查看详情
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      ) : (
        <Empty className="min-h-72">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarDays /></EmptyMedia>
            <EmptyTitle>暂无追番</EmptyTitle>
            <EmptyDescription>桌面端当前还没有追番记录。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {selectedItem && (
        <RemoteAnimeDetailsDrawer
          downloadTasks={downloadTasks}
          episodePreferences={episodePreferences}
          episodes={episodes}
          fansubNames={fansubNames}
          item={selectedItem}
          loading={detailsLoading}
          onClose={() => setSelectedItem(null)}
          onPlay={openPlayback}
        />
      )}
    </div>
  );
}

/** 渲染单部追番的远程只读详情抽屉。 */
function RemoteAnimeDetailsDrawer({
  item,
  episodes,
  episodePreferences,
  downloadTasks,
  fansubNames,
  loading,
  onClose,
  onPlay
}: {
  item: MyAnime;
  episodes: Episode[];
  episodePreferences: EpisodePreference[];
  downloadTasks: DownloadTask[];
  fansubNames: Map<string, string>;
  loading: boolean;
  onClose: () => void;
  onPlay: (task: DownloadTask) => void;
}) {
  const titleDisplay = resolveAnimeTitleDisplay(item.anime);
  const defaultFansubName = item.defaultFansubGroupId
    ? (fansubNames.get(item.defaultFansubGroupId) ?? item.defaultFansubGroupId)
    : "未设置默认字幕组";

  return (
    <Drawer ariaLabel="追番详情" className="flex flex-col sm:max-w-2xl" onClose={onClose}>
      <div className="flex items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-normal">{titleDisplay.title}</h2>
          <p className="mt-1 truncate text-sm text-muted-foreground">{titleDisplay.subtitle ?? "剧集状态"}</p>
        </div>
        <Button className="size-11 p-0" variant="ghost" onClick={onClose} aria-label="关闭追番详情" title="关闭追番详情">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="正在加载追番详情">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : episodes.length > 0 ? (
          <div className="flex flex-col">
            {episodes.map((episode, index) => {
              const preference = episodePreferences.find((entry) => entry.episodeId === episode.id);
              const fansubName = preference?.fansubGroupId
                ? (fansubNames.get(preference.fansubGroupId) ?? preference.fansubGroupId)
                : defaultFansubName;
              const task = findEpisodeDownload(downloadTasks, episode);
              return (
                <div key={episode.id}>
                  <div className="flex items-start justify-between gap-3 py-4 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        第 {episode.episodeNo} 集{episode.title ? ` · ${episode.title}` : ""}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>字幕组：{fansubName}</span>
                        {task && <span>{downloadStatusText[task.status]} · {formatPercent(task.progress)}</span>}
                      </div>
                      {task && <Progress className="mt-3" value={task.progress} />}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <Badge tone={episode.status === "watched" || episode.status === "downloaded" ? "green" : "neutral"}>
                        {episodeStatusText[episode.status]}
                      </Badge>
                      {task && isRemotePlayable(task) && (
                        <Button variant="outline" onClick={() => onPlay(task)}>
                          <Play data-icon="inline-start" />
                          播放
                        </Button>
                      )}
                    </div>
                  </div>
                  {index < episodes.length - 1 && <Separator />}
                </div>
              );
            })}
          </div>
        ) : (
          <Empty className="min-h-56">
            <EmptyHeader>
              <EmptyMedia variant="icon"><CalendarDays /></EmptyMedia>
              <EmptyTitle>暂无剧集记录</EmptyTitle>
              <EmptyDescription>当前追番还没有剧集状态。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </Drawer>
  );
}

/** 合并全局与番剧专属字幕组，避免详情中出现重复项。 */
function mergeFansubGroups(current: FansubGroup[], incoming: FansubGroup[]): FansubGroup[] {
  return Array.from(new Map([...current, ...incoming].map((group) => [group.id, group])).values());
}

/** 统计指定番剧关联下载的完成和活动集数。 */
function summarizeDownloads(tasks: DownloadTask[], animeId: string): { completed: number; active: number } {
  const animeTasks = tasks.filter((task) => task.animeId === animeId);
  return {
    completed: countEpisodes(animeTasks.filter((task) => task.status === "completed" || task.status === "seeding")),
    active: countEpisodes(animeTasks.filter((task) => !["completed", "seeding", "error", "missing_files"].includes(task.status)))
  };
}

/** 返回与单集直接关联或集数匹配的下载任务。 */
function findEpisodeDownload(tasks: DownloadTask[], episode: Episode): DownloadTask | undefined {
  return tasks.find((task) => task.episodeId === episode.id)
    ?? tasks.find((task) => task.animeId === episode.animeId && task.episodeNo === episode.episodeNo);
}

/** 统计下载任务中去重后的有效集数。 */
function countEpisodes(tasks: DownloadTask[]): number {
  return new Set(tasks.map((task) => task.episodeNo).filter((value) => value !== undefined)).size;
}

/** 下载文件完整写入后允许远程端请求受控播放会话。 */
function isRemotePlayable(task: DownloadTask): boolean {
  return task.progress >= 1
    || task.status === "completed"
    || task.status === "seeding"
    || task.files.some((file) => file.selected && file.progress >= 1);
}
