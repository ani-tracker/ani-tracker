import { CalendarDays, Eye, Library, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CachedImage } from "@/components/cached-image";
import {
  groupMyAnimeBySeason,
  type MyAnimeSeasonGroup
} from "@/features/my-anime/my-anime-list";
import { WatchProgressDisplay } from "@/features/my-anime/watch-progress-display";
import { FilterToolbar, Page, PageHeader, PageHeading } from "@/components/page-layout";
import { WorkbenchSheet } from "@/components/workbench-sheet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { appApi } from "@/lib/api";
import { formatMonth, formatPercent } from "@/lib/format";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
import type { AnimeWatchProgress } from "@shared/contracts";
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

type AnimeFilter = "all" | MyAnime["status"];

interface RemoteDownloadSummary {
  active: number;
  completed: number;
  linked: number;
}

const animeFilters: Array<{ label: string; value: AnimeFilter }> = [
  { label: "全部", value: "all" },
  { label: "在追", value: "watching" },
  { label: "想看", value: "planned" },
  { label: "已完成", value: "completed" },
  { label: "暂停", value: "paused" },
  { label: "已弃", value: "dropped" }
];

interface RemoteMyAnimePageProps {
  onOpenAnimeDetail?: (animeId: string) => void;
}

/** 渲染远程客户端的追番列表与剧集详情。 */
export function RemoteMyAnimePage({ onOpenAnimeDetail }: RemoteMyAnimePageProps = {}) {
  const [items, setItems] = useState<MyAnime[]>([]);
  const [watchProgress, setWatchProgress] = useState<Record<string, AnimeWatchProgress>>({});
  const [fansubs, setFansubs] = useState<FansubGroup[]>([]);
  const [downloadTasks, setDownloadTasks] = useState<DownloadTask[]>([]);
  const [selectedItem, setSelectedItem] = useState<MyAnime | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodePreferences, setEpisodePreferences] = useState<EpisodePreference[]>([]);
  const [filter, setFilter] = useState<AnimeFilter>("all");
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fansubNames = useMemo(() => new Map(fansubs.map((group) => [group.id, group.name])), [fansubs]);
  const visibleItems = useMemo(
    () => filter === "all" ? items : items.filter((item) => item.status === filter),
    [filter, items]
  );
  const groups = useMemo(() => groupMyAnimeBySeason(visibleItems), [visibleItems]);
  const downloadSummaries = useMemo(
    () => new Map(items.map((item) => [item.anime.id, summarizeDownloads(downloadTasks, item.anime.id)])),
    [downloadTasks, items]
  );

  /** 在新标签页打开独立播放器，使播放生命周期与追番详情解耦。 */
  const openPlayback = (task: DownloadTask): void => {
    const playerUrl = new URL(`/player/${encodeURIComponent(task.id)}`, window.location.origin);
    window.open(playerUrl, "_blank", "noopener,noreferrer");
    console.info("[remote] 已打开独立播放器标签页", { taskId: task.id });
  };

  useEffect(() => {
    let active = true;
    Promise.all([
      appApi.listMyAnime(),
      appApi.listFansubs(),
      appApi.listDownloads(),
      appApi.listMyAnimeWatchProgress()
    ])
      .then(([animeItems, groups, downloads, progressItems]) => {
        if (!active) return;
        setItems(animeItems);
        setFansubs(groups);
        setDownloadTasks(downloads);
        setWatchProgress(Object.fromEntries(progressItems.map((progress) => [progress.animeId, progress])));
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
    /** 从独立播放标签返回时读取服务端最新观看进度。 */
    const refreshWatchProgress = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void appApi.listMyAnimeWatchProgress()
        .then((progressItems) => {
          if (active) {
            setWatchProgress(Object.fromEntries(progressItems.map((progress) => [progress.animeId, progress])));
          }
        })
        .catch((caught) => {
          console.warn("[remote] 自动刷新观看进度失败", { error: caught });
        });
    };

    window.addEventListener("focus", refreshWatchProgress);
    document.addEventListener("visibilitychange", refreshWatchProgress);
    return () => {
      active = false;
      window.removeEventListener("focus", refreshWatchProgress);
      document.removeEventListener("visibilitychange", refreshWatchProgress);
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
    return <RemoteMyAnimeSkeleton />;
  }

  return (
    <Page>
      <PageHeader>
        <PageHeading
          description="按季度查看追番状态、观看与下载情况。"
          title="我的追番"
        />
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>追番数据读取失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <FilterToolbar>
        <Tabs className="min-w-0 flex-1" value={filter} onValueChange={(value) => setFilter(value as AnimeFilter)}>
          <TabsList className="grid h-auto w-full grid-cols-3 sm:w-fit sm:grid-cols-6" aria-label="筛选追番状态">
            {animeFilters.map((item) => (
              <TabsTrigger className="min-h-11 min-w-0 px-2 sm:min-h-9" key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">显示 {visibleItems.length} / {items.length}</span>
      </FilterToolbar>

      {groups.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-7">
          {groups.map((group) => (
            <RemoteAnimeSeasonGroup
              downloadSummaries={downloadSummaries}
              group={group}
              key={group.key}
              onOpen={setSelectedItem}
              onOpenAnimeDetail={onOpenAnimeDetail}
              watchProgress={watchProgress}
            />
          ))}
        </div>
      ) : (
        <Empty className="min-h-72">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarDays /></EmptyMedia>
            <EmptyTitle>{items.length ? "没有匹配的追番" : "暂无追番"}</EmptyTitle>
            <EmptyDescription>{items.length ? "请选择其他追番状态。" : "桌面端当前还没有追番记录。"}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {selectedItem && (
        <RemoteAnimeDetailsSheet
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
    </Page>
  );
}

/** 渲染单个季度下的远程追番紧凑列表。 */
function RemoteAnimeSeasonGroup({
  group,
  downloadSummaries,
  onOpen,
  onOpenAnimeDetail,
  watchProgress
}: {
  group: MyAnimeSeasonGroup;
  downloadSummaries: Map<string, RemoteDownloadSummary>;
  onOpen: (item: MyAnime) => void;
  onOpenAnimeDetail?: (animeId: string) => void;
  watchProgress: Record<string, AnimeWatchProgress>;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-end justify-between gap-3">
        <h2 className="text-sm font-semibold">{group.label}</h2>
        <span className="text-xs text-muted-foreground">{group.items.length} 部</span>
      </div>
      <div className="min-w-0 overflow-hidden rounded-md border bg-card">
        {group.items.map((item) => (
          <RemoteAnimeRow
            item={item}
            key={item.id}
            onOpen={() => onOpen(item)}
            onOpenAnimeDetail={() => onOpenAnimeDetail?.(item.anime.id)}
            summary={downloadSummaries.get(item.anime.id) ?? { active: 0, completed: 0, linked: 0 }}
            watchProgress={watchProgress[item.anime.id] ?? {
              animeId: item.anime.id,
              watchedEpisodeCount: 0,
              totalEpisodeCount: item.anime.detail?.episodeCount ?? 0
            }}
          />
        ))}
      </div>
    </section>
  );
}

/** 渲染远程追番条目，只开放观看进度和只读剧集入口。 */
function RemoteAnimeRow({
  item,
  summary,
  onOpen,
  onOpenAnimeDetail,
  watchProgress
}: {
  item: MyAnime;
  summary: RemoteDownloadSummary;
  onOpen: () => void;
  onOpenAnimeDetail: () => void;
  watchProgress: AnimeWatchProgress;
}) {
  const titleDisplay = resolveAnimeTitleDisplay(item.anime);

  return (
    <article className="flex min-w-0 gap-3 border-b p-3 last:border-b-0 sm:gap-4">
      <button
        aria-label={`查看${titleDisplay.title}详情`}
        className="aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-20"
        onClick={onOpenAnimeDetail}
        type="button"
      >
        {item.anime.coverUrl ? (
          <CachedImage
            alt={titleDisplay.title}
            className="size-full object-cover"
            loading="lazy"
            sourceUrl={item.anime.coverUrl}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Library />
          </div>
        )}
      </button>

      <div className="grid min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(13rem,0.65fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <button
              className="min-w-0 truncate text-left text-sm font-semibold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onOpenAnimeDetail}
              title={titleDisplay.title}
              type="button"
            >
              {titleDisplay.title}
            </button>
            <Badge className="shrink-0" tone="primary">{animeStatusText[item.status]}</Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={titleDisplay.subtitle ?? "无原名"}>
            {titleDisplay.subtitle ?? "无原名"}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge>{formatMonth(item.anime.premiereYear, item.anime.premiereMonth)}</Badge>
            {item.preferredResolution && <Badge>{item.preferredResolution}</Badge>}
            {item.preferredCodec && <Badge tone="blue">{item.preferredCodec}</Badge>}
          </div>
        </div>

        <div className="min-w-0">
          <WatchProgressDisplay progress={watchProgress} />
          <div className="mt-3 flex items-end justify-between gap-3 text-xs">
            <span className="text-muted-foreground">下载进度</span>
            <span className="font-medium tabular-nums">{summary.completed} / {summary.linked}</span>
          </div>
          <Progress className="mt-2 h-1.5" value={summary.linked ? summary.completed / summary.linked : 0} />
          <div className="mt-2 text-xs text-muted-foreground">
            已完成 {summary.completed} · 下载中 {summary.active}
          </div>
        </div>

        <Button className="w-full lg:w-auto" onClick={onOpen} variant="outline">
          <Eye data-icon="inline-start" />
          查看剧集
        </Button>
      </div>
    </article>
  );
}

/** 渲染单部追番的远程只读详情工作台。 */
function RemoteAnimeDetailsSheet({
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
    <WorkbenchSheet
      description={titleDisplay.subtitle ?? "远程只读剧集状态"}
      headerContent={(
        <div className="flex flex-wrap gap-2">
          <Badge tone="primary">{animeStatusText[item.status]}</Badge>
          <Badge>{defaultFansubName}</Badge>
          {item.preferredResolution && <Badge>{item.preferredResolution}</Badge>}
          {item.preferredCodec && <Badge tone="blue">{item.preferredCodec}</Badge>}
        </div>
      )}
      onClose={onClose}
      title={titleDisplay.title}
    >
      {loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="正在加载追番详情">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : episodes.length > 0 ? (
        <div className="flex min-w-0 flex-col">
          {episodes.map((episode, index) => {
            const preference = episodePreferences.find((entry) => entry.episodeId === episode.id);
            const fansubName = preference?.fansubGroupId
              ? (fansubNames.get(preference.fansubGroupId) ?? preference.fansubGroupId)
              : defaultFansubName;
            const task = findEpisodeDownload(downloadTasks, episode);
            return (
              <div key={episode.id}>
                <article className="flex min-w-0 flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-sm font-medium">
                      第 {episode.episodeNo} 集{episode.title ? ` · ${episode.title}` : ""}
                    </h3>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>字幕组：{fansubName}</span>
                      {task && <span>{downloadStatusText[task.status]} · {formatPercent(task.progress)}</span>}
                    </div>
                    {task && <Progress className="mt-3" value={task.progress} />}
                  </div>
                  <div className="flex shrink-0 items-center justify-between gap-2 sm:flex-col sm:items-end">
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
                </article>
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
    </WorkbenchSheet>
  );
}

/** 渲染远程追番页加载中的结构化占位状态。 */
function RemoteMyAnimeSkeleton() {
  return (
    <Page aria-busy="true" aria-label="正在加载追番列表">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="h-12 w-full" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </Page>
  );
}

/** 合并全局与番剧专属字幕组，避免详情中出现重复项。 */
function mergeFansubGroups(current: FansubGroup[], incoming: FansubGroup[]): FansubGroup[] {
  return Array.from(new Map([...current, ...incoming].map((group) => [group.id, group])).values());
}

/** 统计指定番剧关联下载的完成、活动和关联集数。 */
function summarizeDownloads(tasks: DownloadTask[], animeId: string): RemoteDownloadSummary {
  const animeTasks = tasks.filter((task) => task.animeId === animeId);
  return {
    completed: countEpisodes(animeTasks.filter((task) => task.status === "completed" || task.status === "seeding")),
    active: countEpisodes(animeTasks.filter((task) => !["completed", "seeding", "error", "missing_files"].includes(task.status))),
    linked: countEpisodes(animeTasks)
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
