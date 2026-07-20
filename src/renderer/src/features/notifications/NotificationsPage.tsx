import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bell, CheckCheck, RefreshCw, Trash2 } from "lucide-react";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  FilterToolbar,
  Page,
  PageActions,
  PageHeader,
  PageHeading
} from "@/components/page-layout";
import { appApi, isElectronClient } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { NotificationRecord } from "@shared/domain";

const severityTone = {
  info: "blue",
  success: "green",
  warning: "amber",
  error: "red"
} as const;

const kindText = {
  automation: "自动化",
  download: "下载",
  reminder: "提醒",
  system: "系统"
};

type NotificationFilter = "all" | "unread" | NotificationRecord["kind"];

const notificationFilters: Array<{ label: string; value: NotificationFilter }> = [
  { label: "全部", value: "all" },
  { label: "未读", value: "unread" },
  { label: "下载", value: "download" },
  { label: "自动化", value: "automation" },
  { label: "系统", value: "system" }
];

const severityBorderClass: Record<NotificationRecord["severity"], string> = {
  info: "border-info",
  success: "border-success",
  warning: "border-warning",
  error: "border-destructive"
};

/** 渲染提醒中心并管理提醒记录操作。 */
export function NotificationsPage() {
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const electronClient = isElectronClient();

  const unreadCount = useMemo(() => items.filter((item) => !item.readAt).length, [items]);
  const successCount = useMemo(() => items.filter((item) => item.severity === "success").length, [items]);
  const warningCount = useMemo(() => items.filter((item) => item.severity === "warning").length, [items]);
  const errorCount = useMemo(() => items.filter((item) => item.severity === "error").length, [items]);
  const visibleItems = useMemo(() => filterNotifications(items, filter), [filter, items]);
  const groups = useMemo(() => groupNotificationsByDate(visibleItems), [visibleItems]);

  useEffect(() => {
    void loadNotifications(true);
  }, []);

  /** 加载全部提醒记录。 */
  async function loadNotifications(initial = false) {
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      setItems(await appApi.listNotifications());
      setUpdatedAt(new Date().toLocaleTimeString());
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载提醒失败");
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }

  /** 将指定提醒标记为已读。 */
  async function markRead(notificationId: string) {
    setItems(await appApi.markNotificationRead(notificationId));
  }

  /** 将全部提醒标记为已读。 */
  async function markAllRead() {
    setItems(await appApi.markAllNotificationsRead());
  }

  /** 清空全部提醒记录，并将失败反馈保留在页面。 */
  async function clearAll() {
    try {
      setItems(await appApi.clearNotifications());
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清空提醒失败");
      throw error;
    }
  }

  if (loading) {
    return <NotificationsPageSkeleton />;
  }

  return (
    <Page>
      <section className="flex min-w-0 flex-col gap-4 border-b pb-4">
        <PageHeader className="sm:items-center">
          <PageHeading
            breadcrumb="提醒中心"
            description="历史记录与自动化、下载和系统事件"
            title="提醒中心"
          />
          <PageActions>
            <div className="min-w-24 text-left sm:text-right">
              <div className="text-xs text-muted-foreground">最后刷新</div>
              <div className="text-sm font-semibold tabular-nums">{updatedAt ?? "尚未刷新"}</div>
            </div>
            <Button
              variant="outline"
              onClick={() => void loadNotifications()}
              disabled={refreshing}
            >
              <RefreshCw data-icon="inline-start" className={cn(refreshing && "animate-spin")} />
              {refreshing ? "刷新中" : "刷新状态"}
            </Button>
            <Button onClick={() => void markAllRead()} disabled={!unreadCount}>
              <CheckCheck data-icon="inline-start" />
              全部已读
            </Button>
            {electronClient && (
              <Button variant="outline" onClick={() => setClearDialogOpen(true)} disabled={!items.length}>
                <Trash2 data-icon="inline-start" />
                清空
              </Button>
            )}
          </PageActions>
        </PageHeader>

        <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="提醒统计">
          <NotificationMetric label="未读" tone="primary" value={unreadCount} />
          <NotificationMetric label="成功" tone="green" value={successCount} />
          <NotificationMetric label="警告" tone="amber" value={warningCount} />
          <NotificationMetric label="错误" tone="red" value={errorCount} />
        </div>
      </section>

      {message && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>提醒加载失败</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <FilterToolbar className="border-y-0 bg-transparent py-0">
        <Tabs className="min-w-0 flex-1" value={filter} onValueChange={(value) => setFilter(value as NotificationFilter)}>
          <TabsList className="grid w-full grid-cols-5 sm:flex sm:w-fit" variant="line" aria-label="筛选提醒">
            {notificationFilters.map((item) => (
              <TabsTrigger className="min-w-0 px-2" key={item.value} value={item.value}>{item.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">显示 {visibleItems.length} / {items.length}</span>
      </FilterToolbar>

      {groups.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-6">
          {groups.map((group) => (
            <section key={group.label}>
              <h2 className="mb-2 text-xs font-semibold text-muted-foreground">{group.label}</h2>
              <div className="flex min-w-0 flex-col gap-2">
                {group.items.map((item) => (
                  <article
                    className={cn(
                      "flex min-w-0 flex-col gap-3 border-l-4 bg-card p-3 sm:flex-row sm:items-start sm:justify-between sm:p-4",
                      severityBorderClass[item.severity],
                      item.readAt && "opacity-70"
                    )}
                    key={item.id}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Bell className="size-4 shrink-0 text-primary" />
                        <h3 className="min-w-0 break-words text-sm font-semibold">{item.title}</h3>
                        {!item.readAt && <Badge tone="primary">未读</Badge>}
                      </div>
                      <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">{item.body}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Badge tone={severityTone[item.severity]}>{severityText(item.severity)}</Badge>
                        <Badge>{kindText[item.kind]}</Badge>
                        <span className="text-xs text-muted-foreground">{formatNotificationTime(item.createdAt)}</span>
                      </div>
                    </div>
                    <Button
                      className="w-full shrink-0 sm:w-auto"
                      disabled={Boolean(item.readAt)}
                      onClick={() => void markRead(item.id)}
                      variant="outline"
                    >
                      <CheckCheck data-icon="inline-start" />
                      标记已读
                    </Button>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
            <Empty className="min-h-64 p-4 md:p-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Bell />
                </EmptyMedia>
                <EmptyTitle>{items.length ? "没有匹配的提醒" : "暂无提醒"}</EmptyTitle>
                <EmptyDescription>{items.length ? "请选择其他筛选条件。" : "当前没有提醒记录。"}</EmptyDescription>
              </EmptyHeader>
            </Empty>
      )}

      <ConfirmActionDialog
        confirmLabel="清空提醒"
        description="全部提醒记录将被永久清空，此操作无法撤销。"
        onConfirm={clearAll}
        onOpenChange={setClearDialogOpen}
        open={clearDialogOpen}
        title="确认清空提醒？"
      />
    </Page>
  );
}

/** 渲染提醒中心加载中的结构化占位状态。 */
function NotificationsPageSkeleton() {
  return (
    <Page aria-busy="true" aria-label="正在加载提醒中心">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="flex flex-wrap gap-2">
        {["all", "unread", "success", "error"].map((stat) => (
          <Skeleton className="h-9 w-24" key={stat} />
        ))}
      </div>
      <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
      </div>
    </Page>
  );
}

/** 以紧凑计数项展示提醒状态，避免统计区形成额外卡片层级。 */
function NotificationMetric({
  label,
  tone,
  value
}: {
  label: string;
  tone: "primary" | "green" | "amber" | "red";
  value: number;
}) {
  return (
    <div className="flex h-9 min-w-24 items-center justify-center gap-2 border bg-card px-3 text-sm">
      <span className={cn(
        "size-1.5 rounded-full",
        tone === "primary" && "bg-primary",
        tone === "green" && "bg-success",
        tone === "amber" && "bg-warning",
        tone === "red" && "bg-destructive"
      )} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** 按当前类型与未读状态筛选提醒。 */
function filterNotifications(items: NotificationRecord[], filter: NotificationFilter): NotificationRecord[] {
  if (filter === "all") return items;
  if (filter === "unread") return items.filter((item) => !item.readAt);
  return items.filter((item) => item.kind === filter);
}

/** 将提醒按今天、昨天和更早分组。 */
function groupNotificationsByDate(items: NotificationRecord[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, NotificationRecord[]>([["今天", []], ["昨天", []], ["更早", []]]);

  [...items]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .forEach((item) => {
      const createdAt = new Date(item.createdAt);
      const label = createdAt >= today ? "今天" : createdAt >= yesterday ? "昨天" : "更早";
      groups.get(label)?.push(item);
    });

  return Array.from(groups, ([label, groupedItems]) => ({ label, items: groupedItems }))
    .filter((group) => group.items.length > 0);
}

/** 格式化提醒时间，今天只显示时分。 */
function formatNotificationTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 将提醒级别转换为中文标签。 */
function severityText(severity: NotificationRecord["severity"]): string {
  const labels = {
    info: "信息",
    success: "成功",
    warning: "警告",
    error: "错误"
  };

  return labels[severity];
}
