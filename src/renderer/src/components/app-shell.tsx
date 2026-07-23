import { ArrowLeft, ArrowUp, Bell, Link2, Menu, X, type LucideIcon } from "lucide-react";
import { type CSSProperties, type MutableRefObject, type ReactNode, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { WindowControls } from "@/components/window-controls";

const APP_LOGO_SRC = "./icons/ani-tracker-mark.png";
const dragRegionStyle = { WebkitAppRegion: "drag" } as CSSProperties;
const noDragRegionStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;

export interface AppNavigationItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

export interface AppShellStatus {
  state: "online" | "idle" | "unknown";
  label: string;
  detail: string;
}

interface AppShellProps {
  activePageId: string;
  children: ReactNode;
  items: readonly AppNavigationItem[];
  onNavigate: (pageId: string) => void;
  status: AppShellStatus;
  unreadCount: number;
  secondaryView?: {
    title: string;
    onBack: () => void;
  };
  contentRef?: MutableRefObject<HTMLElement | null>;
  framelessWindow?: boolean;
}

/** 跟踪桌面宽视口，驱动 224px 完整栏和 72px 收缩栏切换。 */
function useExpandedDesktopSidebar() {
  const [expanded, setExpanded] = useState(() => window.matchMedia("(min-width: 1280px)").matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1280px)");
    const updateExpanded = () => setExpanded(mediaQuery.matches);
    mediaQuery.addEventListener("change", updateExpanded);
    return () => mediaQuery.removeEventListener("change", updateExpanded);
  }, []);

  return expanded;
}

/** 渲染 Stitch 规范下统一的桌面侧栏、移动导航 Sheet 与内容滚动区。 */
export function AppShell({
  activePageId,
  children,
  items,
  onNavigate,
  status,
  unreadCount,
  secondaryView,
  contentRef,
  framelessWindow = false
}: AppShellProps) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [showDiscoveryScrollTop, setShowDiscoveryScrollTop] = useState(false);
  const expandedDesktopSidebar = useExpandedDesktopSidebar();
  const mainRef = useRef<HTMLElement | null>(null);
  const activeItem = items.find((item) => item.id === activePageId) ?? items[0];
  const notificationsItem = items.find((item) => item.id === "notifications");
  const visibleUnreadCount = Math.min(unreadCount, 99);
  const discoveryScrollTopEnabled = activePageId === "discovery" && !secondaryView;

  useEffect(() => {
    const scrollContainer = mainRef.current;
    if (!scrollContainer || !discoveryScrollTopEnabled) {
      setShowDiscoveryScrollTop(false);
      return;
    }

    /** 根据发现页滚动距离同步回顶按钮可见性。 */
    const updateScrollTopVisibility = () => {
      setShowDiscoveryScrollTop(scrollContainer.scrollTop >= 320);
    };

    updateScrollTopVisibility();
    scrollContainer.addEventListener("scroll", updateScrollTopVisibility, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", updateScrollTopVisibility);
  }, [discoveryScrollTopEnabled]);

  /** 切换页面后关闭移动导航，并恢复主内容的滚动与键盘焦点。 */
  function navigate(pageId: string) {
    onNavigate(pageId);
    setMobileNavigationOpen(false);
    window.setTimeout(() => {
      mainRef.current?.scrollTo({ top: 0, behavior: "auto" });
      mainRef.current?.focus({ preventScroll: true });
    }, 0);
  }

  /** 将内容滚动容器同时暴露给二级页面的返回恢复逻辑。 */
  function setMainElement(element: HTMLElement | null) {
    mainRef.current = element;
    if (contentRef) {
      contentRef.current = element;
    }
  }

  /** 平滑滚动到新番发现页顶部。 */
  function scrollDiscoveryToTop() {
    mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    console.info("[discovery] 已回到页面顶部");
  }

  return (
    <TooltipProvider delayDuration={300}>
      {framelessWindow && <WindowControls />}
      <SidebarProvider
        data-frameless-window={framelessWindow ? "" : undefined}
        open={expandedDesktopSidebar}
        style={{
          "--sidebar-width": "14rem",
          "--sidebar-width-icon": "4.5rem"
        } as CSSProperties}
      >
        <Sidebar aria-label="主导航" className="hidden md:flex">
          <SidebarHeader className="h-14 justify-center border-b-0 px-3 py-2">
            <div className="flex items-center gap-2 group-data-[state=collapsed]/sidebar:justify-center">
              <img
                alt=""
                className="h-8 w-9 shrink-0 object-contain"
                draggable={false}
                src={APP_LOGO_SRC}
              />
              <div className="min-w-0 group-data-[state=collapsed]/sidebar:hidden">
                <div className="truncate text-base font-bold text-sidebar-primary">Ani-tracker</div>
                <div className="truncate text-[10px] text-sidebar-foreground/65">追番与下载管理</div>
              </div>
            </div>
          </SidebarHeader>

          <SidebarContent className="px-2 py-1">
            <SidebarGroup className="p-0">
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => {
                    const Icon = item.icon;
                    const selected = activePageId === item.id;
                    const isNotifications = item.id === "notifications";

                    return (
                      <SidebarMenuItem className="relative" key={item.id}>
                        <Tooltip open={expandedDesktopSidebar ? false : undefined}>
                          <TooltipTrigger asChild>
                            <SidebarMenuButton
                              aria-current={selected ? "page" : undefined}
                              aria-label={item.label}
                              className="group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0"
                              isActive={selected}
                              onClick={() => navigate(item.id)}
                            >
                              <Icon aria-hidden="true" />
                              <span className="truncate group-data-[state=collapsed]/sidebar:hidden">{item.label}</span>
                              {isNotifications && unreadCount > 0 && (
                                <>
                                  <Badge className="ml-auto h-5 min-w-5 justify-center px-1 group-data-[state=collapsed]/sidebar:hidden" tone="primary">
                                    {visibleUnreadCount}
                                  </Badge>
                                  <Badge className="absolute right-1 top-0 hidden size-4 justify-center p-0 text-[9px] group-data-[state=collapsed]/sidebar:inline-flex" tone="primary">
                                    {visibleUnreadCount}
                                  </Badge>
                                </>
                              )}
                            </SidebarMenuButton>
                          </TooltipTrigger>
                          <TooltipContent side="right">{item.label}</TooltipContent>
                        </Tooltip>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="flex min-h-24 flex-col justify-center gap-3 px-4 py-4 group-data-[state=collapsed]/sidebar:items-center group-data-[state=collapsed]/sidebar:px-2">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 rounded-full",
                  status.state === "online" && "bg-success",
                  status.state === "idle" && "bg-warning",
                  status.state === "unknown" && "bg-muted-foreground"
                )}
              />
              <span className="text-xs font-medium group-data-[state=collapsed]/sidebar:hidden">{status.label}</span>
            </div>
            <Tooltip open={expandedDesktopSidebar ? false : undefined}>
              <TooltipTrigger asChild>
                <div
                  aria-label={`${status.label}，${status.detail}`}
                  className="flex items-center gap-2 text-sidebar-foreground/65"
                  tabIndex={0}
                >
                  <Link2 aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate text-[11px] group-data-[state=collapsed]/sidebar:hidden">{status.detail}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">{status.label} · {status.detail}</TooltipContent>
            </Tooltip>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset
          ref={setMainElement}
          aria-label={`${activeItem?.label ?? "当前"}页面内容`}
          className="h-full max-h-full min-h-0 overflow-y-auto outline-none"
          tabIndex={-1}
        >
          <header
            className={cn(
              "sticky top-0 z-30 flex min-h-16 items-center border-b bg-background px-[max(1rem,var(--safe-area-left))] pt-[var(--safe-area-top)] md:hidden",
              framelessWindow && "pr-[calc(var(--window-controls-width)+max(1rem,var(--safe-area-right)))]"
            )}
            data-window-drag-region={framelessWindow ? "" : undefined}
            style={framelessWindow ? dragRegionStyle : undefined}
          >
            {secondaryView ? (
              <>
                <Button
                  aria-label="返回上一页"
                  className="size-11 px-0"
                  onClick={secondaryView.onBack}
                  style={framelessWindow ? noDragRegionStyle : undefined}
                  variant="ghost"
                >
                  <ArrowLeft aria-hidden="true" data-icon="inline-start" />
                </Button>
                <div className="min-w-0 flex-1 px-2 text-base font-semibold">{secondaryView.title}</div>
                <div aria-hidden="true" className="size-11" />
              </>
            ) : (
              <>
                <Button
                  aria-label="打开主导航"
                  className="size-11 px-0"
                  onClick={() => setMobileNavigationOpen(true)}
                  style={framelessWindow ? noDragRegionStyle : undefined}
                  variant="ghost"
                >
                  <Menu aria-hidden="true" data-icon="inline-start" />
                </Button>
                <div className="min-w-0 flex-1 px-2 text-base font-semibold">{activeItem?.label}</div>
                {notificationsItem && (
                  <Button
                    aria-label={unreadCount > 0 ? `提醒中心，${unreadCount} 条未读` : "提醒中心"}
                    className="relative size-11 px-0"
                    onClick={() => navigate(notificationsItem.id)}
                    style={framelessWindow ? noDragRegionStyle : undefined}
                    variant="ghost"
                  >
                    <Bell aria-hidden="true" data-icon="inline-start" />
                    {unreadCount > 0 && (
                      <Badge className="absolute right-0.5 top-0.5 size-4 justify-center p-0 text-[9px]" tone="primary">
                        {visibleUnreadCount}
                      </Badge>
                    )}
                  </Button>
                )}
              </>
            )}
          </header>

          <div className="mx-auto min-h-full w-full max-w-[1600px] p-[var(--app-content-padding)]">{children}</div>
        </SidebarInset>

        {showDiscoveryScrollTop && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="回到顶部"
                className="fixed bottom-[max(1rem,var(--safe-area-bottom))] right-[max(1rem,var(--safe-area-right))] z-20 size-11 shadow-md md:size-11"
                onClick={scrollDiscoveryToTop}
                size="icon"
                type="button"
                variant="outline"
              >
                <ArrowUp aria-hidden="true" data-icon="inline-start" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">回到顶部</TooltipContent>
          </Tooltip>
        )}

        <Sheet onOpenChange={setMobileNavigationOpen} open={mobileNavigationOpen}>
          <SheetContent
            className="flex w-[320px] max-w-[calc(100vw-24px)] flex-col gap-0 p-0 sm:max-w-[320px]"
            showCloseButton={false}
            side="left"
          >
            <SheetHeader className="flex-row items-center justify-between border-b p-6 text-left">
              <div className="flex min-w-0 items-center gap-3">
                <img
                  alt=""
                  className="h-9 w-11 shrink-0 object-contain"
                  draggable={false}
                  src={APP_LOGO_SRC}
                />
                <div className="min-w-0">
                  <SheetTitle className="truncate text-base font-bold text-primary">Ani-tracker</SheetTitle>
                  <SheetDescription className="sr-only">在应用页面之间切换</SheetDescription>
                </div>
              </div>
              <Button
                aria-label="关闭主导航"
                className="size-11 px-0"
                onClick={() => setMobileNavigationOpen(false)}
                variant="ghost"
              >
                <X aria-hidden="true" data-icon="inline-start" />
              </Button>
            </SheetHeader>

            <nav aria-label="移动端主导航" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
              <div className="flex flex-col gap-1">
                {items.map((item) => {
                  const Icon = item.icon;
                  const selected = activePageId === item.id;
                  const isNotifications = item.id === "notifications";

                  return (
                    <Button
                      aria-current={selected ? "page" : undefined}
                      className="w-full justify-start px-4"
                      data-active={selected}
                      key={item.id}
                      onClick={() => navigate(item.id)}
                      variant="navigation"
                    >
                      <Icon aria-hidden="true" data-icon="inline-start" />
                      <span className="truncate">{item.label}</span>
                      {isNotifications && unreadCount > 0 && (
                        <Badge className="ml-auto h-5 min-w-5 justify-center px-1" tone="primary">
                          {visibleUnreadCount}
                        </Badge>
                      )}
                    </Button>
                  );
                })}
              </div>
            </nav>

            <footer className="border-t p-4 pb-[max(1rem,var(--safe-area-bottom))]">
              <div className="flex items-center gap-3 rounded-md bg-muted p-3">
                <div className="relative flex size-9 shrink-0 items-center justify-center rounded-md bg-background">
                  <Link2 aria-hidden="true" className="size-4" />
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute right-0 top-0 size-2 rounded-full",
                      status.state === "online" && "bg-success",
                      status.state === "idle" && "bg-warning",
                      status.state === "unknown" && "bg-muted-foreground"
                    )}
                  />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold">{status.label}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{status.detail}</div>
                </div>
              </div>
            </footer>
          </SheetContent>
        </Sheet>
      </SidebarProvider>
    </TooltipProvider>
  );
}
