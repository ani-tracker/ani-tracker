import Artplayer from "artplayer";
import Hls from "hls.js";
import { RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { closeRemotePlaybackSession, createRemotePlaybackSession } from "@/lib/api";
import type { RemotePlaybackRequestMode, RemotePlaybackSession } from "@shared/contracts";
import type { DownloadTask } from "@shared/domain";

interface RemoteVideoPlayerProps {
  task: DownloadTask;
  onClose: () => void;
}

/** 展示绑定远程设备的独立在线播放器并管理媒体会话生命周期。 */
export function RemoteVideoPlayer({ task, onClose }: RemoteVideoPlayerProps) {
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const [requestedMode, setRequestedMode] = useState<RemotePlaybackRequestMode>(
    () => resolveDefaultPlaybackRequestMode(task)
  );
  const [session, setSession] = useState<RemotePlaybackSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let active = true;
    let createdSession: RemotePlaybackSession | undefined;
    setSession(null);
    setError(null);
    console.info("[remote] 正在创建播放会话", { taskId: task.id, requestedMode });

    createRemotePlaybackSession(task.id, requestedMode)
      .then((result) => {
        createdSession = result;
        if (!active) {
          return closeRemotePlaybackSession(result.id);
        }
        setSession(result);
        console.info("[remote] 播放会话已创建", { taskId: task.id, mode: result.mode });
      })
      .catch((caught) => {
        if (active) {
          console.error("[remote] 播放会话创建失败", { taskId: task.id, requestedMode, error: caught });
          setError(caught instanceof Error ? caught.message : "播放会话创建失败");
        }
      });

    return () => {
      active = false;
      if (createdSession) {
        void closeRemotePlaybackSession(createdSession.id);
      }
    };
  }, [requestedMode, retryNonce, task.id]);

  useEffect(() => {
    const container = playerContainerRef.current;
    if (!container || !session) {
      return;
    }

    let hls: Hls | undefined;
    const streamUrl = new URL(session.streamUrl, window.location.origin).toString();
    const handlePlaybackError = (message: string): void => {
      console.error("[remote] ArtPlayer 播放失败", { taskId: task.id, mode: session.mode });
      setError(message);
    };
    let player: Artplayer;
    try {
      player = new Artplayer({
        container,
        url: streamUrl,
        ...(session.mode === "hls" ? { type: "m3u8" as const } : {}),
        lang: "zh-cn",
        autoplay: true,
        volume: 0.7,
        setting: true,
        playbackRate: true,
        aspectRatio: true,
        pip: true,
        airplay: true,
        fullscreen: true,
        fullscreenWeb: true,
        hotkey: true,
        mutex: true,
        playsInline: true,
        lock: true,
        fastForward: true,
        customType: {
          m3u8(video, url, art) {
            if (video.canPlayType("application/vnd.apple.mpegurl")) {
              video.src = url;
              return;
            }
            if (!Hls.isSupported()) {
              handlePlaybackError("当前浏览器不支持 HLS 实时转码播放");
              return;
            }
            hls = new Hls({ enableWorker: false });
            art.hls = hls;
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal) {
                handlePlaybackError("实时转码视频流中断，请重试");
              }
            });
          }
        }
      }, () => {
        console.info("[remote] ArtPlayer 已就绪", { taskId: task.id, mode: session.mode });
      });
    } catch (caught) {
      console.error("[remote] ArtPlayer 初始化失败", { taskId: task.id, error: caught });
      setError("播放器初始化失败，请重试");
      return;
    }

    player.on("video:error", () => {
      handlePlaybackError(
        session.mode === "direct"
          ? "浏览器无法解码当前原文件，可切换实时转码"
          : "浏览器无法播放当前转码视频流，请重试"
      );
    });

    return () => {
      hls?.destroy();
      player.destroy(true);
    };
  }, [session, task.id]);

  /** 切换播放模式并让当前媒体会话由副作用统一替换。 */
  const handleModeChange = (value: string): void => {
    if ((value === "direct" || value === "transcode") && value !== requestedMode) {
      console.info("[remote] 切换播放模式", { taskId: task.id, requestedMode: value });
      setRequestedMode(value);
    }
  };

  return (
    <main className="flex min-h-svh w-full flex-col bg-background">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:px-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold tracking-normal sm:text-lg">
            {session?.fileName ?? task.name}
          </h2>
          {session && (
            <div className="mt-1 flex flex-wrap gap-2">
              <Badge>{session.mode === "hls" ? "实时转码" : "原文件直传"}</Badge>
              <Badge>{session.durationSeconds ? `总时长 ${formatPlaybackDuration(session.durationSeconds)}` : "时长未知"}</Badge>
            </div>
          )}
        </div>
        <ToggleGroup
          aria-label="播放模式"
          className="col-span-2 row-start-2 justify-self-start sm:col-span-1 sm:col-start-2 sm:row-start-1"
          disabled={!session && !error}
          onValueChange={handleModeChange}
          type="single"
          value={requestedMode}
          variant="outline"
        >
          <ToggleGroupItem className="min-h-11 px-3 md:min-h-9" value="direct">
            不转码
          </ToggleGroupItem>
          <ToggleGroupItem className="min-h-11 px-3 md:min-h-9" value="transcode">
            实时转码
          </ToggleGroupItem>
        </ToggleGroup>
        <Button
          aria-label="关闭播放器"
          className="col-start-2 row-start-1 size-11 p-0 sm:col-start-3"
          title="关闭播放器"
          variant="ghost"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <div className="relative min-h-60 flex-1 bg-foreground">
        <div ref={playerContainerRef} className="size-full" />
        {!session && !error && (
          <Skeleton className="absolute inset-0 size-full rounded-none" aria-label="正在准备视频" />
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/95 p-4">
            <Alert className="max-w-xl" variant="destructive">
              <AlertTitle>在线播放失败</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                <p>{error}</p>
                {requestedMode === "direct" ? (
                  <Button variant="secondary" onClick={() => setRequestedMode("transcode")}>
                    切换实时转码
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => setRetryNonce((value) => value + 1)}>
                    <RotateCcw data-icon="inline-start" />
                    重试
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          </div>
        )}
      </div>
    </main>
  );
}

/** 根据下载容器和视频编码选择首次打开播放器的默认模式。 */
function resolveDefaultPlaybackRequestMode(task: DownloadTask): RemotePlaybackRequestMode {
  if (task.normalizedVideoCodec === "H.265/HEVC") {
    return "transcode";
  }
  const completedFile = [...task.files]
    .filter((file) => file.selected && file.progress >= 1)
    .sort((left, right) => right.size - left.size)[0];
  const fileName = (completedFile?.name ?? task.name).toLowerCase();
  return [".mp4", ".m4v", ".webm"].some((extension) => fileName.endsWith(extension))
    ? "direct"
    : "transcode";
}

/** 将媒体秒数格式化为播放器使用的时分秒文本。 */
function formatPlaybackDuration(durationSeconds: number): string {
  const totalSeconds = Math.max(0, Math.round(durationSeconds));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
