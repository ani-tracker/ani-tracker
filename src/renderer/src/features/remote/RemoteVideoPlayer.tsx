import Artplayer, { type Setting } from "artplayer";
import Hls from "hls.js";
import {
  ListVideo,
  MonitorPlay,
  PanelTopClose,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  appApi,
  closeRemotePlaybackSession,
  createRemoteExternalPlaybackSession,
  createRemotePlaybackSession
} from "@/lib/api";
import { formatBytes } from "@/lib/format";
import type {
  RemotePlaybackRequestMode,
  RemotePlaybackSession,
  RemotePlaybackSubtitle
} from "@shared/contracts";
import type { RemotePlaylistItem } from "./remote-player-model";
import {
  buildExternalPlayerProtocolUrl,
  detectExternalPlayer
} from "./external-player-launch";

const TOOLBAR_HIDE_DELAY_MS = 3_000;

interface RemoteVideoPlayerProps {
  activeItem: RemotePlaylistItem | null;
  playlist: RemotePlaylistItem[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSelectItem: (item: RemotePlaylistItem) => void;
}

/** 展示独立远程播放器，并协调会话、自动转码、顶栏和播放列表。 */
export function RemoteVideoPlayer({
  activeItem,
  playlist,
  loading,
  error: loadError,
  onClose,
  onSelectItem
}: RemoteVideoPlayerProps) {
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const artPlayerRef = useRef<Artplayer | null>(null);
  const onSelectItemRef = useRef(onSelectItem);
  const toolbarTimerRef = useRef<number>();
  const automaticFallbackStartedRef = useRef(false);
  const [requestedMode, setRequestedMode] = useState<RemotePlaybackRequestMode>("direct");
  const [session, setSession] = useState<RemotePlaybackSession | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [externalPlayerOpening, setExternalPlayerOpening] = useState(false);
  const externalPlayer = useMemo(
    () => detectExternalPlayer(navigator.userAgent, navigator.platform),
    []
  );
  const activeIndex = useMemo(
    () => activeItem ? playlist.findIndex((item) => item.id === activeItem.id) : -1,
    [activeItem, playlist]
  );
  const previousItem = activeIndex > 0 ? playlist[activeIndex - 1] : undefined;
  const nextItem = activeIndex >= 0 && activeIndex < playlist.length - 1
    ? playlist[activeIndex + 1]
    : undefined;

  useEffect(() => {
    onSelectItemRef.current = onSelectItem;
  }, [onSelectItem]);

  /** 清理并重新安排播放器顶栏的自动隐藏计时。 */
  const scheduleToolbarHide = useCallback((): void => {
    window.clearTimeout(toolbarTimerRef.current);
    if (!session || playlistOpen || playbackError || loadError) {
      return;
    }
    toolbarTimerRef.current = window.setTimeout(() => {
      setToolbarVisible(false);
    }, TOOLBAR_HIDE_DELAY_MS);
  }, [loadError, playbackError, playlistOpen, session]);

  /** 响应指针或键盘活动，重新呼出顶栏并重置计时。 */
  const revealToolbar = useCallback((): void => {
    setToolbarVisible(true);
    scheduleToolbarHide();
  }, [scheduleToolbarHide]);

  useEffect(() => {
    if (playlistOpen || playbackError || loadError || !session) {
      window.clearTimeout(toolbarTimerRef.current);
      setToolbarVisible(true);
      return;
    }
    scheduleToolbarHide();
    return () => window.clearTimeout(toolbarTimerRef.current);
  }, [loadError, playbackError, playlistOpen, scheduleToolbarHide, session]);

  useEffect(() => {
    if (!activeItem) {
      return;
    }
    let active = true;
    let createdSession: RemotePlaybackSession | undefined;
    setSession(null);
    setPlaybackError(null);
    console.info("[remote] 正在创建播放会话", {
      taskId: activeItem.task.id,
      fileIndex: activeItem.fileIndex,
      requestedMode
    });

    createRemotePlaybackSession(activeItem.task.id, requestedMode, activeItem.fileIndex)
      .then((result) => {
        createdSession = result;
        if (!active) {
          return closeRemotePlaybackSession(result.id);
        }
        setSession(result);
        console.info("[remote] 播放会话已创建", {
          taskId: activeItem.task.id,
          fileIndex: result.fileIndex,
          mode: result.mode
        });
      })
      .catch((caught) => {
        if (active) {
          console.error("[remote] 播放会话创建失败", {
            taskId: activeItem.task.id,
            fileIndex: activeItem.fileIndex,
            requestedMode,
            error: caught
          });
          setPlaybackError(caught instanceof Error ? caught.message : "播放会话创建失败");
        }
      });

    return () => {
      active = false;
      if (createdSession) {
        void closeRemotePlaybackSession(createdSession.id);
      }
    };
  }, [activeItem, requestedMode, retryNonce]);

  /** 原文件发生媒体错误时仅自动升级一次实时转码。 */
  const startAutomaticTranscode = useCallback((): void => {
    if (!activeItem || requestedMode !== "direct" || automaticFallbackStartedRef.current) {
      return;
    }
    automaticFallbackStartedRef.current = true;
    setPlaybackError(null);
    setRequestedMode("transcode");
    toast.info("原文件无法播放，正在切换实时转码");
    console.warn("[remote] 原文件播放失败，自动切换实时转码", {
      taskId: activeItem.task.id,
      fileIndex: activeItem.fileIndex
    });
  }, [activeItem, requestedMode]);

  useEffect(() => {
    const container = playerContainerRef.current;
    if (!container || !session || !activeItem) {
      return;
    }

    let hls: Hls | undefined;
    let progressReported = false;
    const streamUrl = new URL(session.streamUrl, window.location.origin).toString();
    const defaultSubtitle = session.subtitles.find((subtitle) => subtitle.default)
      ?? session.subtitles[0];
    const handlePlaybackError = (message: string): void => {
      if (session.mode === "direct" && !automaticFallbackStartedRef.current) {
        startAutomaticTranscode();
        return;
      }
      console.error("[remote] ArtPlayer 播放失败", {
        taskId: activeItem.task.id,
        fileIndex: activeItem.fileIndex,
        mode: session.mode
      });
      setPlaybackError(message);
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
        subtitleOffset: session.subtitles.length > 0,
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
        ...(session.subtitles.length > 0
          ? { settings: [createSubtitleSetting(session.subtitles)] }
          : {}),
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
        console.info("[remote] ArtPlayer 已就绪", {
          taskId: activeItem.task.id,
          fileIndex: activeItem.fileIndex,
          mode: session.mode
        });
      });
    } catch (caught) {
      console.error("[remote] ArtPlayer 初始化失败", {
        taskId: activeItem.task.id,
        fileIndex: activeItem.fileIndex,
        error: caught
      });
      setPlaybackError("播放器初始化失败，请重试");
      return;
    }
    artPlayerRef.current = player;

    /** 达到阈值后按当前任务只上报一次观看进度。 */
    const reportPlaybackProgress = (percent: number): void => {
      if (progressReported || percent < 90) {
        return;
      }
      progressReported = true;
      const normalizedPercent = Math.max(0, Math.min(100, percent));
      void appApi.reportPlaybackProgress({
        taskId: activeItem.task.id,
        fileIndex: activeItem.fileIndex,
        percent: normalizedPercent
      }).then((handled) => {
        console.info("[remote] 播放进度已上报", {
          taskId: activeItem.task.id,
          fileIndex: activeItem.fileIndex,
          percent: normalizedPercent,
          handled
        });
      }).catch((caught) => {
        console.warn("[remote] 播放进度上报失败", {
          taskId: activeItem.task.id,
          fileIndex: activeItem.fileIndex,
          error: caught
        });
      });
    };

    player.on("video:error", () => {
      handlePlaybackError(
        session.mode === "direct"
          ? "浏览器无法解码当前原文件"
          : "浏览器无法播放当前转码视频流，请重试"
      );
    });
    player.on("video:timeupdate", () => {
      const duration = player.duration;
      if (progressReported || !Number.isFinite(duration) || duration <= 0) {
        return;
      }
      reportPlaybackProgress(player.currentTime / duration * 100);
    });
    player.on("video:ended", () => {
      reportPlaybackProgress(100);
      if (nextItem) {
        console.info("[remote] 当前文件播放完成，切换下一项", {
          taskId: nextItem.task.id,
          fileIndex: nextItem.fileIndex
        });
        onSelectItemRef.current(nextItem);
      }
    });
    player.on("subtitleLoad", (cues) => {
      console.info("[remote] ArtPlayer 字幕加载完成", {
        taskId: activeItem.task.id,
        cueCount: cues.length
      });
    });
    if (defaultSubtitle) {
      void switchArtPlayerSubtitle(player, defaultSubtitle).catch((caught) => {
        console.error("[remote] 默认字幕加载失败", {
          taskId: activeItem.task.id,
          subtitleId: defaultSubtitle.id,
          error: caught
        });
        player.notice.show = "默认字幕加载失败，可在设置中重试";
      });
    }

    return () => {
      if (artPlayerRef.current === player) {
        artPlayerRef.current = null;
      }
      hls?.destroy();
      player.destroy(true);
    };
  }, [activeItem, nextItem, session, startAutomaticTranscode]);

  /** 手动切换播放模式，并允许下次直传失败时再次自动升级。 */
  const handleModeChange = (value: string): void => {
    if ((value === "direct" || value === "transcode") && value !== requestedMode) {
      automaticFallbackStartedRef.current = value === "transcode";
      setPlaybackError(null);
      setRequestedMode(value);
      console.info("[remote] 手动切换播放模式", {
        taskId: activeItem?.task.id,
        requestedMode: value
      });
    }
  };

  /** 创建外部拉流会话并调用远程设备本机播放器。 */
  const handleExternalPlayback = async (): Promise<void> => {
    if (!activeItem || !externalPlayer || externalPlayerOpening) {
      return;
    }
    const currentPlayer = artPlayerRef.current;
    const wasPlaying = currentPlayer?.playing ?? false;
    currentPlayer?.pause();
    setExternalPlayerOpening(true);
    const toastId = toast.loading(`正在准备 ${externalPlayer.label} 播放地址`);
    let externalSession: RemotePlaybackSession | undefined;
    try {
      externalSession = await createRemoteExternalPlaybackSession(
        activeItem.task.id,
        requestedMode,
        activeItem.fileIndex
      );
      const mediaUrl = new URL(externalSession.streamUrl, window.location.origin).toString();
      const protocolUrl = buildExternalPlayerProtocolUrl(externalPlayer.kind, mediaUrl);
      window.location.assign(protocolUrl);
      toast.info(`已请求打开 ${externalPlayer.label}`, {
        id: toastId,
        description: "若播放器未启动，请确认已安装并允许浏览器打开外部应用。"
      });
      console.info("[remote] 已下发本地播放器拉流请求", {
        player: externalPlayer.kind,
        taskId: activeItem.task.id,
        fileIndex: activeItem.fileIndex,
        mode: requestedMode
      });
    } catch (caught) {
      if (externalSession) {
        void closeRemotePlaybackSession(externalSession.id);
      }
      if (wasPlaying && currentPlayer) {
        void currentPlayer.play().catch(() => undefined);
      }
      console.error("[remote] 本地播放器调起失败", {
        player: externalPlayer.kind,
        taskId: activeItem.task.id,
        error: caught
      });
      toast.error(`无法打开 ${externalPlayer.label}`, {
        id: toastId,
        description: caught instanceof Error ? caught.message : "本地播放器调用失败"
      });
    } finally {
      setExternalPlayerOpening(false);
    }
  };

  /** 切换当前播放项并关闭播放列表。 */
  const selectPlaylistItem = (item: RemotePlaylistItem): void => {
    if (item.id !== activeItem?.id) {
      onSelectItem(item);
    }
    setPlaylistOpen(false);
  };

  return (
    <main
      className="relative h-svh w-full overflow-hidden bg-foreground"
      onKeyDownCapture={revealToolbar}
      onPointerDown={revealToolbar}
      onPointerMove={revealToolbar}
    >
      <div ref={playerContainerRef} className="absolute inset-0" />

      {(loading || (activeItem && !session && !playbackError)) && !loadError && (
        <Skeleton className="absolute inset-0 size-full rounded-none" aria-label="正在准备视频" />
      )}

      {(loadError || playbackError) && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/95 p-4">
          <Alert className="max-w-xl" variant="destructive">
            <AlertTitle>{loadError ? "播放器无法打开" : "在线播放失败"}</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <p>{loadError ?? playbackError}</p>
              {loadError ? (
                <Button variant="secondary" onClick={onClose}>关闭播放器</Button>
              ) : requestedMode === "direct" ? (
                <Button variant="secondary" onClick={startAutomaticTranscode}>切换实时转码</Button>
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

      {toolbarVisible && (
        <TooltipProvider delayDuration={300}>
          <div className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center gap-2 border-b bg-background/90 p-3 shadow-sm backdrop-blur sm:px-4">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold tracking-normal sm:text-lg">
                {session?.fileName ?? activeItem?.fileName ?? "播放器"}
              </h1>
              {session && (
                <div className="mt-1 flex flex-wrap gap-2">
                  <Badge>{session.mode === "hls" ? "实时转码" : "原文件直传"}</Badge>
                  <Badge>
                    {session.durationSeconds ? `总时长 ${formatPlaybackDuration(session.durationSeconds)}` : "时长未知"}
                  </Badge>
                  <Badge>{session.subtitles.length > 0 ? `${session.subtitles.length} 条字幕` : "无文本字幕"}</Badge>
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <PlayerIconButton
                disabled={!previousItem}
                label="上一个视频"
                onClick={() => previousItem && onSelectItem(previousItem)}
              >
                <SkipBack />
              </PlayerIconButton>
              <PlayerIconButton
                disabled={!nextItem}
                label="下一个视频"
                onClick={() => nextItem && onSelectItem(nextItem)}
              >
                <SkipForward />
              </PlayerIconButton>
              <PlayerIconButton label="播放列表" onClick={() => setPlaylistOpen(true)}>
                <ListVideo />
              </PlayerIconButton>
              {externalPlayer && (
                <PlayerIconButton
                  disabled={externalPlayerOpening || !activeItem}
                  label={externalPlayerOpening ? `正在准备 ${externalPlayer.label}` : `用 ${externalPlayer.label} 播放`}
                  onClick={() => void handleExternalPlayback()}
                >
                  <MonitorPlay />
                </PlayerIconButton>
              )}
              <PlayerIconButton label="隐藏播放信息" onClick={() => setToolbarVisible(false)}>
                <PanelTopClose />
              </PlayerIconButton>
              <PlayerIconButton label="关闭播放器" onClick={onClose}>
                <X />
              </PlayerIconButton>
            </div>

            <ToggleGroup
              aria-label="播放模式"
              className="w-full justify-start sm:w-auto"
              disabled={!activeItem || (!session && !playbackError)}
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
          </div>
        </TooltipProvider>
      )}

      <Sheet open={playlistOpen} onOpenChange={setPlaylistOpen}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-md" side="right">
          <SheetHeader className="border-b p-4 pr-14">
            <SheetTitle>播放列表</SheetTitle>
            <SheetDescription>
              {activeItem?.task.animeTitle ?? "当前番剧"} · {playlist.length} 个视频
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="flex flex-col gap-1">
              {playlist.map((item) => {
                const selected = item.id === activeItem?.id;
                return (
                  <Button
                    aria-current={selected ? "true" : undefined}
                    className="h-auto w-full justify-start p-3 text-left"
                    key={item.id}
                    onClick={() => selectPlaylistItem(item)}
                    variant={selected ? "secondary" : "ghost"}
                  >
                    <Play />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.fileName}</span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {formatPlaylistMeta(item)}
                      </span>
                    </span>
                    {selected && <Badge>正在播放</Badge>}
                  </Button>
                );
              })}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </main>
  );
}

/** 渲染带提示的播放器图标按钮。 */
function PlayerIconButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} className="size-11 p-0" title={label} variant="ghost" {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** 生成播放列表项的集数、规格和体积摘要。 */
function formatPlaylistMeta(item: RemotePlaylistItem): string {
  return [
    item.task.episodeNo !== undefined ? `第 ${item.task.episodeNo} 集` : undefined,
    item.task.resolution,
    item.task.normalizedVideoCodec,
    item.size !== undefined ? formatBytes(item.size) : undefined
  ].filter(Boolean).join(" · ") || "已完成视频";
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

/** 构建 ArtPlayer 多轨字幕设置菜单。 */
function createSubtitleSetting(subtitles: RemotePlaybackSubtitle[]): Setting {
  const defaultSubtitle = subtitles.find((subtitle) => subtitle.default) ?? subtitles[0];
  return {
    name: "remote-subtitles",
    html: "字幕",
    tooltip: escapeHtml(defaultSubtitle.label),
    selector: [
      { html: "关闭", value: "off" },
      ...subtitles.map((subtitle) => ({
        html: escapeHtml(subtitle.label),
        value: subtitle.id,
        default: subtitle.id === defaultSubtitle.id
      }))
    ],
    async onSelect(item) {
      const subtitle = subtitles.find((entry) => entry.id === item.value);
      if (!subtitle) {
        this.subtitle.show = false;
        return "关闭";
      }
      try {
        await switchArtPlayerSubtitle(this, subtitle);
        console.info("[remote] ArtPlayer 字幕已切换", { subtitleId: subtitle.id });
        return escapeHtml(subtitle.label);
      } catch (caught) {
        console.error("[remote] ArtPlayer 字幕切换失败", { subtitleId: subtitle.id, error: caught });
        this.notice.show = "字幕加载失败";
        return escapeHtml(subtitle.label);
      }
    }
  };
}

/** 切换并显示远程会话中的指定字幕轨道。 */
async function switchArtPlayerSubtitle(player: Artplayer, subtitle: RemotePlaybackSubtitle): Promise<void> {
  const subtitleUrl = new URL(subtitle.url, window.location.origin).toString();
  await player.subtitle.switch(subtitleUrl, {
    name: subtitle.label,
    type: subtitle.type,
    encoding: "utf-8"
  });
  player.subtitle.show = true;
}

/** 转义写入 ArtPlayer HTML 插槽的媒体元数据。 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[character] ?? character);
}
