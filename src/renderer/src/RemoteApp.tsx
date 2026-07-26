import { Bell, Download, Home, Library, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppShell, type AppShellStatus } from "@/components/app-shell";
import { AnimeDetailPage, type AnimeDetailLibraryAction } from "@/features/anime-detail/AnimeDetailPage";
import { HomePage } from "@/features/home/HomePage";
import { NotificationsPage } from "@/features/notifications/NotificationsPage";
import { RemoteDiscoveryPage } from "@/features/remote/RemoteDiscoveryPage";
import { RemoteDownloadsPage } from "@/features/remote/RemoteDownloadsPage";
import { RemoteMyAnimePage } from "@/features/remote/RemoteMyAnimePage";
import { RemotePairingPage } from "@/features/remote/RemotePairingPage";
import { RemotePlayerPage, resolveRemotePlayerTaskId } from "@/features/remote/RemotePlayerPage";
import {
  appApi,
  getRemotePairingState,
  REMOTE_AUTH_CHANGED_EVENT,
  type RemotePairingState
} from "@/lib/api";
import type { MediaPlaybackTarget } from "@shared/player-selection";

type RemotePageId = "home" | "myAnime" | "discovery" | "downloads" | "notifications";

const remoteNavItems = [
  { id: "home", label: "首页", icon: Home },
  { id: "myAnime", label: "我的追番", icon: Library },
  { id: "discovery", label: "新番发现", icon: Sparkles },
  { id: "downloads", label: "下载队列", icon: Download },
  { id: "notifications", label: "提醒中心", icon: Bell }
] satisfies Array<{ id: RemotePageId; label: string; icon: typeof Home }>;

interface AnimeDetailOrigin {
  pageId: RemotePageId;
  label: string;
  scrollTop: number;
  focusElement: HTMLElement | null;
}

interface AnimeDetailState {
  animeId: string;
  origin: AnimeDetailOrigin;
}

const connectedStatus: AppShellStatus = {
  state: "online",
  label: "桌面端在线",
  detail: "远程同步已连接"
};

/** 渲染桌面网关单独托管的远程 PWA。 */
export function App() {
  const playerTaskId = resolveRemotePlayerTaskId(window.location.pathname);
  if (playerTaskId) return <RemotePlayerPage taskId={playerTaskId} />;
  return <RemoteApplication />;
}

/** 管理远程 PWA 的配对、导航和详情视图。 */
function RemoteApplication() {
  const [activePage, setActivePage] = useState<RemotePageId>("home");
  const [detailView, setDetailView] = useState<AnimeDetailState | null>(null);
  const [pairingState, setPairingState] = useState<RemotePairingState>(getRemotePairingState);
  const [unreadCount, setUnreadCount] = useState(0);
  const contentRef = useRef<HTMLElement | null>(null);
  const detailViewRef = useRef<AnimeDetailState | null>(null);
  detailViewRef.current = detailView;

  /** 记录来源上下文并进入番剧详情。 */
  function openAnimeDetail(animeId: string): void {
    const originItem = remoteNavItems.find((item) => item.id === activePage);
    window.history.pushState({ aniView: "animeDetail", animeId }, "");
    setDetailView({
      animeId,
      origin: {
        pageId: activePage,
        label: originItem?.label ?? "上一页",
        scrollTop: contentRef.current?.scrollTop ?? 0,
        focusElement: document.activeElement instanceof HTMLElement ? document.activeElement : null
      }
    });
    window.requestAnimationFrame(() => contentRef.current?.scrollTo({ top: 0, behavior: "auto" }));
  }

  /** 从详情返回来源页并恢复滚动和焦点。 */
  function restoreDetailView(): void {
    const origin = detailViewRef.current?.origin;
    setDetailView(null);
    if (!origin) return;
    window.requestAnimationFrame(() => {
      contentRef.current?.scrollTo({ top: origin.scrollTop, behavior: "auto" });
      origin.focusElement?.focus({ preventScroll: true });
    });
  }

  /** 切换远程主导航并退出详情视图。 */
  function navigatePage(pageId: RemotePageId): void {
    if (detailViewRef.current) {
      window.history.replaceState({ aniView: "page", pageId }, "");
      setDetailView(null);
    }
    setActivePage(pageId);
  }

  /** 在独立标签页打开远程播放器。 */
  async function playRemoteMedia(target: MediaPlaybackTarget): Promise<void> {
    if (!target.taskId) throw new Error("当前媒体缺少下载任务关联，无法远程播放");
    const playerUrl = new URL(`/player/${encodeURIComponent(target.taskId)}`, window.location.origin);
    if (target.fileIndex !== undefined) playerUrl.searchParams.set("file", String(target.fileIndex));
    window.open(playerUrl, "_blank", "noopener,noreferrer");
    console.info("[remote] 已打开独立播放器标签页", {
      taskId: target.taskId,
      fileIndex: target.fileIndex
    });
  }

  /** 将详情中的追番操作转到只读追番页。 */
  function openLibraryAction(_animeId: string, _action: AnimeDetailLibraryAction): void {
    navigatePage("myAnime");
  }

  useEffect(() => {
    if (!window.history.state?.aniView) {
      window.history.replaceState({ aniView: "page", pageId: activePage }, "");
    }
    const handlePopState = () => {
      if (detailViewRef.current) restoreDetailView();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    /** 同步当前标签页与其他远程页面的鉴权状态。 */
    function refreshRemoteAuth(): void {
      setPairingState(getRemotePairingState());
      setActivePage("home");
    }
    window.addEventListener(REMOTE_AUTH_CHANGED_EVENT, refreshRemoteAuth);
    window.addEventListener("storage", refreshRemoteAuth);
    return () => {
      window.removeEventListener(REMOTE_AUTH_CHANGED_EVENT, refreshRemoteAuth);
      window.removeEventListener("storage", refreshRemoteAuth);
    };
  }, []);

  useEffect(() => {
    if (pairingState.needsPairing) return;
    let active = true;

    /** 刷新远程应用壳的未读提醒数量。 */
    async function refreshUnreadCount(): Promise<void> {
      try {
        const count = await appApi.getUnreadNotificationCount();
        if (active) setUnreadCount(count);
      } catch (error) {
        console.warn("[remote] 未读提醒数量刷新失败", error);
      }
    }
    void refreshUnreadCount();
    const timer = window.setInterval(() => void refreshUnreadCount(), 30_000);
    window.addEventListener("focus", refreshUnreadCount);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshUnreadCount);
    };
  }, [pairingState.needsPairing]);

  if (pairingState.needsPairing) {
    return <RemotePairingPage onPaired={() => setPairingState(getRemotePairingState())} />;
  }

  return (
    <AppShell
      activePageId={activePage}
      contentRef={contentRef}
      items={remoteNavItems}
      onNavigate={(pageId) => navigatePage(pageId as RemotePageId)}
      secondaryView={detailView ? { title: "番剧详情", onBack: () => window.history.back() } : undefined}
      status={connectedStatus}
      unreadCount={unreadCount}
    >
      <div className={detailView ? "hidden" : undefined}>
        {renderRemotePage(activePage, {
          onOpenAnimeDetail: openAnimeDetail,
          onOpenDownloads: () => navigatePage("downloads"),
          onPlayMedia: playRemoteMedia
        })}
      </div>
      {detailView && (
        <AnimeDetailPage
          animeId={detailView.animeId}
          onBack={() => window.history.back()}
          onOpenLibraryAction={openLibraryAction}
          onOpenReleaseSearch={() => undefined}
          sourceLabel={detailView.origin.label}
        />
      )}
    </AppShell>
  );
}

/** 根据远程导航标识渲染只读或受限业务页面。 */
function renderRemotePage(page: RemotePageId, options: {
  onOpenAnimeDetail: (animeId: string) => void;
  onOpenDownloads: () => void;
  onPlayMedia: (target: MediaPlaybackTarget) => Promise<void>;
}) {
  switch (page) {
    case "home":
      return (
        <HomePage
          onOpenAnimeDetail={options.onOpenAnimeDetail}
          onOpenDownloads={options.onOpenDownloads}
          onPlayMedia={options.onPlayMedia}
        />
      );
    case "myAnime":
      return <RemoteMyAnimePage onOpenAnimeDetail={options.onOpenAnimeDetail} />;
    case "discovery":
      return <RemoteDiscoveryPage onOpenAnimeDetail={options.onOpenAnimeDetail} />;
    case "downloads":
      return <RemoteDownloadsPage />;
    case "notifications":
      return <NotificationsPage />;
  }
}
