import { Download as DownloadIcon, FileSearch, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { appApi } from "@/lib/api";
import { formatBytes, formatDuration, formatPercent, formatSpeed } from "@/lib/format";
import type { DownloadTask } from "@shared/domain";

export function DownloadsPage() {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
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

    appApi
      .listDownloads()
      .then((items) => {
        if (active) {
          setTasks(items);
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

  if (loading) {
    return <div className="text-sm text-muted-foreground">正在加载下载队列...</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">下载队列</h1>
          <p className="mt-1 text-sm text-muted-foreground">内置引擎和 qB 兼容模式会统一显示任务状态。</p>
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

      <Panel>
        <div className="space-y-4">
          {tasks.map((task) => (
            <div key={task.id} className="rounded-md border p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{task.name}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <Badge tone="blue">{task.engine === "embedded" ? "内置引擎" : "qBittorrent"}</Badge>
                    <span>{formatSpeed(task.downloadSpeed)}</span>
                    <span>上传 {formatSpeed(task.uploadSpeed)}</span>
                    <span>剩余 {formatDuration(task.etaSeconds)}</span>
                    <span>{task.savePath}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={task.status === "downloading" ? "green" : "neutral"}>{task.status}</Badge>
                  <Button
                    variant="outline"
                    aria-label="暂停下载"
                    title="暂停下载"
                    disabled={mutatingTaskId === task.id}
                    onClick={() => void mutateTask(task.id, "pause")}
                  >
                    <Pause className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    aria-label="继续下载"
                    title="继续下载"
                    disabled={mutatingTaskId === task.id}
                    onClick={() => void mutateTask(task.id, "resume")}
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    aria-label="扫描媒体信息"
                    title="扫描媒体信息"
                    disabled={scanningTaskId === task.id || !canScanTask(task)}
                    onClick={() => void scanTask(task.id)}
                  >
                    <FileSearch className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    aria-label="移除任务"
                    title="移除任务"
                    disabled={mutatingTaskId === task.id}
                    onClick={() => void mutateTask(task.id, "remove")}
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
                        onChange={() => void toggleFileSelection(task, file)}
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
          ))}

          {tasks.length === 0 && (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              当前没有下载任务。
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function canScanTask(task: DownloadTask): boolean {
  return task.status === "completed" || task.status === "seeding" || task.files.some((file) => file.progress >= 1);
}
