import {
  Bell,
  Download,
  Home,
  Library,
  Search,
  Settings,
  Sparkles,
  Subtitles
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppShell, type AppShellStatus } from "@/components/app-shell";
import { AnimeDetailPage, type AnimeDetailLibraryAction } from "@/features/anime-detail/AnimeDetailPage";
import {
  DiscoveryPage,
  DiscoverySchedulePage,
  type SeasonTarget
} from "@/features/discovery/DiscoveryPage";
import { DownloadsPage } from "@/features/downloads/DownloadsPage";
import { HomePage } from "@/features/home/HomePage";
import { MyAnimePage } from "@/features/my-anime/MyAnimePage";
import { NotificationsPage } from "@/features/notifications/NotificationsPage";
import { ReleaseSearchPage } from "@/features/release-search/ReleaseSearchPage";
import { RemotePairingPage } from "@/features/remote/RemotePairingPage";
import { RemoteDiscoveryPage } from "@/features/remote/RemoteDiscoveryPage";
import { RemoteDownloadsPage } from "@/features/remote/RemoteDownloadsPage";
import { RemoteMyAnimePage } from "@/features/remote/RemoteMyAnimePage";
import { RemotePlayerPage, resolveRemotePlayerTaskId } from "@/features/remote/RemotePlayerPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { PlayerDesignPreview } from "@/features/player/PlayerDesignPreview";
import { DesktopPlayerPage } from "@/features/player/DesktopPlayerPage";
import { DesktopVlcHostPage } from "@/features/player/DesktopVlcHostPage";
import { SourcesPage } from "@/features/sources/SourcesPage";
import { appApi, getRemotePairingState, isElectronClient, REMOTE_AUTH_CHANGED_EVENT } from "@/lib/api";
import type { Anime } from "@shared/domain";
import type { MyAnimePageIntent } from "@/features/my-anime/MyAnimePage";
import {
  isDesktopVlcHostView,
  resolveDesktopPlayerWindowInput
} from "@shared/desktop-player-route";
import {
  resolvePlaybackFileIndex,
  usesBuiltinPlayer,
  type MediaPlaybackTarget
} from "@shared/player-selection";

type PageId = "home" | "myAnime" | "discovery" | "releaseSearch" | "downloads" | "notifications" | "sources" | "settings";

const navItems = [
  { id: "home", label: "首页", icon: Home },
  { id: "myAnime", label: "我的追番", icon: Library },
  { id: "discovery", label: "新番发现", icon: Sparkles },
  { id: "releaseSearch", label: "资源搜索", icon: Search },
  { id: "downloads", label: "下载队列", icon: Download },
  { id: "notifications", label: "提醒中心", icon: Bell },
  { id: "sources", label: "下载源", icon: Subtitles },
  { id: "settings", label: "设置", icon: Settings }
] satisfies Array<{ id: PageId; label: string; icon: typeof Home }>;

const remotePageIds: PageId[] = ["home", "myAnime", "discovery", "downloads", "notifications"];

interface AnimeDetailOrigin {
  pageId: PageId;
  label: string;
  scrollTop: number;
  focusElement: HTMLElement | null;
}

interface AnimeDetailState {
  animeId: string;
  origin: AnimeDetailOrigin;
}

interface DiscoveryScheduleState {
  target: SeasonTarget;
  scrollTop: number;
  focusElement: HTMLElement | null;
}

interface ReleaseSearchIntent {
  keyword: string;
  key: number;
}

interface RenderPageOptions {
  onOpenAnimeDetail: (animeId: string) => void;
  onOpenDownloads: () => void;
  onOpenLibraryAction: (animeId: string, action: AnimeDetailLibraryAction) => void;
  onOpenReleaseSearch: (anime: Anime) => void;
  onOpenDiscoverySchedule: (target: SeasonTarget) => void;
  onPlayMedia: (target: MediaPlaybackTarget) => Promise<void>;
  myAnimeIntent: MyAnimePageIntent | null;
  onMyAnimeIntentHandled: () => void;
  releaseSearchIntent: ReleaseSearchIntent | null;
}

/** 根据导航标识渲染对应业务页面。 */
function renderPage(page: PageId, electronClient: boolean, options: RenderPageOptions) {
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
      return electronClient ? (
        <MyAnimePage
          intent={options.myAnimeIntent}
          onIntentHandled={options.onMyAnimeIntentHandled}
          onOpenAnimeDetail={options.onOpenAnimeDetail}
          onPlayMedia={options.onPlayMedia}
        />
      ) : <RemoteMyAnimePage onOpenAnimeDetail={options.onOpenAnimeDetail} />;
    case "discovery":
      return electronClient ? (
        <DiscoveryPage
          onOpenAnimeDetail={options.onOpenAnimeDetail}
          onOpenSchedule={options.onOpenDiscoverySchedule}
        />
      ) : <RemoteDiscoveryPage onOpenAnimeDetail={options.onOpenAnimeDetail} />;
    case "releaseSearch":
      return <ReleaseSearchPage initialIntent={options.releaseSearchIntent} />;
    case "downloads":
      return electronClient ? <DownloadsPage /> : <RemoteDownloadsPage />;
    case "notifications":
      return <NotificationsPage />;
    case "sources":
      return <SourcesPage />;
    case "settings":
      return <SettingsPage />;
  }
}

/** 按当前窗口用途渲染主界面或独立播放器。 */
export function App() {
  if (isDesktopVlcHostView(window.location.search)) {
    return <DesktopVlcHostPage />;
  }
  const playerPreview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("playerPreview")
    : null;
  if (playerPreview) {
    return <PlayerDesignPreview mode={playerPreview} />;
  }
  const desktopPlayerTarget = isElectronClient()
    ? resolveDesktopPlayerWindowInput(window.location.search)
    : null;
  if (desktopPlayerTarget) {
    return (
      <DesktopPlayerPage
        initialFileIndex={desktopPlayerTarget.fileIndex}
        onClose={() => {
          try {
            appApi.closeDesktopPlayerWindow();
          } catch (error) {
            console.error("[player] 独立播放器窗口关闭失败", error);
          }
        }}
        taskId={desktopPlayerTarget.taskId}
      />
    );
  }
  return <MainApplication />;
}

/** 渲染适配桌面、平板和移动端的应用主界面。 */
function MainApplication() {
  const [activePage, setActivePage] = useState<PageId>("home");
  const [detailView, setDetailView] = useState<AnimeDetailState | null>(null);
  const [discoverySchedule, setDiscoverySchedule] = useState<DiscoveryScheduleState | null>(null);
  const [detailActionHostActive, setDetailActionHostActive] = useState(false);
  const [detailRevision, setDetailRevision] = useState(0);
  const [myAnimeIntent, setMyAnimeIntent] = useState<MyAnimePageIntent | null>(null);
  const [releaseSearchIntent, setReleaseSearchIntent] = useState<ReleaseSearchIntent | null>(null);
  const [pairingState, setPairingState] = useState(getRemotePairingState);
  const [unreadCount, setUnreadCount] = useState(0);
  const [shellStatus, setShellStatus] = useState<AppShellStatus>({
    state: "unknown",
    label: "状态读取中",
    detail: "正在连接服务"
  });
  const contentRef = useRef<HTMLElement | null>(null);
  const detailViewRef = useRef<AnimeDetailState | null>(null);
  const discoveryScheduleRef = useRef<DiscoveryScheduleState | null>(null);
  detailViewRef.current = detailView;
  discoveryScheduleRef.current = discoverySchedule;
  const electronClient = isElectronClient();
  const framelessWindow = electronClient && window.aniBridge?.platform === "win32";
  const remotePlayerTaskId = electronClient
    ? undefined
    : resolveRemotePlayerTaskId(window.location.pathname);
  const availableNavItems = electronClient
    ? navItems
    : navItems.filter((item) => remotePageIds.includes(item.id));

  /** 记录来源页面上下文并进入详情二级视图。 */
  function openAnimeDetail(animeId: string) {
    const originItem = navItems.find((item) => item.id === activePage);
    const origin: AnimeDetailOrigin = {
      pageId: activePage,
      label: originItem?.label ?? "上一页",
      scrollTop: contentRef.current?.scrollTop ?? 0,
      focusElement: document.activeElement instanceof HTMLElement ? document.activeElement : null
    };
    const nextState = { aniView: "animeDetail", animeId };
    window.history.pushState(nextState, "");
    setDetailActionHostActive(false);
    setDetailRevision(0);
    setMyAnimeIntent(null);
    setDetailView({ animeId, origin });
    window.requestAnimationFrame(() => contentRef.current?.scrollTo({ top: 0, behavior: "auto" }));
  }

  /** 从详情返回来源页，并恢复滚动位置和触发元素焦点。 */
  function restoreDetailView() {
    const origin = detailViewRef.current?.origin;
    setDetailActionHostActive(false);
    setMyAnimeIntent(null);
    setDetailView(null);
    if (!origin) return;
    window.requestAnimationFrame(() => {
      contentRef.current?.scrollTo({ top: origin.scrollTop, behavior: "auto" });
      origin.focusElement?.focus({ preventScroll: true });
      console.info("[anime-detail] navigation restored", {
        pageId: origin.pageId,
        scrollTop: origin.scrollTop
      });
    });
  }

  /** 进入独立时间表并保留发现页的滚动与焦点上下文。 */
  function openDiscoverySchedule(target: SeasonTarget) {
    const nextState: DiscoveryScheduleState = {
      target,
      scrollTop: contentRef.current?.scrollTop ?? 0,
      focusElement: document.activeElement instanceof HTMLElement ? document.activeElement : null
    };
    window.history.pushState({ aniView: "discoverySchedule", target }, "");
    setDiscoverySchedule(nextState);
    window.requestAnimationFrame(() => contentRef.current?.scrollTo({ top: 0, behavior: "auto" }));
    console.info("[discovery] 已打开新番时间表", target);
  }

  /** 返回新番发现并恢复进入时间表前的滚动与焦点。 */
  function restoreDiscoverySchedule() {
    const origin = discoveryScheduleRef.current;
    setDiscoverySchedule(null);
    if (!origin) return;
    window.requestAnimationFrame(() => {
      contentRef.current?.scrollTo({ top: origin.scrollTop, behavior: "auto" });
      origin.focusElement?.focus({ preventScroll: true });
    });
  }

  /** 关闭详情并切换到指定业务页，供详情快捷操作使用。 */
  function leaveDetailToPage(pageId: PageId) {
    if (detailViewRef.current) {
      window.history.replaceState({ aniView: "page", pageId }, "");
      setDetailActionHostActive(false);
      setMyAnimeIntent(null);
      setDetailView(null);
    }
    setDiscoverySchedule(null);
    setActivePage(pageId);
    window.requestAnimationFrame(() => contentRef.current?.scrollTo({ top: 0, behavior: "auto" }));
  }

  /** 从详情页打开追番规则、资源或任务面板。 */
  function openLibraryAction(animeId: string, action: AnimeDetailLibraryAction) {
    if (!electronClient) {
      leaveDetailToPage("myAnime");
      return;
    }
    setDetailActionHostActive(true);
    setMyAnimeIntent({ animeId, action, key: Date.now() });
    console.info("[anime-detail] library action opened in place", { animeId, action });
  }

  /** 将未追番资源搜索请求带入资源搜索页。 */
  function openReleaseSearch(anime: Anime) {
    setReleaseSearchIntent({
      keyword: anime.title,
      key: Date.now()
    });
    leaveDetailToPage("releaseSearch");
  }

  /** 主导航切换时退出详情并回到页面顶部。 */
  function navigatePage(pageId: PageId) {
    if (detailViewRef.current || discoveryScheduleRef.current) {
      window.history.replaceState({ aniView: "page", pageId }, "");
      setDetailActionHostActive(false);
      setMyAnimeIntent(null);
      setDetailView(null);
      setDiscoverySchedule(null);
    }
    setActivePage(pageId);
  }

  /** 按默认播放器配置打开独立内置窗口或调用外部播放器。 */
  async function playMedia(target: MediaPlaybackTarget): Promise<void> {
    const settings = await appApi.getSettings();
    if (!usesBuiltinPlayer(settings)) {
      await appApi.playMedia(target.filePath);
      return;
    }
    if (!target.taskId) {
      throw new Error("当前媒体缺少下载任务关联，无法使用内置播放器");
    }
    let fileIndex = target.fileIndex;
    if (fileIndex === undefined) {
      const task = (await appApi.listDownloads()).find((item) => item.id === target.taskId);
      if (task) {
        fileIndex = resolvePlaybackFileIndex(target, task);
      }
    }
    const playerTarget = {
      taskId: target.taskId,
      ...(fileIndex === undefined ? {} : { fileIndex })
    };
    await appApi.openDesktopPlayerWindow(playerTarget);
    console.info("[player] 已打开独立内置播放器窗口", playerTarget);
  }

  useEffect(() => {
    if (!window.history.state?.aniView) {
      window.history.replaceState({ aniView: "page", pageId: activePage }, "");
    }
    const handlePopState = () => {
      if (detailViewRef.current) {
        restoreDetailView();
      } else if (discoveryScheduleRef.current) {
        restoreDiscoverySchedule();
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!detailView) return;
    function handleEscape(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const editable = target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      const dialogOpen = Boolean(document.querySelector('[role="dialog"][data-state="open"]'));
      if (event.key === "Escape" && window.matchMedia("(min-width: 768px)").matches && !editable && !dialogOpen) {
        event.preventDefault();
        window.history.back();
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [detailView]);

  useEffect(() => {
    /** 同步当前窗口与其他标签页的远程鉴权状态。 */
    function refreshRemoteAuth() {
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
    if (!electronClient && pairingState.needsPairing) {
      return;
    }
    let active = true;

    /** 刷新应用壳所需的未读数与下载服务状态。 */
    async function refreshShellState() {
      const [unreadResult, serviceResult] = await Promise.allSettled([
        appApi.getUnreadNotificationCount(),
        electronClient ? appApi.getQbittorrentManagedStatus() : Promise.resolve(null)
      ]);
      if (!active) {
        return;
      }
      if (unreadResult.status === "fulfilled") {
        setUnreadCount(unreadResult.value);
      } else {
        console.warn("[app-shell] 未读提醒数量刷新失败", unreadResult.reason);
      }

      if (!electronClient) {
        setShellStatus({ state: "online", label: "桌面端在线", detail: "远程同步已连接" });
      } else if (serviceResult.status === "fulfilled" && serviceResult.value) {
        setShellStatus(serviceResult.value.running
          ? { state: "online", label: "下载服务正常", detail: "qBittorrent 已连接" }
          : { state: "idle", label: "下载服务待机", detail: serviceResult.value.enabled ? "下载核心未运行" : "托管核心未启用" });
      } else {
        setShellStatus({ state: "unknown", label: "服务状态未知", detail: "稍后自动重试" });
        if (serviceResult.status === "rejected") {
          console.warn("[app-shell] 下载服务状态刷新失败", serviceResult.reason);
        }
      }
    }

    void refreshShellState();
    const refreshTimer = window.setInterval(() => void refreshShellState(), 30_000);
    window.addEventListener("focus", refreshShellState);
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", refreshShellState);
    };
  }, [electronClient, pairingState.needsPairing]);

  if (remotePlayerTaskId) {
    return <RemotePlayerPage taskId={remotePlayerTaskId} />;
  }

  if (!electronClient && pairingState.needsPairing) {
    return <RemotePairingPage onPaired={() => setPairingState(getRemotePairingState())} />;
  }

  return (
    <AppShell
      activePageId={activePage}
      items={availableNavItems}
      onNavigate={(pageId) => navigatePage(pageId as PageId)}
      contentRef={contentRef}
      secondaryView={detailView
        ? { title: "番剧详情", onBack: () => window.history.back() }
        : discoverySchedule
          ? { title: "新番时间表", onBack: () => window.history.back() }
          : undefined}
      status={shellStatus}
      unreadCount={unreadCount}
      framelessWindow={framelessWindow}
    >
      <div className={detailView || discoverySchedule ? "hidden" : undefined}>
        {renderPage(activePage, electronClient, {
          onOpenAnimeDetail: openAnimeDetail,
          onOpenDownloads: () => navigatePage("downloads"),
          onOpenLibraryAction: openLibraryAction,
          onOpenReleaseSearch: openReleaseSearch,
          onOpenDiscoverySchedule: openDiscoverySchedule,
          onPlayMedia: playMedia,
          myAnimeIntent: detailView ? null : myAnimeIntent,
          onMyAnimeIntentHandled: () => setMyAnimeIntent(null),
          releaseSearchIntent
        })}
      </div>
      {discoverySchedule && !detailView && (
        <DiscoverySchedulePage
          initialTarget={discoverySchedule.target}
          onBack={() => window.history.back()}
          onOpenAnimeDetail={openAnimeDetail}
        />
      )}
      {detailView && electronClient && detailActionHostActive && (
        <MyAnimePage
          actionOnly
          intent={myAnimeIntent}
          onDataChanged={() => setDetailRevision((revision) => revision + 1)}
          onIntentHandled={() => setMyAnimeIntent(null)}
          onPlayMedia={playMedia}
        />
      )}
      {detailView && (
        <AnimeDetailPage
          animeId={detailView.animeId}
          onBack={() => window.history.back()}
          onOpenLibraryAction={openLibraryAction}
          onOpenReleaseSearch={openReleaseSearch}
          refreshKey={detailRevision}
          sourceLabel={detailView.origin.label}
        />
      )}
    </AppShell>
  );
}
