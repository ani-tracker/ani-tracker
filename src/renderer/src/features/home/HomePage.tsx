import { AlertTriangle, CheckCircle2, Clock, DownloadCloud, FolderOpen, Play } from "lucide-react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { appApi } from "@/lib/api";
import { formatDuration, formatPercent, formatSpeed } from "@/lib/format";
import { useAsyncData } from "@/lib/use-async-data";

export function HomePage() {
  const { data, loading, error } = useAsyncData(appApi.getDashboard, []);

  if (loading) {
    return <div className="text-sm text-muted-foreground">正在加载首页...</div>;
  }

  if (error || !data) {
    return <div className="text-sm text-rose-600">首页数据加载失败。</div>;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">今日追番</h1>
        <p className="mt-1 text-sm text-muted-foreground">更新、下载和需要处理的任务会集中出现在这里。</p>
      </div>

      <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(320px,0.8fr)] gap-5">
        <Panel title="今日提醒" description={formatReminderDate(data.dailyReminder.date)}>
          <div className="space-y-3">
            <div className="grid grid-cols-5 gap-2">
              <ReminderStat label="今日" value={data.dailyReminder.total} />
              <ReminderStat label="未播" value={data.dailyReminder.upcoming} />
              <ReminderStat label="待处理" value={data.dailyReminder.aired} />
              <ReminderStat label="下载中" value={data.dailyReminder.downloading} />
              <ReminderStat label="已完成" value={data.dailyReminder.downloaded} />
            </div>

            {data.dailyReminder.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <div className="font-medium">{item.animeTitle}</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    第 {item.episodeNo} 集 · {formatAirTime(item.airTime)} · {item.fansubName ?? "未选字幕组"}
                  </div>
                </div>
                <Badge tone={getEpisodeStatusTone(item.status)}>{formatEpisodeStatus(item.status)}</Badge>
              </div>
            ))}
            {!data.dailyReminder.items.length && (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                今天没有已登记的追番更新。
              </div>
            )}
          </div>
        </Panel>

        <Panel title="需要处理">
          <div className="space-y-3">
            {data.pendingActions.map((item) => (
              <div key={item.id} className="flex gap-3 rounded-md border p-3">
                <AlertTriangle
                  className={
                    item.severity === "warning"
                      ? "mt-0.5 h-4 w-4 text-amber-600"
                      : "mt-0.5 h-4 w-4 text-cyan-600"
                  }
                />
                <div>
                  <div className="text-sm font-medium">{item.title}</div>
                  <div className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-3 gap-5">
        <Panel title="下载中">
          <div className="space-y-4">
            {data.activeDownloads.map((task) => (
              <div key={task.id} className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{task.name}</div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{formatSpeed(task.downloadSpeed)}</span>
                      <span>剩余 {formatDuration(task.etaSeconds)}</span>
                    </div>
                  </div>
                  <Badge tone="blue">{formatPercent(task.progress)}</Badge>
                </div>
                <Progress value={task.progress} />
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="最近完成">
          <div className="space-y-3">
            {data.recentCompleted.map((file) => (
              <div key={file.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                      <span className="truncate">{file.fileName}</span>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Badge tone="green">{file.normalizedVideoCodec}</Badge>
                      {file.resolution && <Badge>{file.resolution}</Badge>}
                      {file.bitDepth && <Badge>{file.bitDepth}bit</Badge>}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      aria-label="播放"
                      title="播放"
                      onClick={() => void appApi.playMedia(file.filePath)}
                    >
                      <Play className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      aria-label="定位文件"
                      title="定位文件"
                      onClick={() => void appApi.revealMedia(file.filePath)}
                    >
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="本周放送">
          <div className="space-y-2">
            {data.weeklySchedule.map((day) => (
              <div key={day.day} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="text-sm font-medium">{day.day}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  {day.items.length ? `${day.items.length} 部` : "无更新"}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="下载源状态">
        <div className="grid grid-cols-3 gap-3">
          {data.sourceHealth.map((source) => (
            <div key={source.sourceId} className="flex items-center justify-between rounded-md border p-3">
              <div>
                <div className="text-sm font-medium">{source.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">最近检查 {source.lastCheckedAt ?? "--"}</div>
              </div>
              <Badge tone={source.status === "ok" ? "green" : "amber"}>
                <DownloadCloud className="mr-1 h-3 w-3" />
                {source.status === "ok" ? "正常" : "待检查"}
              </Badge>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function ReminderStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function formatReminderDate(value: string): string {
  return `${value} 的更新摘要`;
}

function formatAirTime(value?: string): string {
  if (!value) {
    return "未知时间";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知时间";
  }

  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function formatEpisodeStatus(status: string): string {
  const labels: Record<string, string> = {
    upcoming: "未播",
    aired: "已播",
    matched: "已匹配",
    downloading: "下载中",
    downloaded: "已下载",
    watched: "已看"
  };

  return labels[status] ?? status;
}

function getEpisodeStatusTone(status: string): "neutral" | "green" | "amber" | "red" | "blue" {
  if (status === "downloading") {
    return "blue";
  }

  if (status === "downloaded" || status === "watched" || status === "matched") {
    return "green";
  }

  if (status === "aired") {
    return "amber";
  }

  return "neutral";
}
