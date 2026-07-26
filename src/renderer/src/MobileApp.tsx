import { Bell, Database, Download, Home, Library, Search, Settings, Sparkles, Subtitles } from "lucide-react";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Page, PageHeader, PageHeading, StatusRow } from "@/components/page-layout";

type MobilePageId = "home" | "myAnime" | "discovery" | "releaseSearch" | "downloads" | "notifications" | "sources" | "settings";

const mobileNavigation = [
  { id: "home", label: "首页", icon: Home },
  { id: "myAnime", label: "我的追番", icon: Library },
  { id: "discovery", label: "新番发现", icon: Sparkles },
  { id: "releaseSearch", label: "资源搜索", icon: Search },
  { id: "downloads", label: "下载队列", icon: Download },
  { id: "notifications", label: "提醒中心", icon: Bell },
  { id: "sources", label: "下载源", icon: Subtitles },
  { id: "settings", label: "设置", icon: Settings }
] as const;

export interface MobileBootstrapState {
  phase: "loading" | "ready" | "error";
  message: string;
}

/** 渲染 Android 独立应用壳；业务页面将在后续阶段逐项接入同一导航。 */
export function MobileApp({ bootstrap }: { bootstrap: MobileBootstrapState }) {
  const [activePage, setActivePage] = useState<MobilePageId>("home");
  const page = mobileNavigation.find((item) => item.id === activePage) ?? mobileNavigation[0];
  const ready = bootstrap.phase === "ready";
  const loading = bootstrap.phase === "loading";

  return (
    <AppShell
      activePageId={activePage}
      items={mobileNavigation}
      onNavigate={(pageId) => setActivePage(pageId as MobilePageId)}
      status={{
        state: ready ? "online" : loading ? "idle" : "error",
        label: ready ? "本地服务正常" : loading ? "正在初始化" : "本地服务异常",
        detail: bootstrap.message
      }}
      unreadCount={0}
    >
      <Page>
        <PageHeader>
          <PageHeading title={page.label} />
        </PageHeader>
        <StatusRow
          icon={<Database aria-hidden="true" className="size-5" />}
          title={ready ? "本地数据已就绪" : loading ? "正在初始化本地数据" : "本地数据初始化失败"}
          detail={bootstrap.message}
        />
      </Page>
    </AppShell>
  );
}
