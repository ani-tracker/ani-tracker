import {
  Bell,
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from "@/components/ui/sidebar";
import { DiscoveryPage } from "@/features/discovery/DiscoveryPage";
import { DownloadsPage } from "@/features/downloads/DownloadsPage";
import { HomePage } from "@/features/home/HomePage";
import { MyAnimePage } from "@/features/my-anime/MyAnimePage";
import { NotificationsPage } from "@/features/notifications/NotificationsPage";
import { ReleaseSearchPage } from "@/features/release-search/ReleaseSearchPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { SourcesPage } from "@/features/sources/SourcesPage";

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
    case "notifications":
      return <NotificationsPage />;
    case "sources":
      return <SourcesPage />;
    case "settings":
      return <SettingsPage />;
  }
}

export function App() {
  const [activePage, setActivePage] = useState<PageId>("home");

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="flex h-16 items-center justify-center px-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <PlayCircle className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">Ani Tracker</div>
              <div className="text-xs text-sidebar-foreground/60">追番与下载管理</div>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const selected = activePage === item.id;

                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton isActive={selected} onClick={() => setActivePage(item.id)}>
                        <Icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="text-xs text-sidebar-foreground/60">
          <div className="font-medium text-sidebar-foreground">内置下载核心</div>
          <div className="mt-1">qBittorrent 兼容模式预留</div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <div className="p-6">{renderPage(activePage)}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
