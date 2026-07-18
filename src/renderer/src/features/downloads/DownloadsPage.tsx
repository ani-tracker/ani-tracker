import { ChevronDown, ChevronRight, Download as DownloadIcon, FileSearch, Folder, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ReleaseMetadataBadges } from "@/components/release-metadata-badges";
import { appApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatBytes, formatDuration, formatPercent, formatSpeed } from "@/lib/format";
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

export function DownloadsPage() {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mutatingTaskId, setMutatingTaskId] = useState<string | null>(null);
  const [mutatingFileId, setMutatingFileId] = useState<string | null>(null);
  const [scanningTaskId, setScanningTaskId] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [addingDownload, setAddingDownload] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const animeGroups = useMemo(() => groupDownloadTasks(tasks, myAnime), [tasks, myAnime]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const updated = await appApi.refreshDownloads();
      setTasks(updated);
      setUpdatedAt(new Date().toLocaleTimeString());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "刷新下载状态失败");
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  async function mutateTask(taskId: string, action: "pause" | "resume" | "remove") {
    setMutatingTaskId(taskId);
    try {
      const updated =
        action === "pause"
          ? await appApi.pauseDownload(taskId)
          : action === "resume"
            ? await appApi.resumeDownload(taskId)
            : await appApi.removeDownload(taskId, false);
      setTasks(updated);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "下载任务操作失败");
    } finally {
      setMutatingTaskId(null);
    }
  }

  async function addDownload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = downloadUrl.trim();
    if (!url) {
      setError("请输入 magnet 或 torrent 地址");
      return;
    }

    setAddingDownload(true);
    try {
      const updated = await appApi.addDownloadUrl({ url });
      setTasks(updated);
      setDownloadUrl("");
      setError(null);
      setScanMessage("已添加到下载队列");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "添加下载失败");
    } finally {
      setAddingDownload(false);
    }
  }

  async function scanTask(taskId: string) {
    setScanningTaskId(taskId);
    try {
      const result = await appApi.scanDownloadMedia(taskId);
      setScanMessage(
        `媒体扫描完成：入库 ${result.mediaFiles.length} 个，跳过 ${result.skippedFiles.length} 个，失败 ${result.errors.length} 个`
      );
      setError(result.errors[0]?.message ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "媒体信息扫描失败");
    } finally {
      setScanningTaskId(null);
    }
  }

  async function toggleFileSelection(task: DownloadTask, file: DownloadTask["files"][number]) {
    setMutatingFileId(file.id);
    try {
      const updated = await appApi.setDownloadFilePriority(task.id, [file.index], file.selected ? 0 : 1);
      setTasks(updated);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "文件选择更新失败");
    } finally {
      setMutatingFileId(null);
    }
  }

  useEffect(() => {
    let active = true;

    Promise.all([appApi.listDownloads(), appApi.listMyAnime()])
      .then(([items, animeItems]) => {
        if (active) {
          setTasks(items);
          setMyAnime(animeItems);
          setLoading(false);
        }
      })
      .catch((caught) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : "加载下载队列失败");
          setLoading(false);
        }
      });

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  /** 切换单个字幕组任务区的折叠状态。 */
  function toggleGroup(groupKey: string) {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-5" aria-label="正在加载下载队列">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
          <Skeleton className="h-11 w-28 md:h-9" />
        </div>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">下载队列</h1>
          <p className="mt-1 text-sm text-muted-foreground">按追番和字幕组归并任务，集数、进度和保存目录集中查看。</p>
        </div>
        <Button className="w-full sm:w-auto" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
          <RotateCcw data-icon="inline-start" />
          {refreshing ? "刷新中" : "刷新状态"}
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-sm text-muted-foreground">最后刷新：{updatedAt ?? "尚未刷新"}</span>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>下载队列操作失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!error && scanMessage && (
          <Alert>
            <AlertTitle>操作完成</AlertTitle>
            <AlertDescription>{scanMessage}</AlertDescription>
          </Alert>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>添加下载</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(event) => void addDownload(event)}>
            <FieldGroup className="gap-3 md:flex-row md:items-end">
              <Field className="min-w-0 flex-1">
                <FieldLabel className="sr-only" htmlFor="download-url">magnet 或 torrent 地址</FieldLabel>
                <Input
                  id="download-url"
                  placeholder="magnet 或 torrent 地址"
                  value={downloadUrl}
                  onChange={(event) => setDownloadUrl(event.target.value)}
                />
              </Field>
              <Field className="w-full md:w-auto">
                <FieldLabel className="sr-only" htmlFor="add-download">添加下载</FieldLabel>
                <Button id="add-download" className="w-full shrink-0 md:w-auto" type="submit" disabled={addingDownload}>
                  <DownloadIcon data-icon="inline-start" />
                  {addingDownload ? "添加中" : "添加下载"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-5">
          {animeGroups.map((animeGroup) => (
            <section key={animeGroup.key}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">{animeGroup.title}</h2>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{animeGroup.tasks.length} 个任务</span>
                    <span>已关联 {animeGroup.linkedEpisodes} 集</span>
                    <span>已完成 {animeGroup.completedEpisodes} 集</span>
                    <span>下载中 {animeGroup.activeEpisodes} 集</span>
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground sm:max-w-[45%]">
                  <Folder className="size-4 shrink-0" />
                  <span className="truncate" title={animeGroup.savePath}>{animeGroup.savePath}</span>
                </div>
              </div>
              <Separator className="mt-3" />

              <div className="mt-3 flex flex-col gap-3">
                {animeGroup.fansubGroups.map((fansubGroup) => {
                  const collapsed = collapsedGroupKeys.has(fansubGroup.key);
                  return (
                    <Card key={fansubGroup.key} className="overflow-hidden shadow-none">
                      <CardHeader className="p-0 sm:p-0">
                        <CardTitle>
                          <Button
                            className="h-auto w-full justify-between rounded-none px-3 py-2 text-left"
                            variant="secondary"
                            type="button"
                            onClick={() => toggleGroup(fansubGroup.key)}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              {collapsed ? <ChevronRight data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}
                              <span className="truncate text-sm font-medium">{fansubGroup.name}</span>
                            </span>
                            <span className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
                              <Badge>{formatEpisodeRange(fansubGroup.tasks)}</Badge>
                              <span className="text-xs text-muted-foreground">{fansubGroup.tasks.length} 个任务</span>
                            </span>
                          </Button>
                        </CardTitle>
                      </CardHeader>

                      {!collapsed && (
                        <CardContent className="divide-y p-0 sm:p-0">
                          {fansubGroup.tasks.map((task) => (
                            <DownloadTaskRow
                              key={task.id}
                              task={task}
                              mutatingTaskId={mutatingTaskId}
                              mutatingFileId={mutatingFileId}
                              scanningTaskId={scanningTaskId}
                              onMutate={mutateTask}
                              onScan={scanTask}
                              onToggleFile={toggleFileSelection}
                            />
                          ))}
                        </CardContent>
                      )}
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}

          {tasks.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><DownloadIcon /></EmptyMedia>
                <EmptyTitle>当前没有下载任务</EmptyTitle>
                <EmptyDescription>添加 magnet 或 torrent 地址后，任务会显示在这里。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
      </div>
    </div>
  );
}

function DownloadTaskRow({
  task,
  mutatingTaskId,
  mutatingFileId,
  scanningTaskId,
  onMutate,
  onScan,
  onToggleFile
}: {
  task: DownloadTask;
  mutatingTaskId: string | null;
  mutatingFileId: string | null;
  scanningTaskId: string | null;
  onMutate: (taskId: string, action: "pause" | "resume" | "remove") => Promise<void>;
  onScan: (taskId: string) => Promise<void>;
  onToggleFile: (task: DownloadTask, file: DownloadTask["files"][number]) => Promise<void>;
}) {
  return (
    <div className="p-3 sm:p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {task.episodeNo !== undefined && <Badge tone="blue">第 {task.episodeNo} 集</Badge>}
                    <div className="min-w-0 flex-1 truncate font-medium">{task.name}</div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <Badge tone="blue">{task.engine === "embedded" ? "内置引擎" : "qBittorrent"}</Badge>
                    <ReleaseMetadataBadges metadata={task} />
                    <span>{formatSpeed(task.downloadSpeed)}</span>
                    <span>上传 {formatSpeed(task.uploadSpeed)}</span>
                    <span>剩余 {formatDuration(task.etaSeconds)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
                  <Badge tone={getDownloadStatusTone(task.status)}>{downloadStatusText[task.status]}</Badge>
                  <Button
                    className="size-11 p-0 md:size-9"
                    variant="outline"
                    aria-label="暂停下载"
                    title="暂停下载"
                    disabled={mutatingTaskId === task.id}
                    onClick={() => void onMutate(task.id, "pause")}
                  >
                    <Pause />
                  </Button>
                  <Button
                    className="size-11 p-0 md:size-9"
                    variant="outline"
                    aria-label="继续下载"
                    title="继续下载"
                    disabled={mutatingTaskId === task.id}
                    onClick={() => void onMutate(task.id, "resume")}
                  >
                    <Play />
                  </Button>
                  <Button
                    className="size-11 p-0 md:size-9"
                    variant="outline"
                    aria-label="扫描媒体信息"
                    title="扫描媒体信息"
                    disabled={scanningTaskId === task.id || !canScanTask(task)}
                    onClick={() => void onScan(task.id)}
                  >
                    <FileSearch />
                  </Button>
                  <Button
                    className="size-11 p-0 md:size-9"
                    variant="outline"
                    aria-label="移除任务"
                    title="移除任务"
                    disabled={mutatingTaskId === task.id}
                    onClick={() => void onMutate(task.id, "remove")}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <Progress value={task.progress} />
                <div className="w-12 text-right text-sm font-medium">{formatPercent(task.progress)}</div>
              </div>

              <div className="mt-4 flex flex-col gap-2">
                {task.files.map((file) => (
                  <Field
                    key={file.id}
                    className="flex-wrap rounded-md bg-muted p-3"
                    data-disabled={mutatingFileId === file.id}
                    orientation="horizontal"
                  >
                    <Checkbox
                      id={`download-file-${file.id}`}
                      checked={file.selected}
                      disabled={mutatingFileId === file.id}
                      onCheckedChange={() => void onToggleFile(task, file)}
                    />
                    <FieldLabel
                      className={cn("min-w-0 flex-1 font-normal", !file.selected && "text-muted-foreground line-through")}
                      htmlFor={`download-file-${file.id}`}
                    >
                      <span className="truncate">{file.name}</span>
                    </FieldLabel>
                    <div className="flex basis-full items-center gap-3 pl-8 text-sm text-muted-foreground sm:basis-auto sm:shrink-0 sm:pl-0">
                      <span>{formatBytes(file.size)}</span>
                      <span>{formatPercent(file.progress)}</span>
                    </div>
                  </Field>
                ))}
              </div>
    </div>
  );
}

interface DownloadFansubGroup {
  key: string;
  name: string;
  tasks: DownloadTask[];
}

interface DownloadAnimeGroup {
  key: string;
  title: string;
  savePath: string;
  tasks: DownloadTask[];
  fansubGroups: DownloadFansubGroup[];
  linkedEpisodes: number;
  completedEpisodes: number;
  activeEpisodes: number;
}

/** 依次按追番和字幕组归并任务，同时保留未关联的手动任务。 */
function groupDownloadTasks(tasks: DownloadTask[], myAnime: MyAnime[]): DownloadAnimeGroup[] {
  const animeById = new Map(myAnime.map((item) => [item.anime.id, item]));
  const grouped = new Map<string, DownloadAnimeGroup>();

  for (const task of tasks) {
    const anime = task.animeId ? animeById.get(task.animeId) : undefined;
    const animeKey = task.animeId ?? "__manual__";
    const group = grouped.get(animeKey) ?? {
      key: animeKey,
      title: task.animeTitle ?? anime?.anime.title ?? "未关联下载",
      savePath: task.savePath,
      tasks: [],
      fansubGroups: [],
      linkedEpisodes: 0,
      completedEpisodes: 0,
      activeEpisodes: 0
    };
    group.tasks.push(task);
    grouped.set(animeKey, group);
  }

  return [...grouped.values()].map((group) => {
    const fansubs = new Map<string, DownloadFansubGroup>();
    for (const task of group.tasks) {
      const key = task.fansubGroupId ?? task.fansubName ?? "__unknown__";
      const fansub = fansubs.get(key) ?? {
        key: `${group.key}:${key}`,
        name: task.fansubName ?? task.fansubGroupId ?? "未识别字幕组",
        tasks: []
      };
      fansub.tasks.push(task);
      fansubs.set(key, fansub);
    }

    const episodeTasks = group.tasks.filter((task) => task.episodeNo !== undefined);
    group.linkedEpisodes = countUniqueEpisodes(episodeTasks);
    group.completedEpisodes = countUniqueEpisodes(episodeTasks.filter(isCompletedTask));
    group.activeEpisodes = countUniqueEpisodes(episodeTasks.filter(isActiveTask));
    group.fansubGroups = [...fansubs.values()]
      .map((fansub) => ({ ...fansub, tasks: sortTasksByEpisode(fansub.tasks) }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    return group;
  });
}

function sortTasksByEpisode(tasks: DownloadTask[]): DownloadTask[] {
  return [...tasks].sort((left, right) => (right.episodeNo ?? -1) - (left.episodeNo ?? -1));
}

function countUniqueEpisodes(tasks: DownloadTask[]): number {
  return new Set(tasks.map((task) => task.episodeNo).filter((value) => value !== undefined)).size;
}

function formatEpisodeRange(tasks: DownloadTask[]): string {
  const episodes = [...new Set(tasks.map((task) => task.episodeNo).filter((value): value is number => value !== undefined))]
    .sort((left, right) => left - right);
  if (episodes.length === 0) {
    return "未关联集数";
  }
  if (episodes.length === 1) {
    return `第 ${episodes[0]} 集`;
  }
  return `第 ${episodes[0]}-${episodes.at(-1)} 集`;
}

function isCompletedTask(task: DownloadTask): boolean {
  return task.status === "completed" || task.status === "seeding";
}

function isActiveTask(task: DownloadTask): boolean {
  return ["queued", "fetching_metadata", "downloading", "stalled", "paused", "checking", "moving"].includes(task.status);
}

function getDownloadStatusTone(status: DownloadStatus): "neutral" | "green" | "amber" | "red" | "blue" {
  if (status === "completed" || status === "seeding") return "green";
  if (status === "error" || status === "missing_files") return "red";
  if (status === "paused" || status === "stalled") return "amber";
  if (status === "downloading") return "blue";
  return "neutral";
}

function canScanTask(task: DownloadTask): boolean {
  return task.status === "completed" || task.status === "seeding" || task.files.some((file) => file.progress >= 1);
}
