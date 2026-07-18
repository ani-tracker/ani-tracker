import Hls from "hls.js";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { closeRemotePlaybackSession, createRemotePlaybackSession } from "@/lib/api";
import type { RemotePlaybackSession } from "@shared/contracts";
import type { DownloadTask } from "@shared/domain";

/** 展示绑定远程设备的在线播放器并管理 HLS 生命周期。 */
export function RemoteVideoPlayer({ task, onClose }: { task: DownloadTask; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState<RemotePlaybackSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let createdSession: RemotePlaybackSession | undefined;
    createRemotePlaybackSession(task.id)
      .then((result) => {
        createdSession = result;
        if (!active) {
          return closeRemotePlaybackSession(result.id);
        }
        setSession(result);
        setError(null);
        console.info("[remote] 播放会话已创建", { taskId: task.id, mode: result.mode });
      })
      .catch((caught) => {
        if (active) {
          console.error("[remote] 播放会话创建失败", { taskId: task.id, error: caught });
          setError(caught instanceof Error ? caught.message : "播放会话创建失败");
        }
      });

    return () => {
      active = false;
      if (createdSession) {
        void closeRemotePlaybackSession(createdSession.id);
      }
    };
  }, [task.id]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !session) {
      return;
    }
    const streamUrl = new URL(session.streamUrl, window.location.origin).toString();
    if (session.mode === "direct" || video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamUrl;
      void video.play().catch(() => undefined);
      return () => resetVideo(video);
    }
    if (!Hls.isSupported()) {
      setError("当前浏览器不支持此媒体的在线播放");
      return;
    }

    const hls = new Hls({ enableWorker: false });
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void video.play().catch(() => undefined);
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        console.error("[remote] HLS 播放失败", { type: data.type, details: data.details });
        setError("视频流中断，请关闭后重试");
      }
    });
    return () => {
      hls.destroy();
      resetVideo(video);
    };
  }, [session]);

  return (
    <Drawer ariaLabel="在线播放" className="flex flex-col sm:max-w-5xl" onClose={onClose}>
      <div className="flex items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-normal">{session?.fileName ?? task.name}</h2>
          {session && <Badge className="mt-2">{session.mode === "hls" ? "实时转码" : "原文件"}</Badge>}
        </div>
        <Button className="size-11 p-0" variant="ghost" onClick={onClose} aria-label="关闭播放器" title="关闭播放器">
          <X />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {error ? (
          <Alert className="max-w-xl" variant="destructive">
            <AlertTitle>在线播放失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : session ? (
          <video
            ref={videoRef}
            className="aspect-video max-h-full w-full bg-foreground"
            controls
            playsInline
            preload="metadata"
            onError={() => setError("浏览器无法解码当前视频流，请关闭后重试")}
          />
        ) : (
          <Skeleton className="aspect-video w-full" aria-label="正在准备视频" />
        )}
      </div>
    </Drawer>
  );
}

/** 清理 video 元素持有的媒体资源。 */
function resetVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}
