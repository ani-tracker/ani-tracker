import {
  CalendarDays,
  Download,
  Home,
  Library,
  PlayCircle,
  Search,
  Settings,
  Sparkles,
  Subtitles
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { DiscoveryPage } from "@/features/discovery/DiscoveryPage";
import { DownloadsPage } from "@/features/downloads/DownloadsPage";
import { HomePage } from "@/features/home/HomePage";
import { MyAnimePage } from "@/features/my-anime/MyAnimePage";
import { ReleaseSearchPage } from "@/features/release-search/ReleaseSearchPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { SourcesPage } from "@/features/sources/SourcesPage";
import { appApi } from "@/lib/api";
import type { AutomationRunResult } from "@shared/contracts";

type PageId = "home" | "myAnime" | "discovery" | "releaseSearch" | "downloads" | "sources" | "settings";

const navItems = [
  { id: "home", label: "首页", icon: Home },
  { id: "myAnime", label: "我的追番", icon: Library },
  { id: "discovery", label: "新番发现", icon: Sparkles },
  { id: "releaseSearch", label: "资源搜索", icon: Search },
  { id: "downloads", label: "下载队列", icon: Download },
  { id: "sources", label: "下载源", icon: Subtitles },
  { id: "settings", label: "设置", icon: Settings }
] satisfies Array<{ id: PageId; label: string; icon: typeof Home }>;

function renderPage(page: PageId) {
  switch (page) {
    case "home":
      return <HomePage />;
    case "myAnime":
      return <MyAnimePage />;
    case "discovery":
      return <DiscoveryPage />;
    case "releaseSearch":
      return <ReleaseSearchPage />;
    case "downloads":
      return <DownloadsPage />;
    case "sources":
      return <SourcesPage />;
    case "settings":
      return <SettingsPage />;
  }
}

export function App() {
  const [activePage, setActivePage] = useState<PageId>("home");
  const [automationRunning, setAutomationRunning] = useState(false);
  const [automationResult, setAutomationResult] = useState<AutomationRunResult | null>(null);
  const [automationError, setAutomationError] = useState<string | null>(null);

  async function runAutomation() {
    setAutomationRunning(true);
    setAutomationError(null);
    try {
      const result = await appApi.runAutomationOnce();
      setAutomationResult(result);
      setActivePage("home");
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : "扫描更新失败");
    } finally {
      setAutomationRunning(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-card">
        <div className="flex h-16 items-center gap-3 border-b px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <PlayCircle className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold">Ani Tracker</div>
            <div className="text-xs text-muted-foreground">追番与下载管理</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            const selected = activePage === item.id;

            return (
              <button
                key={item.id}
                className={cn(
                  "flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors",
                  selected
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                onClick={() => setActivePage(item.id)}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="border-t p-4 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">内置下载核心</div>
          <div className="mt-1">qBittorrent 兼容模式预留</div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <header className="flex h-16 items-center gap-3 border-b bg-card px-6">
          <div className="relative min-w-[360px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none ring-0 transition focus:border-primary"
              placeholder="搜索番剧、资源、字幕组"
            />
          </div>
          {(automationResult || automationError) && (
            <div
              className={
                automationError
                  ? "rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
                  : "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700"
              }
            >
              {automationError ??
                `扫描完成：下载 ${automationResult?.downloaded.length ?? 0}，跳过 ${
                  automationResult?.skipped.length ?? 0
                }，错误 ${automationResult?.errors.length ?? 0}`}
            </div>
          )}
          <Button variant="outline" onClick={() => void runAutomation()} disabled={automationRunning}>
            <CalendarDays className="h-4 w-4" />
            {automationRunning ? "扫描中" : "扫描更新"}
          </Button>
          <Button>
            <Library className="h-4 w-4" />
            添加追番
          </Button>
        </header>

        <div className="p-6">{renderPage(activePage)}</div>
      </main>
    </div>
  );
}
