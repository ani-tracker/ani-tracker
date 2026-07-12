import { Bell, CheckCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appApi } from "@/lib/api";
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

export function NotificationsPage() {
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const unreadCount = useMemo(() => items.filter((item) => !item.readAt).length, [items]);

  useEffect(() => {
    void loadNotifications();
  }, []);

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

  async function markRead(notificationId: string) {
    setItems(await appApi.markNotificationRead(notificationId));
  }

  async function markAllRead() {
    setItems(await appApi.markAllNotificationsRead());
  }

  async function clearAll() {
    const confirmed = window.confirm("确认清空所有提醒记录？");
    if (!confirmed) {
      return;
    }

    setItems(await appApi.clearNotifications());
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">正在加载提醒中心...</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">提醒中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">自动扫描、下载和系统提醒会保留在这里。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void markAllRead()} disabled={!unreadCount}>
            <CheckCheck className="h-4 w-4" />
            全部已读
          </Button>
          <Button variant="outline" onClick={() => void clearAll()} disabled={!items.length}>
            <Trash2 className="h-4 w-4" />
            清空
          </Button>
        </div>
      </div>

      {message && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{message}</div>}

      <div className="grid grid-cols-4 gap-4">
        <Panel className="p-4">
          <div className="text-2xl font-semibold">{items.length}</div>
          <div className="mt-1 text-sm text-muted-foreground">全部提醒</div>
        </Panel>
        <Panel className="p-4">
          <div className="text-2xl font-semibold">{unreadCount}</div>
          <div className="mt-1 text-sm text-muted-foreground">未读提醒</div>
        </Panel>
        <Panel className="p-4">
          <div className="text-2xl font-semibold">{items.filter((item) => item.severity === "success").length}</div>
          <div className="mt-1 text-sm text-muted-foreground">成功事件</div>
        </Panel>
        <Panel className="p-4">
          <div className="text-2xl font-semibold">{items.filter((item) => item.severity === "error").length}</div>
          <div className="mt-1 text-sm text-muted-foreground">错误事件</div>
        </Panel>
      </div>

      <Panel>
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className={item.readAt ? "rounded-md border p-4 opacity-75" : "rounded-md border bg-accent/30 p-4"}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Bell className="h-4 w-4 text-primary" />
                    <div className="font-medium">{item.title}</div>
                    {!item.readAt && <Badge tone="amber">未读</Badge>}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge tone={severityTone[item.severity]}>{severityText(item.severity)}</Badge>
                    <Badge>{kindText[item.kind]}</Badge>
                    <Badge>{new Date(item.createdAt).toLocaleString()}</Badge>
                  </div>
                </div>
                <Button variant="outline" onClick={() => void markRead(item.id)} disabled={Boolean(item.readAt)}>
                  <CheckCheck className="h-4 w-4" />
                  已读
                </Button>
              </div>
            </div>
          ))}

          {items.length === 0 && (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              当前没有提醒记录。
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function severityText(severity: NotificationRecord["severity"]): string {
  const labels = {
    info: "信息",
    success: "成功",
    warning: "警告",
    error: "错误"
  };

  return labels[severity];
}
