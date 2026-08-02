import { useCallback, useEffect, useMemo, useState } from "react";
import { appApi } from "@/lib/api";
import { RemoteVideoPlayer } from "./RemoteVideoPlayer";
import {
  buildRemotePlaylist,
  readPlaylistFileIndex,
  resolveInitialPlaylistItem,
  type RemotePlaylistItem
} from "@/features/player/playback-list-model";
import { remotePlaybackSessionClient } from "./playback-session-client";
import type { Anime, DownloadTask, Episode } from "@shared/domain";

interface RemotePlayerPageProps {
  taskId: string;
}

/** 加载指定下载任务并承载远程独立播放器页面。 */
export function RemotePlayerPage({ taskId }: RemotePlayerPageProps) {
  const [playlist, setPlaylist] = useState<RemotePlaylistItem[]>([]);
  const [downloadTasks, setDownloadTasks] = useState<DownloadTask[]>([]);
  const [anime, setAnime] = useState<Anime>();
  const [episodes, setEpisodes] = useState<Episode[]>([]);
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
    setAnime(undefined);
    setEpisodes([]);
    setDownloadTasks([]);
    appApi.listDownloads()
      .then((tasks) => {
        if (!active) return;
        const matchedTask = tasks.find((item) => item.id === taskId);
        if (!matchedTask) {
          setError("播放任务不存在或已被删除");
          return;
        }
        const items = buildRemotePlaylist(tasks, matchedTask);
        setDownloadTasks(matchedTask.animeId
          ? tasks.filter((task) => task.animeId === matchedTask.animeId)
          : [matchedTask]);
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
        document.title = `${initialItem.displayTitle} - Ani Tracker`;
        console.info("[remote] 独立播放器播放列表读取完成", {
          taskId,
          itemCount: items.length,
          fileIndex: initialItem.fileIndex
        });
        if (matchedTask.animeId) {
          void appApi.getAnimeDetail(matchedTask.animeId).then((detail) => {
            if (!active) return;
            setAnime(detail.anime);
            setEpisodes(detail.episodes);
          }).catch((caught) => {
            console.warn("[player] 播放器番剧信息读取失败，继续使用下载任务数据", {
              animeId: matchedTask.animeId,
              error: caught
            });
          });
        }
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
    document.title = `${item.displayTitle} - Ani Tracker`;
    console.info("[player] 播放列表切换文件", {
      taskId: item.task.id,
      fileIndex: item.fileIndex
    });
  }, []);

  return <RemoteVideoPlayer
    key={activeItem?.id ?? "loading"}
    activeItem={activeItem}
    allowExternalPlayback
    anime={anime}
    downloadTasks={downloadTasks}
    environment="remote"
    episodes={episodes}
    error={error}
    loading={loading}
    onClose={closePlayerTab}
    onSelectItem={handleSelectItem}
    playlist={playlist}
    sessionClient={remotePlaybackSessionClient}
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
