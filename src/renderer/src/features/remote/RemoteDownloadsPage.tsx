import { Download, Pause, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FilterToolbar,
  MetricItem,
  MetricStrip,
  Page,
  PageActions,
  PageHeader,
  PageHeading
} from "@/components/page-layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { appApi } from "@/lib/api";
import { formatDuration, formatPercent, formatSpeed } from "@/lib/format";
import type { DownloadStatus, DownloadTask, MyAnime } from "@shared/domain";

const downloadStatusText: Record<DownloadStatus, string> = {
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

type DownloadFilter = "all" | "active" | "paused" | "completed" | "error";

interface DownloadGroup {
  key: string;
  title: string;
  tasks: DownloadTask[];
}

const downloadFilters: Array<{ label: string; value: DownloadFilter }> = [
  { label: "全部", value: "all" },
  { label: "进行中", value: "active" },
  { label: "已暂停", value: "paused" },
  { label: "已完成", value: "completed" },
  { label: "异常", value: "error" }
];

const pausableStatuses = new Set<DownloadStatus>([
  "queued",
  "fetching_metadata",
  "downloading",
  "stalled",
  "checking",
  "moving"
]);

/** 渲染远程客户端的下载状态与轻量控制。 */
export function RemoteDownloadsPage() {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [filter, setFilter] = useState<DownloadFilter>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mutatingTaskId, setMutatingTaskId] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visibleTasks = useMemo(() => filterDownloads(tasks, filter), [filter, tasks]);
  const groups = useMemo(() => groupDownloads(visibleTasks, myAnime), [myAnime, visibleTasks]);
  const summary = useMemo(() => summarizeQueue(tasks), [tasks]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setTasks(await appApi.refreshDownloads());
      setUpdatedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setError(null);
    } catch (caught) {
      console.error("[remote] 下载队列刷新失败", { error: caught });
      setError(caught instanceof Error ? caught.message : "刷新下载状态失败");
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([appApi.listDownloads(), appApi.listMyAnime()])
      .then(([downloadTasks, animeItems]) => {
        if (!active) return;
        setTasks(downloadTasks);
        setMyAnime(animeItems);
        setLoading(false);
      })
      .catch((caught) => {
        if (!active) return;
        console.error("[remote] 下载队列读取失败", { error: caught });
        setError(caught instanceof Error ? caught.message : "加载下载队列失败");
        setLoading(false);
      });

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  /** 暂停或继续远程下载任务，并使用服务端结果刷新列表。 */
  async function controlTask(taskId: string, action: "pause" | "resume") {
    setMutatingTaskId(taskId);
    try {
      const updated = action === "pause"
        ? await appApi.pauseDownload(taskId)
        : await appApi.resumeDownload(taskId);
      setTasks(updated);
      setError(null);
      console.info("[remote] 下载任务控制完成", { taskId, action });
    } catch (caught) {
      console.error("[remote] 下载任务控制失败", { taskId, action, error: caught });
      setError(caught instanceof Error ? caught.message : "下载任务操作失败");
    } finally {
      setMutatingTaskId(null);
    }
  }

  if (loading) {
    return <RemoteDownloadsSkeleton />;
  }

  return (
    <Page>
      <PageHeader>
        <PageHeading description="查看实时进度，并对可控制的任务执行暂停或继续。" title="下载队列" />
        <PageActions>
          <Button className="w-full sm:w-auto" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw data-icon="inline-start" />
            {refreshing ? "刷新中" : "刷新状态"}
          </Button>
        </PageActions>
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>下载队列操作失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <MetricStrip className="sm:grid-cols-4">
        <MetricItem label="全部任务" value={tasks.length} />
        <MetricItem label="进行中" value={summary.active} />
        <MetricItem label="实时下载" value={formatSpeed(summary.downloadSpeed)} />
        <MetricItem label="已完成" value={summary.completed} />
      </MetricStrip>

      <FilterToolbar>
        <Tabs className="min-w-0 flex-1" value={filter} onValueChange={(value) => setFilter(value as DownloadFilter)}>
          <TabsList className="grid h-auto w-full grid-cols-5 sm:w-fit" aria-label="筛选下载状态">
            {downloadFilters.map((item) => (
              <TabsTrigger className="min-h-11 min-w-0 px-2 sm:min-h-9" key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">
          {updatedAt ? `更新于 ${updatedAt}` : "等待首次刷新"} · 显示 {visibleTasks.length} / {tasks.length}
        </span>
      </FilterToolbar>

      {groups.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-7">
          {groups.map((group) => (
            <section className="min-w-0" key={group.key}>
              <div className="mb-2 flex min-w-0 items-end justify-between gap-3">
                <h2 className="truncate text-sm font-semibold" title={group.title}>{group.title}</h2>
                <span className="shrink-0 text-xs text-muted-foreground">{group.tasks.length} 个任务</span>
              </div>
              <div className="min-w-0 overflow-hidden rounded-md border bg-card">
                {group.tasks.map((task) => (
                  <RemoteDownloadRow
                    busy={mutatingTaskId === task.id}
                    key={task.id}
                    onControl={(action) => void controlTask(task.id, action)}
                    task={task}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty className="min-h-72">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Download /></EmptyMedia>
            <EmptyTitle>{tasks.length ? "没有匹配的下载任务" : "当前没有下载任务"}</EmptyTitle>
            <EmptyDescription>{tasks.length ? "请选择其他下载状态。" : "桌面端当前没有可管理的下载任务。"}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Page>
  );
}

/** 渲染远程下载任务行及当前状态允许的唯一控制动作。 */
function RemoteDownloadRow({
  task,
  busy,
  onControl
}: {
  task: DownloadTask;
  busy: boolean;
  onControl: (action: "pause" | "resume") => void;
}) {
  const action = resolveControlAction(task.status);

  return (
    <article className="min-w-0 border-b p-3 last:border-b-0 sm:p-4">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {task.episodeNo !== undefined && <Badge tone="blue">第 {task.episodeNo} 集</Badge>}
            <Badge tone={getDownloadStatusTone(task.status)}>{downloadStatusText[task.status]}</Badge>
            <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={task.name}>{task.name}</h3>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>下载 {formatSpeed(task.downloadSpeed)}</span>
            <span>上传 {formatSpeed(task.uploadSpeed)}</span>
            <span>剩余 {formatDuration(task.etaSeconds)}</span>
          </div>
        </div>

        {action && (
          <Button
            className="size-11 shrink-0 p-0 sm:size-9"
            variant="outline"
            aria-label={action === "pause" ? "暂停下载" : "继续下载"}
            title={action === "pause" ? "暂停下载" : "继续下载"}
            disabled={busy}
            onClick={() => onControl(action)}
          >
            {action === "pause" ? <Pause /> : <Play />}
          </Button>
        )}
      </div>
      <div className="mt-4 flex min-w-0 items-center gap-3">
        <Progress value={task.progress} />
        <span className="w-12 shrink-0 text-right text-sm font-medium tabular-nums">{formatPercent(task.progress)}</span>
      </div>
    </article>
  );
}

/** 渲染远程下载页加载中的结构化占位状态。 */
function RemoteDownloadsSkeleton() {
  return (
    <Page aria-busy="true" aria-label="正在加载下载队列">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <MetricStrip className="sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <MetricItem key={index} label={<Skeleton className="h-4 w-16" />} value={<Skeleton className="h-7 w-16" />} />
        ))}
      </MetricStrip>
      <Skeleton className="h-12 w-full" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </Page>
  );
}

/** 根据筛选项返回当前应展示的下载任务。 */
function filterDownloads(tasks: DownloadTask[], filter: DownloadFilter): DownloadTask[] {
  if (filter === "all") return tasks;
  if (filter === "active") return tasks.filter((task) => pausableStatuses.has(task.status));
  if (filter === "paused") return tasks.filter((task) => task.status === "paused");
  if (filter === "completed") return tasks.filter((task) => task.status === "completed" || task.status === "seeding");
  return tasks.filter((task) => task.status === "error" || task.status === "missing_files");
}

/** 汇总远程下载队列的实时指标。 */
function summarizeQueue(tasks: DownloadTask[]): { active: number; completed: number; downloadSpeed: number } {
  return {
    active: tasks.filter((task) => pausableStatuses.has(task.status)).length,
    completed: tasks.filter((task) => task.status === "completed" || task.status === "seeding").length,
    downloadSpeed: tasks.reduce((total, task) => total + task.downloadSpeed, 0)
  };
}

/** 按番剧归并远程下载任务，未关联任务单独成组。 */
function groupDownloads(tasks: DownloadTask[], myAnime: MyAnime[]): DownloadGroup[] {
  const animeById = new Map(myAnime.map((item) => [item.anime.id, item.anime.title]));
  const groups = new Map<string, DownloadGroup>();
  for (const task of tasks) {
    const key = task.animeId ?? "__manual__";
    const group = groups.get(key) ?? {
      key,
      title: task.animeTitle ?? (task.animeId ? animeById.get(task.animeId) : undefined) ?? "未关联下载",
      tasks: []
    };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    tasks: [...group.tasks].sort((left, right) => (right.episodeNo ?? -1) - (left.episodeNo ?? -1))
  }));
}

/** 根据任务状态决定远程端可显示的单一控制动作。 */
function resolveControlAction(status: DownloadStatus): "pause" | "resume" | null {
  if (status === "paused") return "resume";
  if (pausableStatuses.has(status)) return "pause";
  return null;
}

/** 将下载状态映射为统一徽标色调。 */
function getDownloadStatusTone(status: DownloadStatus): "neutral" | "blue" | "green" | "amber" | "red" {
  if (status === "completed" || status === "seeding") return "green";
  if (status === "downloading" || status === "fetching_metadata") return "blue";
  if (status === "error" || status === "missing_files") return "red";
  if (status === "paused" || status === "stalled") return "amber";
  return "neutral";
}
