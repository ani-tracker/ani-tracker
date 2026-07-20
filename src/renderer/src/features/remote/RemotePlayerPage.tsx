import { useCallback, useEffect, useMemo, useState } from "react";
import { appApi } from "@/lib/api";
import { RemoteVideoPlayer } from "./RemoteVideoPlayer";
import {
  buildRemotePlaylist,
  readPlaylistFileIndex,
  resolveInitialPlaylistItem,
  type RemotePlaylistItem
} from "./remote-player-model";

interface RemotePlayerPageProps {
  taskId: string;
}

/** 加载路由指定的下载任务并承载独立播放器页面。 */
export function RemotePlayerPage({ taskId }: RemotePlayerPageProps) {
  const [playlist, setPlaylist] = useState<RemotePlaylistItem[]>([]);
  const [activeItemId, setActiveItemId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeItem = useMemo(
    () => playlist.find((item) => item.id === activeItemId) ?? null,
    [activeItemId, playlist]
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    appApi.listDownloads()
      .then((tasks) => {
        if (!active) return;
        const matchedTask = tasks.find((item) => item.id === taskId);
        if (!matchedTask) {
          setError("播放任务不存在或已被删除");
          return;
        }
        const items = buildRemotePlaylist(tasks, matchedTask);
        const initialItem = resolveInitialPlaylistItem(
          items,
          taskId,
          readPlaylistFileIndex(window.location.search)
        );
        if (!initialItem) {
          setError("当前番剧没有已完成的可播放视频");
          return;
        }
        setPlaylist(items);
        setActiveItemId(initialItem.id);
        document.title = `${initialItem.fileName} - Ani Tracker`;
        console.info("[remote] 独立播放器播放列表读取完成", {
          taskId,
          itemCount: items.length,
          fileIndex: initialItem.fileIndex
        });
      })
      .catch((caught) => {
        if (active) {
          console.error("[remote] 独立播放器任务读取失败", { taskId, error: caught });
          setError(caught instanceof Error ? caught.message : "播放任务读取失败");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [taskId]);

  /** 切换播放项并更新地址，刷新后仍保持当前文件。 */
  const handleSelectItem = useCallback((item: RemotePlaylistItem): void => {
    setActiveItemId(item.id);
    const playerUrl = new URL(`/player/${encodeURIComponent(item.task.id)}`, window.location.origin);
    if (item.fileIndex !== undefined) {
      playerUrl.searchParams.set("file", String(item.fileIndex));
    }
    window.history.replaceState(null, "", `${playerUrl.pathname}${playerUrl.search}`);
    document.title = `${item.fileName} - Ani Tracker`;
    console.info("[remote] 播放列表切换文件", {
      taskId: item.task.id,
      fileIndex: item.fileIndex
    });
  }, []);

  return <RemoteVideoPlayer
    key={activeItem?.id ?? "loading"}
    activeItem={activeItem}
    error={error}
    loading={loading}
    onClose={closePlayerTab}
    onSelectItem={handleSelectItem}
    playlist={playlist}
  />;
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
