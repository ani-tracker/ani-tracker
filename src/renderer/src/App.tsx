import {
  Bell,
  Download,
  Home,
  Library,
  Menu,
  PlayCircle,
  Search,
  Settings,
  Sparkles,
  Subtitles
} from "lucide-react";
import { useState } from "react";
import {
  MobileNavigation,
  MobileNavigationButton,
  MobileNavigationList,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

const mobilePrimaryPageIds: PageId[] = ["home", "myAnime", "discovery", "releaseSearch", "downloads"];
const mobilePrimaryNavItems = navItems.filter((item) => mobilePrimaryPageIds.includes(item.id));
const mobileMoreNavItems = navItems.filter((item) => !mobilePrimaryPageIds.includes(item.id));

/** 根据导航标识渲染对应业务页面。 */
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

/** 渲染适配桌面、平板和移动端的应用壳。 */
export function App() {
  const [activePage, setActivePage] = useState<PageId>("home");

  return (
    <SidebarProvider>
      <Sidebar
        aria-label="主导航"
        className="hidden pt-[var(--safe-area-top)] md:flex md:w-[var(--sidebar-width-icon)] lg:w-[var(--sidebar-width)]"
      >
        <SidebarHeader className="flex h-16 items-center justify-center px-2 lg:px-5">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <PlayCircle className="size-5" />
            </div>
            <div className="hidden lg:block">
              <div className="text-sm font-semibold">Ani Tracker</div>
              <div className="text-xs text-sidebar-foreground/60">追番与下载管理</div>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent className="px-2 lg:px-3">
          <SidebarGroup>
            <SidebarGroupContent>
              <TooltipProvider delayDuration={300}>
                <SidebarMenu>
                  {navItems.map((item) => {
                    const Icon = item.icon;
                    const selected = activePage === item.id;

                    return (
                      <SidebarMenuItem key={item.id}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <SidebarMenuButton
                              aria-current={selected ? "page" : undefined}
                              aria-label={item.label}
                              className="justify-center px-0 lg:justify-start lg:px-3"
                              isActive={selected}
                              onClick={() => setActivePage(item.id)}
                            >
                              <Icon />
                              <span className="hidden lg:inline">{item.label}</span>
                            </SidebarMenuButton>
                          </TooltipTrigger>
                          <TooltipContent className="hidden md:block lg:hidden" side="right">
                            {item.label}
                          </TooltipContent>
                        </Tooltip>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </TooltipProvider>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="hidden text-xs text-sidebar-foreground/60 lg:block">
          <div className="font-medium text-sidebar-foreground">内置下载核心</div>
          <div className="mt-1">qBittorrent 兼容模式预留</div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-h-screen min-h-dvh">
        <div
          className="pb-[calc(var(--mobile-navigation-height)+var(--safe-area-bottom)+1rem)] pl-[max(1rem,var(--safe-area-left))] pr-[max(1rem,var(--safe-area-right))] pt-[max(1rem,var(--safe-area-top))] md:p-5 lg:p-6"
        >
          {renderPage(activePage)}
        </div>
      </SidebarInset>

      <MobileNavigation aria-label="移动端主导航">
        <MobileNavigationList>
          {mobilePrimaryNavItems.map((item) => {
            const Icon = item.icon;
            const selected = activePage === item.id;

            return (
              <li className="flex min-w-0 list-none" key={item.id}>
                <MobileNavigationButton
                  aria-current={selected ? "page" : undefined}
                  aria-label={item.label}
                  isActive={selected}
                  onClick={() => setActivePage(item.id)}
                >
                  <Icon />
                  <span>{item.label}</span>
                </MobileNavigationButton>
              </li>
            );
          })}
          <li className="flex min-w-0 list-none">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <MobileNavigationButton
                  aria-current={mobileMoreNavItems.some((item) => item.id === activePage) ? "page" : undefined}
                  aria-label="更多导航"
                  isActive={mobileMoreNavItems.some((item) => item.id === activePage)}
                >
                  <Menu />
                  <span>更多</span>
                </MobileNavigationButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40" side="top" sideOffset={8}>
                <DropdownMenuGroup>
                  {mobileMoreNavItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <DropdownMenuItem
                        className="min-h-11"
                        key={item.id}
                        onSelect={() => setActivePage(item.id)}
                      >
                        <Icon />
                        {item.label}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        </MobileNavigationList>
      </MobileNavigation>
    </SidebarProvider>
  );
}
