import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { appApi } from "@/lib/api";
import type { DownloadTask } from "@shared/domain";
import { RemoteVideoPlayer } from "./RemoteVideoPlayer";

interface RemotePlayerPageProps {
  taskId: string;
}

/** 加载路由指定的下载任务并承载独立播放器页面。 */
export function RemotePlayerPage({ taskId }: RemotePlayerPageProps) {
  const [task, setTask] = useState<DownloadTask | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    appApi.listDownloads()
      .then((tasks) => {
        if (!active) return;
        const matchedTask = tasks.find((item) => item.id === taskId);
        if (!matchedTask) {
          setError("播放任务不存在或已被删除");
          return;
        }
        setTask(matchedTask);
        document.title = `${matchedTask.name} - Ani Tracker`;
        console.info("[remote] 独立播放器任务读取完成", { taskId });
      })
      .catch((caught) => {
        if (active) {
          console.error("[remote] 独立播放器任务读取失败", { taskId, error: caught });
          setError(caught instanceof Error ? caught.message : "播放任务读取失败");
        }
      });

    return () => {
      active = false;
    };
  }, [taskId]);

  if (task) {
    return <RemoteVideoPlayer task={task} onClose={closePlayerTab} />;
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      {error ? (
        <Alert className="max-w-lg" variant="destructive">
          <AlertTitle>播放器无法打开</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>{error}</p>
            <Button variant="secondary" onClick={closePlayerTab}>关闭播放器</Button>
          </AlertDescription>
        </Alert>
      ) : (
        <Skeleton className="aspect-video w-full max-w-5xl" aria-label="正在读取播放任务" />
      )}
    </main>
  );
}

/** 从独立播放器路径中解析并校验下载任务标识。 */
export function resolveRemotePlayerTaskId(pathname: string): string | undefined {
  const match = pathname.match(/^\/player\/([^/]+)\/?$/);
  if (!match) {
    return undefined;
  }
  try {
    const taskId = decodeURIComponent(match[1]);
    return /^[a-zA-Z0-9._:-]{1,160}$/.test(taskId) ? taskId : undefined;
  } catch {
    return undefined;
  }
}

/** 关闭脚本打开的播放器标签页，直达页面则回到应用首页。 */
function closePlayerTab(): void {
  window.close();
  window.setTimeout(() => window.location.assign("/"), 100);
}
