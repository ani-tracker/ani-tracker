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
import { useEffect, useState } from "react";
import { AppShell, type AppShellStatus } from "@/components/app-shell";
import { DiscoveryPage } from "@/features/discovery/DiscoveryPage";
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
import { SourcesPage } from "@/features/sources/SourcesPage";
import { appApi, getRemotePairingState, isElectronClient, REMOTE_AUTH_CHANGED_EVENT } from "@/lib/api";

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

/** 根据导航标识渲染对应业务页面。 */
function renderPage(page: PageId, electronClient: boolean) {
  switch (page) {
    case "home":
      return <HomePage />;
    case "myAnime":
      return electronClient ? <MyAnimePage /> : <RemoteMyAnimePage />;
    case "discovery":
      return electronClient ? <DiscoveryPage /> : <RemoteDiscoveryPage />;
    case "releaseSearch":
      return <ReleaseSearchPage />;
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

/** 渲染适配桌面、平板和移动端的应用壳。 */
export function App() {
  const [activePage, setActivePage] = useState<PageId>("home");
  const [pairingState, setPairingState] = useState(getRemotePairingState);
  const [unreadCount, setUnreadCount] = useState(0);
  const [shellStatus, setShellStatus] = useState<AppShellStatus>({
    state: "unknown",
    label: "状态读取中",
    detail: "正在连接服务"
  });
  const electronClient = isElectronClient();
  const remotePlayerTaskId = electronClient
    ? undefined
    : resolveRemotePlayerTaskId(window.location.pathname);
  const availableNavItems = electronClient
    ? navItems
    : navItems.filter((item) => remotePageIds.includes(item.id));

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
      onNavigate={(pageId) => setActivePage(pageId as PageId)}
      status={shellStatus}
      unreadCount={unreadCount}
    >
      {renderPage(activePage, electronClient)}
    </AppShell>
  );
}
