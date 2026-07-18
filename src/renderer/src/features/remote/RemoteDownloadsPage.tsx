import { Download, Pause, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
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

interface DownloadGroup {
  key: string;
  title: string;
  tasks: DownloadTask[];
}

/** 渲染远程客户端的下载状态与轻量控制。 */
export function RemoteDownloadsPage() {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mutatingTaskId, setMutatingTaskId] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => groupDownloads(tasks, myAnime), [myAnime, tasks]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setTasks(await appApi.refreshDownloads());
      setUpdatedAt(new Date().toLocaleTimeString());
      setError(null);
    } catch (caught) {
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
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="正在加载下载队列">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">下载队列</h1>
          <p className="mt-1 text-sm text-muted-foreground">查看任务进度并暂停或继续下载。</p>
        </div>
        <Button className="w-full sm:w-auto" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw data-icon="inline-start" />
          {refreshing ? "刷新中" : "刷新状态"}
        </Button>
      </header>

      <div className="flex flex-col gap-3">
        <span className="text-sm text-muted-foreground">最后刷新：{updatedAt ?? "尚未刷新"}</span>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>下载队列操作失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>

      {groups.length > 0 ? (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <Card key={group.key} className="min-w-0">
              <CardHeader>
                <CardTitle className="truncate" title={group.title}>{group.title}</CardTitle>
                <CardDescription>{group.tasks.length} 个任务</CardDescription>
              </CardHeader>
              <CardContent>
                {group.tasks.map((task, index) => (
                  <div key={task.id}>
                    <div className="py-4 first:pt-0 last:pb-0">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            {task.episodeNo !== undefined && <Badge tone="blue">第 {task.episodeNo} 集</Badge>}
                            <Badge tone={getDownloadStatusTone(task.status)}>{downloadStatusText[task.status]}</Badge>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={task.name}>{task.name}</span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span>下载 {formatSpeed(task.downloadSpeed)}</span>
                            <span>上传 {formatSpeed(task.uploadSpeed)}</span>
                            <span>剩余 {formatDuration(task.etaSeconds)}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <Button
                            className="size-11 p-0"
                            variant="outline"
                            aria-label="暂停下载"
                            title="暂停下载"
                            disabled={mutatingTaskId === task.id}
                            onClick={() => void controlTask(task.id, "pause")}
                          >
                            <Pause />
                          </Button>
                          <Button
                            className="size-11 p-0"
                            variant="outline"
                            aria-label="继续下载"
                            title="继续下载"
                            disabled={mutatingTaskId === task.id}
                            onClick={() => void controlTask(task.id, "resume")}
                          >
                            <Play />
                          </Button>
                        </div>
                      </div>
                      <div className="mt-4 flex items-center gap-3">
                        <Progress value={task.progress} />
                        <span className="w-12 text-right text-sm font-medium">{formatPercent(task.progress)}</span>
                      </div>
                    </div>
                    {index < group.tasks.length - 1 && <Separator />}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Empty className="min-h-72">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Download /></EmptyMedia>
            <EmptyTitle>当前没有下载任务</EmptyTitle>
            <EmptyDescription>桌面端当前没有可管理的下载任务。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
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

/** 将下载状态映射为统一徽标色调。 */
function getDownloadStatusTone(status: DownloadStatus): "neutral" | "blue" | "green" | "amber" | "red" {
  if (status === "completed" || status === "seeding") return "green";
  if (status === "downloading" || status === "fetching_metadata") return "blue";
  if (status === "error" || status === "missing_files") return "red";
  if (status === "paused" || status === "stalled") return "amber";
  return "neutral";
}
