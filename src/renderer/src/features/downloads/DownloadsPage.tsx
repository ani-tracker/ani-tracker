import { ChevronDown, ChevronRight, Download as DownloadIcon, FileSearch, Folder, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { appApi } from "@/lib/api";
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
      setScanMessage("下载引擎已确认添加成功");
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
    return <div className="text-sm text-muted-foreground">正在加载下载队列...</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">下载队列</h1>
          <p className="mt-1 text-sm text-muted-foreground">按追番和字幕组归并任务，集数、进度和保存目录集中查看。</p>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={refreshing}>
          <RotateCcw className="h-4 w-4" />
          {refreshing ? "刷新中" : "刷新状态"}
        </Button>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>最后刷新：{updatedAt ?? "尚未刷新"}</span>
        <span className={error ? "text-rose-600" : ""}>{error ?? scanMessage}</span>
      </div>

      <Panel title="添加下载">
        <form className="flex flex-col gap-3 md:flex-row" onSubmit={(event) => void addDownload(event)}>
          <input
            className="h-10 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            placeholder="magnet 或 torrent 地址"
            value={downloadUrl}
            onChange={(event) => setDownloadUrl(event.target.value)}
          />
          <Button className="shrink-0" type="submit" disabled={addingDownload}>
            <DownloadIcon className="h-4 w-4" />
            {addingDownload ? "添加中" : "添加下载"}
          </Button>
        </form>
      </Panel>

      <div className="space-y-5">
          {animeGroups.map((animeGroup) => (
            <section key={animeGroup.key}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">{animeGroup.title}</h2>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{animeGroup.tasks.length} 个任务</span>
                    <span>已关联 {animeGroup.linkedEpisodes} 集</span>
                    <span>已完成 {animeGroup.completedEpisodes} 集</span>
                    <span>下载中 {animeGroup.activeEpisodes} 集</span>
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <Folder className="h-4 w-4 shrink-0" />
                  <span className="max-w-[420px] truncate" title={animeGroup.savePath}>{animeGroup.savePath}</span>
                </div>
              </div>

              <div className="mt-3 space-y-3">
                {animeGroup.fansubGroups.map((fansubGroup) => {
                  const collapsed = collapsedGroupKeys.has(fansubGroup.key);
                  return (
                    <section key={fansubGroup.key} className="overflow-hidden rounded-md border">
                      <button
                        className="flex h-11 w-full items-center justify-between gap-3 bg-muted/70 px-3 text-left hover:bg-muted"
                        type="button"
                        onClick={() => toggleGroup(fansubGroup.key)}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {collapsed ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
                          <span className="truncate text-sm font-medium">{fansubGroup.name}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge>{formatEpisodeRange(fansubGroup.tasks)}</Badge>
                          <span className="text-xs text-muted-foreground">{fansubGroup.tasks.length} 个任务</span>
                        </span>
                      </button>

                      {!collapsed && (
                        <div className="divide-y">
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
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </section>
          ))}

          {tasks.length === 0 && (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              当前没有下载任务。
            </div>
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
    <div className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    {task.episodeNo !== undefined && <Badge tone="blue">第 {task.episodeNo} 集</Badge>}
                    <div className="truncate font-medium">{task.name}</div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <Badge tone="blue">{task.engine === "embedded" ? "内置引擎" : "qBittorrent"}</Badge>
                    <span>{formatSpeed(task.downloadSpeed)}</span>
                    <span>上传 {formatSpeed(task.uploadSpeed)}</span>
                    <span>剩余 {formatDuration(task.etaSeconds)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={getDownloadStatusTone(task.status)}>{downloadStatusText[task.status]}</Badge>
                  <Button
                    variant="outline"
                    aria-label="暂停下载"
                    title="暂停下载"
                    disabled={mutatingTaskId === task.id}
                    onClick={() => void onMutate(task.id, "pause")}
                  >
                    <Pause className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    aria-label="继续下载"
                    title="继续下载"
                    disabled={mutatingTaskId === task.id}
                    onClick={() => void onMutate(task.id, "resume")}
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    aria-label="扫描媒体信息"
                    title="扫描媒体信息"
                    disabled={scanningTaskId === task.id || !canScanTask(task)}
                    onClick={() => void onScan(task.id)}
                  >
                    <FileSearch className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    aria-label="移除任务"
                    title="移除任务"
                    disabled={mutatingTaskId === task.id}
                    onClick={() => void onMutate(task.id, "remove")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <Progress value={task.progress} />
                <div className="w-12 text-right text-sm font-medium">{formatPercent(task.progress)}</div>
              </div>

              <div className="mt-4 space-y-2">
                {task.files.map((file) => (
                  <div key={file.id} className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
                    <label className="flex min-w-0 flex-1 items-center gap-3">
                      <input
                        className="h-4 w-4 rounded border-border accent-primary"
                        type="checkbox"
                        checked={file.selected}
                        disabled={mutatingFileId === file.id}
                        onChange={() => void onToggleFile(task, file)}
                      />
                      <span className={file.selected ? "truncate" : "truncate text-muted-foreground line-through"}>
                        {file.name}
                      </span>
                    </label>
                    <div className="ml-4 flex shrink-0 items-center gap-3 text-muted-foreground">
                      <span>{formatBytes(file.size)}</span>
                      <span>{formatPercent(file.progress)}</span>
                    </div>
                  </div>
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
