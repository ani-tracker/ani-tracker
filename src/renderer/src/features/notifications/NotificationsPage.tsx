import { Fragment, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bell, CheckCheck, Trash2 } from "lucide-react";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
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

/** 渲染提醒中心并管理提醒记录操作。 */
export function NotificationsPage() {
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const electronClient = isElectronClient();

  const unreadCount = useMemo(() => items.filter((item) => !item.readAt).length, [items]);
  const successCount = useMemo(() => items.filter((item) => item.severity === "success").length, [items]);
  const errorCount = useMemo(() => items.filter((item) => item.severity === "error").length, [items]);

  useEffect(() => {
    void loadNotifications();
  }, []);

  /** 加载全部提醒记录。 */
  async function loadNotifications() {
    setLoading(true);
    try {
      setItems(await appApi.listNotifications());
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载提醒失败");
    } finally {
      setLoading(false);
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
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">提醒中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">自动扫描、下载和系统提醒会保留在这里。</p>
        </div>
        <div className={cn("grid w-full gap-2 sm:w-auto", electronClient ? "grid-cols-2" : "grid-cols-1")}>
          <Button
            className="min-h-11 min-w-0 px-2 sm:min-h-9 sm:px-3"
            variant="outline"
            onClick={() => void markAllRead()}
            disabled={!unreadCount}
          >
            <CheckCheck data-icon="inline-start" />
            全部已读
          </Button>
          {electronClient && (
            <Button
              className="min-h-11 min-w-0 px-2 sm:min-h-9 sm:px-3"
              variant="outline"
              onClick={() => setClearDialogOpen(true)}
              disabled={!items.length}
            >
              <Trash2 data-icon="inline-start" />
              清空
            </Button>
          )}
        </div>
      </header>

      {message && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>提醒加载失败</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <NotificationStat label="全部提醒" value={items.length} />
        <NotificationStat label="未读提醒" value={unreadCount} />
        <NotificationStat label="成功事件" value={successCount} />
        <NotificationStat label="错误事件" value={errorCount} />
      </div>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>提醒记录</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length > 0 ? (
            <div className="flex min-w-0 flex-col">
              {items.map((item, index) => (
                <Fragment key={item.id}>
                  <article
                    className={cn(
                      "flex min-w-0 flex-col gap-4 rounded-md p-3 sm:flex-row sm:items-start sm:justify-between sm:p-4",
                      item.readAt ? "opacity-75" : "bg-accent/30"
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Bell className="size-4 shrink-0 text-primary" />
                        <div className="min-w-0 break-words font-medium">{item.title}</div>
                        {!item.readAt && <Badge tone="amber">未读</Badge>}
                      </div>
                      <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">{item.body}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Badge tone={severityTone[item.severity]}>{severityText(item.severity)}</Badge>
                        <Badge>{kindText[item.kind]}</Badge>
                        <Badge>{new Date(item.createdAt).toLocaleString()}</Badge>
                      </div>
                    </div>
                    <Button
                      className="min-h-11 w-full shrink-0 sm:min-h-9 sm:w-auto"
                      variant="outline"
                      onClick={() => void markRead(item.id)}
                      disabled={Boolean(item.readAt)}
                    >
                      <CheckCheck data-icon="inline-start" />
                      已读
                    </Button>
                  </article>
                  {index < items.length - 1 && <Separator />}
                </Fragment>
              ))}
            </div>
          ) : (
            <Empty className="min-h-64 p-4 md:p-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Bell />
                </EmptyMedia>
                <EmptyTitle>暂无提醒</EmptyTitle>
                <EmptyDescription>当前没有提醒记录。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      <ConfirmActionDialog
        confirmLabel="清空提醒"
        description="全部提醒记录将被永久清空，此操作无法撤销。"
        onConfirm={clearAll}
        onOpenChange={setClearDialogOpen}
        open={clearDialogOpen}
        title="确认清空提醒？"
      />
    </div>
  );
}

/** 渲染提醒中心加载中的结构化占位状态。 */
function NotificationsPageSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-5" aria-busy="true" aria-label="正在加载提醒中心">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {["all", "unread", "success", "error"].map((stat) => (
          <Card key={stat}>
            <CardHeader>
              <Skeleton className="h-4 w-20" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-10" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

/** 渲染单项提醒统计卡片。 */
function NotificationStat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
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
