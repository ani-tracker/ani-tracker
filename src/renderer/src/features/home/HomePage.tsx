import { Fragment } from "react";
import { AlertTriangle, CheckCircle2, Clock, DownloadCloud, FolderOpen, Play } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { appApi, isElectronClient } from "@/lib/api";
import { formatDuration, formatPercent, formatSpeed } from "@/lib/format";
import { useAsyncData } from "@/lib/use-async-data";
import type { AnimeStatus, MyAnime } from "@shared/domain";

const animeStatusText: Record<AnimeStatus, string> = {
  watching: "在追",
  planned: "想看",
  completed: "已完成",
  paused: "暂停",
  dropped: "已弃"
};

const animeStatusOptions = Object.entries(animeStatusText) as Array<[AnimeStatus, string]>;

/** 加载首页看板和追番状态统计所需数据。 */
async function loadHomeData() {
  const [dashboard, myAnime] = await Promise.all([appApi.getDashboard(), appApi.listMyAnime()]);
  return { dashboard, myAnime };
}

/** 渲染首页追番、下载与提醒概览。 */
export function HomePage() {
  const { data: homeData, loading, error } = useAsyncData(loadHomeData, []);
  const electronClient = isElectronClient();

  if (loading) {
    return <HomePageSkeleton />;
  }

  if (error || !homeData) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>首页数据加载失败</AlertTitle>
        <AlertDescription>{error?.message ?? "暂时无法读取首页数据，请稍后重试。"}</AlertDescription>
      </Alert>
    );
  }

  const data = homeData.dashboard;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-normal">今日追番</h1>
        <p className="mt-1 text-sm text-muted-foreground">更新、下载和需要处理的任务会集中出现在这里。</p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 lg:gap-4">
        {animeStatusOptions.map(([status, label]) => (
          <AnimeStatusStat key={status} label={label} value={countMyAnimeStatus(homeData.myAnime, status)} />
        ))}
      </div>

      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.8fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>今日提醒</CardTitle>
            <CardDescription>{formatReminderDate(data.dailyReminder.date)}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <ReminderStat label="今日" value={data.dailyReminder.total} />
              <ReminderStat label="未播" value={data.dailyReminder.upcoming} />
              <ReminderStat label="待处理" value={data.dailyReminder.aired} />
              <ReminderStat label="下载中" value={data.dailyReminder.downloading} />
              <ReminderStat label="已完成" value={data.dailyReminder.downloaded} />
            </div>

            {data.dailyReminder.items.length > 0 ? (
              <div className="flex min-w-0 flex-col">
                {data.dailyReminder.items.map((item, index) => (
                  <Fragment key={item.id}>
                    <div className="flex min-w-0 flex-col items-start gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="font-medium">{item.animeTitle}</div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          第 {item.episodeNo} 集 · {formatAirTime(item.airTime)} · {item.fansubName ?? "未选字幕组"}
                        </div>
                      </div>
                      <Badge className="shrink-0" tone={getEpisodeStatusTone(item.status)}>
                        {formatEpisodeStatus(item.status)}
                      </Badge>
                    </div>
                    {index < data.dailyReminder.items.length - 1 && <Separator />}
                  </Fragment>
                ))}
              </div>
            ) : (
              <Empty className="min-h-40 p-4 md:p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Clock />
                  </EmptyMedia>
                  <EmptyTitle>今日暂无更新</EmptyTitle>
                  <EmptyDescription>今天没有已登记的追番更新。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>需要处理</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {data.pendingActions.length > 0 ? (
              data.pendingActions.map((item) => (
                <Alert key={item.id}>
                  <AlertTriangle />
                  <AlertTitle>{item.title}</AlertTitle>
                  <AlertDescription>
                    <div className="flex flex-col gap-2">
                      <p>{item.description}</p>
                      <Badge className="w-fit" tone={item.severity === "warning" ? "amber" : "blue"}>
                        {item.severity === "warning" ? "需要关注" : "信息"}
                      </Badge>
                    </div>
                  </AlertDescription>
                </Alert>
              ))
            ) : (
              <Empty className="min-h-40 p-4 md:p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CheckCircle2 />
                  </EmptyMedia>
                  <EmptyTitle>暂无待处理事项</EmptyTitle>
                  <EmptyDescription>当前没有需要手动处理的任务。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid min-w-0 items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>下载中</CardTitle>
          </CardHeader>
          <CardContent>
            {data.activeDownloads.length > 0 ? (
              <div className="flex min-w-0 flex-col">
                {data.activeDownloads.map((task, index) => (
                  <Fragment key={task.id}>
                    <div className="flex min-w-0 flex-col gap-2 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium" title={task.name}>
                            {task.name}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span>{formatSpeed(task.downloadSpeed)}</span>
                            <span>剩余 {formatDuration(task.etaSeconds)}</span>
                          </div>
                        </div>
                        <Badge className="shrink-0" tone="blue">
                          {formatPercent(task.progress)}
                        </Badge>
                      </div>
                      <Progress value={task.progress} />
                    </div>
                    {index < data.activeDownloads.length - 1 && <Separator />}
                  </Fragment>
                ))}
              </div>
            ) : (
              <Empty className="min-h-40 p-4 md:p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <DownloadCloud />
                  </EmptyMedia>
                  <EmptyTitle>暂无下载任务</EmptyTitle>
                  <EmptyDescription>当前没有正在下载的资源。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>最近完成</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentCompleted.length > 0 ? (
              <div className="flex min-w-0 flex-col">
                {data.recentCompleted.map((file, index) => (
                  <Fragment key={file.id}>
                    <div className="flex min-w-0 flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                          <CheckCircle2 className="size-4 shrink-0 text-primary" />
                          <span className="truncate" title={file.fileName}>
                            {file.fileName}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Badge tone="green">{file.normalizedVideoCodec}</Badge>
                          {file.resolution && <Badge>{file.resolution}</Badge>}
                          {file.bitDepth && <Badge>{file.bitDepth}bit</Badge>}
                        </div>
                      </div>
                      {electronClient && <div className="flex shrink-0 self-end gap-2 sm:self-auto">
                        <Button
                          className="size-11 p-0 sm:size-9"
                          variant="outline"
                          aria-label="播放"
                          title="播放"
                          onClick={() => void appApi.playMedia(file.filePath)}
                        >
                          <Play data-icon="inline-start" />
                        </Button>
                        <Button
                          className="size-11 p-0 sm:size-9"
                          variant="outline"
                          aria-label="定位文件"
                          title="定位文件"
                          onClick={() => void appApi.revealMedia(file.filePath)}
                        >
                          <FolderOpen data-icon="inline-start" />
                        </Button>
                      </div>}
                    </div>
                    {index < data.recentCompleted.length - 1 && <Separator />}
                  </Fragment>
                ))}
              </div>
            ) : (
              <Empty className="min-h-40 p-4 md:p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CheckCircle2 />
                  </EmptyMedia>
                  <EmptyTitle>暂无完成记录</EmptyTitle>
                  <EmptyDescription>最近还没有完成下载的媒体文件。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 md:col-span-2 xl:col-span-1">
          <CardHeader>
            <CardTitle>本周放送</CardTitle>
          </CardHeader>
          <CardContent>
            {data.weeklySchedule.length > 0 ? (
              <div className="flex flex-col">
                {data.weeklySchedule.map((day, index) => (
                  <Fragment key={day.day}>
                    <div className="flex items-center justify-between gap-3 py-3">
                      <div className="text-sm font-medium">{day.day}</div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="size-4" />
                        {day.items.length ? `${day.items.length} 部` : "无更新"}
                      </div>
                    </div>
                    {index < data.weeklySchedule.length - 1 && <Separator />}
                  </Fragment>
                ))}
              </div>
            ) : (
              <Empty className="min-h-40 p-4 md:p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Clock />
                  </EmptyMedia>
                  <EmptyTitle>暂无放送安排</EmptyTitle>
                  <EmptyDescription>本周还没有已登记的放送信息。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>下载源状态</CardTitle>
        </CardHeader>
        <CardContent>
          {data.sourceHealth.length > 0 ? (
            <div className="grid min-w-0 gap-x-5 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
              {data.sourceHealth.map((source) => (
                <div key={source.sourceId} className="flex min-w-0 items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" title={source.name}>
                      {source.name}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      最近检查 {source.lastCheckedAt ?? "--"}
                    </div>
                  </div>
                  <Badge className="shrink-0" tone={source.status === "ok" ? "green" : "amber"}>
                    {source.status === "ok" ? "正常" : "待检查"}
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <Empty className="min-h-40 p-4 md:p-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <DownloadCloud />
                </EmptyMedia>
                <EmptyTitle>暂无下载源</EmptyTitle>
                <EmptyDescription>当前没有可显示状态的下载源。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** 渲染首页加载中的结构化占位状态。 */
function HomePageSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-5" aria-busy="true" aria-label="正在加载首页">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 lg:gap-4">
        {animeStatusOptions.map(([status]) => (
          <Card key={status}>
            <CardHeader>
              <Skeleton className="h-4 w-16" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-10" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        {["daily", "pending"].map((section) => (
          <Card key={section}>
            <CardHeader>
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-40" />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** 渲染单个追番状态统计卡片。 */
function AnimeStatusStat({ label, value }: { label: string; value: number }) {
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

/** 渲染今日提醒中的单项数量统计。 */
function ReminderStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** 统计指定追番状态的数量。 */
function countMyAnimeStatus(items: MyAnime[], status: AnimeStatus): number {
  return items.filter((item) => item.status === status).length;
}

/** 格式化首页提醒日期描述。 */
function formatReminderDate(value: string): string {
  return `${value} 的更新摘要`;
}

/** 将放送时间格式化为本地时分。 */
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

/** 将单集状态转换为中文标签。 */
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

/** 根据单集状态返回对应徽标色调。 */
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
