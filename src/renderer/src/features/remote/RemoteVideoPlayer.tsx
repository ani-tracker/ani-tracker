import Artplayer from "artplayer";
import Hls from "hls.js";
import { LoaderCircle } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { PlayerChrome } from "@/features/player/PlayerChrome";
import { PlayerEpisodeList } from "@/features/player/PlayerEpisodeList";
import { PlayerErrorState } from "@/features/player/PlayerErrorState";
import { PlayerMobileDetails } from "@/features/player/PlayerMobileDetails";
import { PlayerPlaylistSheet } from "@/features/player/PlayerPlaylistSheet";
import {
  buildPlayerEpisodeItems,
  type PlayerEpisodeUiItem
} from "@/features/player/player-ui-model";
import {
  appApi,
  closeRemotePlaybackSession,
  createRemoteExternalPlaybackSession
} from "@/lib/api";
import { cn } from "@/lib/cn";
import type {
  RemotePlaybackRequestMode,
  RemotePlaybackSession,
  RemotePlaybackSubtitle
} from "@shared/contracts";
import type { Anime, DownloadTask, Episode } from "@shared/domain";
import type { PlayerAspectRatio } from "@shared/player-contract";
import {
  buildExternalPlayerProtocolUrl,
  detectExternalPlayer
} from "./external-player-launch";
import type { PlaybackSessionClient } from "./playback-session-client";
import type { RemotePlaylistItem } from "./remote-player-model";

const TOOLBAR_HIDE_DELAY_MS = 3_000;

interface RemoteVideoPlayerProps {
  activeItem: RemotePlaylistItem | null;
  allowExternalPlayback: boolean;
  anime?: Anime;
  downloadTasks: DownloadTask[];
  environment: "desktop" | "remote";
  episodes: Episode[];
  error: string | null;
  loading: boolean;
  onClose: () => void;
  onSelectItem: (item: RemotePlaylistItem) => void;
  playlist: RemotePlaylistItem[];
  sessionClient: PlaybackSessionClient;
}

/** 使用 ArtPlayer 处理远程网页视频，并由统一控制层承载全部交互。 */
export function RemoteVideoPlayer({
  activeItem,
  allowExternalPlayback,
  anime,
  downloadTasks,
  environment,
  episodes,
  error: loadError,
  loading,
  onClose,
  onSelectItem,
  playlist,
  sessionClient
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [externalPlayerOpening, setExternalPlayerOpening] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string>();
  const [fullscreen, setFullscreen] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const externalPlayer = useMemo(
    () => allowExternalPlayback
      ? detectExternalPlayer(navigator.userAgent, navigator.platform)
      : undefined,
    [allowExternalPlayback]
  );
  const activeIndex = useMemo(
    () => activeItem ? playlist.findIndex((item) => item.id === activeItem.id) : -1,
    [activeItem, playlist]
  );
  const previousItem = activeIndex > 0 ? playlist[activeIndex - 1] : undefined;
  const nextItem = activeIndex >= 0 && activeIndex < playlist.length - 1
    ? playlist[activeIndex + 1]
    : undefined;
  const animeTitle = anime?.title ?? activeItem?.task.animeTitle ?? "Ani Tracker";
  const episodeLabel = activeItem?.task.episodeNo === undefined
    ? "当前视频"
    : `第 ${String(activeItem.task.episodeNo).padStart(2, "0")} 集`;
  const episodeItems = useMemo(() => buildPlayerEpisodeItems({
    activeItem,
    currentTimeSeconds,
    downloadTasks,
    durationSeconds,
    episodes,
    playlist,
    session
  }), [activeItem, currentTimeSeconds, downloadTasks, durationSeconds, episodes, playlist, session]);

  useEffect(() => {
    onSelectItemRef.current = onSelectItem;
  }, [onSelectItem]);

  /** 清理并重新安排控制层的自动隐藏计时。 */
  const scheduleToolbarHide = useCallback((): void => {
    window.clearTimeout(toolbarTimerRef.current);
    if (!session || playlistOpen || panelOpen || playbackError || loadError || !playing || buffering) {
      return;
    }
    toolbarTimerRef.current = window.setTimeout(() => {
      setToolbarVisible(false);
    }, TOOLBAR_HIDE_DELAY_MS);
  }, [buffering, loadError, panelOpen, playbackError, playing, playlistOpen, session]);

  /** 响应指针或键盘活动，重新呼出控制层并重置计时。 */
  const revealToolbar = useCallback((): void => {
    setToolbarVisible(true);
    scheduleToolbarHide();
  }, [scheduleToolbarHide]);

  useEffect(() => {
    if (playlistOpen || panelOpen || playbackError || loadError || !session || !playing || buffering) {
      window.clearTimeout(toolbarTimerRef.current);
      setToolbarVisible(true);
      return;
    }
    scheduleToolbarHide();
    return () => window.clearTimeout(toolbarTimerRef.current);
  }, [buffering, loadError, panelOpen, playbackError, playing, playlistOpen, scheduleToolbarHide, session]);

  useEffect(() => {
    if (!activeItem) {
      return;
    }
    let active = true;
    let createdSession: RemotePlaybackSession | undefined;
    setSession(null);
    setPlaybackError(null);
    setBuffering(true);
    setPlaying(false);
    setCurrentTimeSeconds(0);
    setBufferedSeconds(0);

    // 延迟到微任务阶段，避免 React 严格模式的探测挂载重复创建媒体会话。
    queueMicrotask(() => {
      if (!active) return;
      console.info("[remote] 正在创建播放会话", {
        taskId: activeItem.task.id,
        fileIndex: activeItem.fileIndex,
        requestedMode
      });
      void sessionClient.create(activeItem.task.id, requestedMode, activeItem.fileIndex)
        .then((result) => {
          createdSession = result;
          if (!active) return sessionClient.close(result.id);
          setSession(result);
          setDurationSeconds(result.durationSeconds ?? 0);
          console.info("[remote] 播放会话已创建", {
            taskId: activeItem.task.id,
            fileIndex: result.fileIndex,
            mode: result.mode
          });
        })
        .catch((caught) => {
          if (!active) return;
          console.error("[remote] 播放会话创建失败", {
            taskId: activeItem.task.id,
            fileIndex: activeItem.fileIndex,
            requestedMode,
            error: caught
          });
          setBuffering(false);
          setPlaybackError(caught instanceof Error ? caught.message : "播放会话创建失败");
        });
    });

    return () => {
      active = false;
      if (createdSession) void sessionClient.close(createdSession.id);
    };
  }, [activeItem, requestedMode, retryNonce, sessionClient]);

  /** 原文件发生媒体错误时仅自动升级一次实时转码。 */
  const startAutomaticTranscode = useCallback((): void => {
    if (!activeItem || requestedMode !== "direct" || automaticFallbackStartedRef.current) return;
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
    if (!container || !session || !activeItem) return;

    let hls: Hls | undefined;
    let progressReported = false;
    const streamUrl = new URL(session.streamUrl, window.location.origin).toString();
    const defaultSubtitle = session.subtitles.find((subtitle) => subtitle.default) ?? session.subtitles[0];
    const handlePlaybackError = (message: string): void => {
      setBuffering(false);
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
        setting: false,
        subtitleOffset: false,
        playbackRate: false,
        aspectRatio: false,
        pip: false,
        airplay: false,
        fullscreen: false,
        fullscreenWeb: false,
        hotkey: false,
        mutex: true,
        playsInline: true,
        lock: false,
        fastForward: false,
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
              if (data.fatal) handlePlaybackError("实时转码视频流中断，请重试");
            });
          }
        }
      }, () => {
        setBuffering(false);
        setDurationSeconds(player.duration || session.durationSeconds || 0);
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
      setBuffering(false);
      setPlaybackError("播放器初始化失败，请重试");
      return;
    }
    artPlayerRef.current = player;

    /** 达到阈值后按当前任务只上报一次观看进度。 */
    const reportPlaybackProgress = (percent: number): void => {
      if (progressReported || percent < 90) return;
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

    player.on("video:error", () => handlePlaybackError(
      session.mode === "direct"
        ? "浏览器无法解码当前原文件"
        : "浏览器无法播放当前转码视频流，请重试"
    ));
    player.on("video:play", () => setPlaying(true));
    player.on("video:pause", () => setPlaying(false));
    player.on("video:playing", () => setBuffering(false));
    player.on("video:waiting", () => setBuffering(true));
    player.on("video:stalled", () => setBuffering(true));
    player.on("video:loadedmetadata", () => setDurationSeconds(player.duration || session.durationSeconds || 0));
    player.on("video:progress", () => setBufferedSeconds(player.loadedTime || 0));
    player.on("video:volumechange", () => {
      setVolume(player.volume);
      setMuted(player.muted);
    });
    player.on("video:ratechange", () => setPlaybackRate(player.playbackRate));
    player.on("fullscreen", setFullscreen);
    player.on("fullscreenWeb", setFullscreen);
    player.on("pip", setPictureInPicture);
    player.on("video:timeupdate", () => {
      const duration = player.duration;
      setCurrentTimeSeconds(player.currentTime || 0);
      setDurationSeconds(duration || session.durationSeconds || 0);
      setBufferedSeconds(player.loadedTime || 0);
      if (!progressReported && Number.isFinite(duration) && duration > 0) {
        reportPlaybackProgress(player.currentTime / duration * 100);
      }
    });
    player.on("video:ended", () => {
      reportPlaybackProgress(100);
      setPlaying(false);
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
      void switchArtPlayerSubtitle(player, defaultSubtitle).then(() => {
        setSelectedSubtitleId(defaultSubtitle.id);
      }).catch((caught) => {
        console.error("[remote] 默认字幕加载失败", {
          taskId: activeItem.task.id,
          subtitleId: defaultSubtitle.id,
          error: caught
        });
      });
    } else {
      setSelectedSubtitleId(undefined);
    }

    return () => {
      if (artPlayerRef.current === player) artPlayerRef.current = null;
      hls?.destroy();
      player.destroy(true);
    };
  }, [activeItem, nextItem, session, startAutomaticTranscode]);

  /** 手动切换播放模式，并允许下次直传失败时再次自动升级。 */
  const handleModeChange = (value: RemotePlaybackRequestMode): void => {
    if (value === requestedMode) return;
    automaticFallbackStartedRef.current = value === "transcode";
    setPlaybackError(null);
    setRequestedMode(value);
    console.info("[remote] 手动切换播放模式", {
      taskId: activeItem?.task.id,
      requestedMode: value
    });
  };

  /** 创建外部拉流会话并调用远程设备本机播放器。 */
  const handleExternalPlayback = async (): Promise<void> => {
    if (!activeItem || !externalPlayer || externalPlayerOpening) return;
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
      window.location.assign(buildExternalPlayerProtocolUrl(externalPlayer.kind, mediaUrl));
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
      if (externalSession) void closeRemotePlaybackSession(externalSession.id);
      if (wasPlaying && currentPlayer) void currentPlayer.play().catch(() => undefined);
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
  const selectEpisode = (item: PlayerEpisodeUiItem): void => {
    if (item.playlistItem && item.playlistItem.id !== activeItem?.id) onSelectItem(item.playlistItem);
    setPlaylistOpen(false);
  };

  /** 在竖屏滚动到页面列表，其余布局打开右侧 Sheet。 */
  const openPlaylist = (): void => {
    const usesInlinePlaylist = environment === "remote"
      && window.matchMedia("(max-width: 767px) and (orientation: portrait)").matches;
    if (usesInlinePlaylist) {
      document.getElementById("player-inline-playlist")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setPlaylistOpen(true);
  };

  /** 切换 ArtPlayer 播放状态。 */
  const togglePlayback = (): void => {
    const player = artPlayerRef.current;
    if (!player) return;
    if (player.playing) {
      player.pause();
    } else {
      void player.play().catch(() => setPlaybackError("浏览器阻止了视频播放，请重试"));
    }
  };

  /** 跳转到合法媒体时间。 */
  const seekTo = (seconds: number): void => {
    const player = artPlayerRef.current;
    if (!player) return;
    player.currentTime = Math.max(0, Math.min(player.duration || durationSeconds || 0, seconds));
  };

  /** 切换 ArtPlayer 字幕轨道或关闭字幕。 */
  const changeSubtitle = (subtitleId?: string): void => {
    const player = artPlayerRef.current;
    if (!player) return;
    const subtitle = session?.subtitles.find((item) => item.id === subtitleId);
    if (!subtitle) {
      player.subtitle.show = false;
      setSelectedSubtitleId(undefined);
      return;
    }
    void switchArtPlayerSubtitle(player, subtitle).then(() => {
      setSelectedSubtitleId(subtitle.id);
      console.info("[remote] ArtPlayer 字幕已切换", { subtitleId: subtitle.id });
    }).catch((caught) => {
      console.error("[remote] ArtPlayer 字幕切换失败", { subtitleId: subtitle.id, error: caught });
      toast.error("字幕加载失败");
    });
  };

  /** 设置视频比例并保持默认模式不裁切。 */
  const setAspectRatio = (aspectRatio: PlayerAspectRatio): void => {
    const player = artPlayerRef.current;
    if (!player) return;
    player.template.$video.style.objectFit = aspectRatio === "fill" ? "cover" : "contain";
    player.aspectRatio = aspectRatio === "16:9" || aspectRatio === "4:3" ? aspectRatio : "default";
  };

  /** 处理播放器获得焦点后的快捷键。 */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    const key = event.key.toLowerCase();
    if ([" ", "arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) event.preventDefault();
    if (key === " ") togglePlayback();
    if (key === "arrowleft") seekTo(currentTimeSeconds - 10);
    if (key === "arrowright") seekTo(currentTimeSeconds + 10);
    if (key === "arrowup") artPlayerRef.current && (artPlayerRef.current.volume = Math.min(1, volume + 0.05));
    if (key === "arrowdown") artPlayerRef.current && (artPlayerRef.current.volume = Math.max(0, volume - 0.05));
    if (key === "m" && artPlayerRef.current) artPlayerRef.current.muted = !artPlayerRef.current.muted;
    if (key === "f" && artPlayerRef.current) artPlayerRef.current.fullscreen = !artPlayerRef.current.fullscreen;
    if (key === "l") openPlaylist();
    if (key === "p" && previousItem) onSelectItem(previousItem);
    if (key === "n" && nextItem) onSelectItem(nextItem);
    if (key === "c") changeSubtitle(selectedSubtitleId ? undefined : session?.subtitles[0]?.id);
    revealToolbar();
  };

  /** 点击空白视频区域切换控制层可见性。 */
  const handleSurfaceClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if ((event.target as Element).closest("[data-player-controls], [role='dialog']")) return;
    setToolbarVisible((visible) => !visible);
  };

  /** 双击视频左右区域快退或快进，中部切换播放状态。 */
  const handleSurfaceDoubleClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if ((event.target as Element).closest("[data-player-controls], [role='dialog']")) return;
    const stage = event.currentTarget.querySelector<HTMLElement>(".player-video-stage");
    if (!stage) return;
    const bounds = stage.getBoundingClientRect();
    const relativeX = (event.clientX - bounds.left) / Math.max(bounds.width, 1);
    if (relativeX < 1 / 3) {
      seekTo(currentTimeSeconds - 10);
    } else if (relativeX > 2 / 3) {
      seekTo(currentTimeSeconds + 10);
    } else {
      togglePlayback();
    }
    revealToolbar();
  };

  const statusBadges = [
    session?.mode === "hls" ? "实时转码" : session ? "原文件直传" : undefined,
    session ? `${session.subtitles.length} 条字幕` : undefined,
    activeItem?.task.resolution?.toUpperCase()
  ].filter((value): value is string => Boolean(value));

  return (
    <main
      className={cn("player-page", environment === "desktop" ? "player-page-desktop" : "player-page-remote")}
      data-player-environment={environment}
      onClick={handleSurfaceClick}
      onDoubleClick={handleSurfaceDoubleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        revealToolbar();
      }}
      onPointerMove={revealToolbar}
      tabIndex={0}
    >
      <section className="player-video-stage" aria-label={`${animeTitle} ${episodeLabel} 视频播放器`}>
        <div ref={playerContainerRef} className="absolute inset-0" data-artplayer-surface />
        {(loading || (activeItem && !session && !playbackError)) && !loadError && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black text-white">
            <Skeleton className="absolute inset-0 size-full rounded-none bg-black" />
            <div className="relative flex flex-col items-center gap-2 text-sm">
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              <span>正在准备视频</span>
            </div>
          </div>
        )}
        {(loadError || playbackError) && (
          <PlayerErrorState
            message={loadError ?? playbackError ?? "未知播放错误"}
            onClose={onClose}
            onRetry={playbackError ? () => setRetryNonce((value) => value + 1) : undefined}
            onTranscode={playbackError && requestedMode === "direct" ? startAutomaticTranscode : undefined}
            title={loadError ? "播放器无法打开" : "播放失败"}
          />
        )}
        <PlayerChrome
          animeTitle={animeTitle}
          bufferedSeconds={bufferedSeconds}
          buffering={buffering}
          canGoNext={Boolean(nextItem)}
          canGoPrevious={Boolean(previousItem)}
          currentTimeSeconds={currentTimeSeconds}
          durationSeconds={durationSeconds}
          episodeLabel={episodeLabel}
          externalPlayerLabel={externalPlayer?.label}
          externalPlayerOpening={externalPlayerOpening}
          fullscreen={fullscreen}
          mode={requestedMode}
          muted={muted}
          onActivity={revealToolbar}
          onChangeMode={handleModeChange}
          onChangeRate={(rate) => {
            if (artPlayerRef.current) artPlayerRef.current.playbackRate = rate;
          }}
          onChangeSubtitle={changeSubtitle}
          onClose={onClose}
          onGoNext={() => nextItem && onSelectItem(nextItem)}
          onGoPrevious={() => previousItem && onSelectItem(previousItem)}
          onOpenExternalPlayer={externalPlayer ? () => void handleExternalPlayback() : undefined}
          onOpenPlaylist={openPlaylist}
          onPanelOpenChange={setPanelOpen}
          onSeek={seekTo}
          onSetAspectRatio={setAspectRatio}
          onSetVolume={(value) => {
            if (artPlayerRef.current) {
              artPlayerRef.current.muted = false;
              artPlayerRef.current.volume = value;
            }
          }}
          onToggleFullscreen={() => {
            if (artPlayerRef.current) artPlayerRef.current.fullscreen = !artPlayerRef.current.fullscreen;
          }}
          onToggleMute={() => {
            if (artPlayerRef.current) artPlayerRef.current.muted = !artPlayerRef.current.muted;
          }}
          onTogglePictureInPicture={() => {
            if (artPlayerRef.current) artPlayerRef.current.pip = !artPlayerRef.current.pip;
          }}
          onTogglePlay={togglePlayback}
          pictureInPicture={pictureInPicture}
          playbackRate={playbackRate}
          playing={playing}
          selectedSubtitleId={selectedSubtitleId}
          statusBadges={statusBadges}
          subtitles={session?.subtitles ?? []}
          visible={toolbarVisible}
          volume={volume}
        />
      </section>

      {environment === "remote" && (
        <div className="player-mobile-content">
          <PlayerMobileDetails
            activeItem={activeItem}
            anime={anime}
            currentTimeSeconds={currentTimeSeconds}
            episodes={episodes}
            session={session}
          />
          <div id="player-inline-playlist" className="scroll-mt-[calc(56.25vw+0.5rem)] pb-[max(1rem,var(--safe-area-bottom))]">
            <PlayerEpisodeList animeTitle={animeTitle} items={episodeItems} onSelect={selectEpisode} />
          </div>
        </div>
      )}

      <PlayerPlaylistSheet
        animeTitle={animeTitle}
        items={episodeItems}
        onOpenChange={setPlaylistOpen}
        onSelect={selectEpisode}
        open={playlistOpen}
      />
    </main>
  );
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
