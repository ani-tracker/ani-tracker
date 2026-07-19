import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  ImageOff,
  Info,
  ListTodo,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
  Users
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { CachedImage } from "@/components/cached-image";
import { Page } from "@/components/page-layout";
import { appApi, isElectronClient } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { AnimeDetailResult } from "@shared/contracts";
import type { Anime, MyAnime } from "@shared/domain";
import {
  formatSubtitleLanguages,
  formatVideoBitDepth,
  resolveSubtitleLanguages
} from "@shared/release-metadata";
import { buildAnimeDetailViewModel } from "./anime-detail-view-model";

export type AnimeDetailLibraryAction = "rules" | "resources" | "tasks";

interface AnimeDetailPageProps {
  animeId: string;
  sourceLabel: string;
  onBack: () => void;
  onOpenLibraryAction: (animeId: string, action: AnimeDetailLibraryAction) => void;
  onOpenReleaseSearch: (anime: Anime) => void;
}

/** 渲染未追番与已追番共用的番剧详情长页。 */
export function AnimeDetailPage({
  animeId,
  sourceLabel,
  onBack,
  onOpenLibraryAction,
  onOpenReleaseSearch
}: AnimeDetailPageProps) {
  const [result, setResult] = useState<AnimeDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [summaryOverflow, setSummaryOverflow] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const desktopClient = isElectronClient();

  useEffect(() => {
    void loadDetail();
  }, [animeId]);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useLayoutEffect(() => {
    const element = summaryRef.current;
    if (!element || summaryExpanded) {
      setSummaryOverflow(false);
      return;
    }
    const updateOverflow = () => setSummaryOverflow(element.scrollHeight > element.clientHeight + 1);
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [result?.anime.summary, summaryExpanded]);

  const viewModel = useMemo(() => result ? buildAnimeDetailViewModel(result) : null, [result]);
  const defaultFansubName = result?.myAnime?.defaultFansubGroupId
    ? result.fansubGroups.find((group) => group.id === result.myAnime?.defaultFansubGroupId)?.name
    : undefined;

  /** 从本地聚合接口加载详情首屏。 */
  async function loadDetail() {
    setLoading(true);
    setError(null);
    console.info("[anime-detail] load requested", { animeId });
    try {
      setResult(await appApi.getAnimeDetail(animeId));
      setSummaryExpanded(false);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "加载番剧详情失败";
      console.error("[anime-detail] load failed", { animeId, error: loadError });
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  /** 主动补全外部详情，并保留当前页面内容。 */
  async function refreshDetail() {
    if (!online || !desktopClient) return;
    setRefreshing(true);
    try {
      const refreshed = await appApi.refreshAnimeDetail(animeId);
      setResult(refreshed);
      toast.success(refreshed.partialErrors.length ? "详情已部分更新" : "番剧详情已更新");
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : "刷新番剧详情失败";
      toast.error(message);
      console.error("[anime-detail] refresh failed", { animeId, error: refreshError });
    } finally {
      setRefreshing(false);
    }
  }

  /** 使用当前默认规则将目录番剧加入追番。 */
  async function addTracker() {
    if (!result || result.myAnime) return;
    setTracking(true);
    try {
      const now = new Date().toISOString();
      await appApi.upsertMyAnime(createDefaultMyAnime(result.anime, now));
      setResult(await appApi.getAnimeDetail(animeId));
      toast.success(`已添加「${viewModel?.title ?? result.anime.title}」到我的追番`);
      console.info("[anime-detail] tracker added", { animeId });
    } catch (trackingError) {
      toast.error(trackingError instanceof Error ? trackingError.message : "添加追番失败");
    } finally {
      setTracking(false);
    }
  }

  /** 移除当前追番记录并原地切回未追番详情。 */
  async function removeTracker() {
    if (!result?.myAnime) return;
    setRemoving(true);
    try {
      await appApi.removeMyAnime(result.myAnime.id);
      setResult(await appApi.getAnimeDetail(animeId));
      setRemoveDialogOpen(false);
      toast.success("已移除追番，下载文件保持不变");
      console.info("[anime-detail] tracker removed", { animeId });
    } catch (removeError) {
      toast.error(removeError instanceof Error ? removeError.message : "移除追番失败");
    } finally {
      setRemoving(false);
    }
  }

  /** 在桌面端调用系统浏览器，远程端使用标准新窗口。 */
  async function openExternal(url: string) {
    if (desktopClient) {
      await appApi.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  if (loading) {
    return <AnimeDetailSkeleton />;
  }

  if (!result || !viewModel) {
    if (error?.includes("不存在")) {
      return (
        <Empty className="min-h-[60vh]">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Info /></EmptyMedia>
            <EmptyTitle>番剧不存在</EmptyTitle>
            <EmptyDescription>本地目录中没有找到这部番剧，可能已被清理。</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button onClick={onBack}>返回{sourceLabel}</Button></EmptyContent>
        </Empty>
      );
    }
    return (
      <Page>
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>番剧详情加载失败</AlertTitle>
          <AlertDescription>{error ?? "请稍后重试"}</AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void loadDetail()}><RefreshCw data-icon="inline-start" />重试</Button>
          <Button onClick={onBack} variant="outline"><ArrowLeft data-icon="inline-start" />返回{sourceLabel}</Button>
        </div>
      </Page>
    );
  }

  const detail = result.anime.detail;
  const hasProduction = Boolean(detail?.studios?.length || detail?.staff?.length);
  const hasBasicInfo = Boolean(
    viewModel.format || viewModel.airingStatus || viewModel.endDate || detail?.episodeCount
      || detail?.durationMinutes || detail?.sourceMaterial || detail?.contentRating || detail?.demographic
  );
  const sectionLinks = [
    result.anime.summary ? { id: "detail-overview", label: "简介" } : null,
    hasBasicInfo ? { id: "detail-info", label: "信息" } : null,
    detail?.genres?.length ? { id: "detail-genres", label: "题材" } : null,
    hasProduction ? { id: "detail-production", label: "制作" } : null,
    result.myAnime ? { id: "detail-tracker", label: "追番" } : null,
    viewModel.externalLinks.length ? { id: "detail-sources", label: "来源" } : null
  ].filter((item): item is { id: string; label: string } => Boolean(item));

  return (
    <Page className="gap-5 pb-8">
      <div className="hidden min-w-0 items-center justify-between gap-3 border-b pb-3 md:flex">
        <div className="flex min-w-0 items-center gap-2">
          <Button aria-label={`返回${sourceLabel}`} className="size-9 px-0" onClick={onBack} variant="ghost">
            <ArrowLeft />
          </Button>
          <div className="min-w-0 text-sm text-muted-foreground">
            <span>{sourceLabel}</span>
            <span aria-hidden="true" className="px-2">/</span>
            <span className="text-foreground">番剧详情</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {desktopClient && (
            <Button
              disabled={refreshing || !online}
              onClick={() => void refreshDetail()}
              title={online ? "刷新元数据" : "离线时不可刷新"}
              variant="outline"
            >
              <RefreshCw className={cn(refreshing && "animate-spin")} data-icon="inline-start" />
              {refreshing ? "刷新中" : "刷新"}
            </Button>
          )}
          <DetailMoreMenu
            externalLinks={viewModel.externalLinks}
            followed={viewModel.followed && desktopClient}
            onOpenExternal={openExternal}
            onRemove={() => setRemoveDialogOpen(true)}
          />
        </div>
      </div>

      {result.partialErrors.length > 0 && (
        <Alert>
          <AlertCircle />
          <AlertTitle>部分来源未能更新</AlertTitle>
          <AlertDescription>
            {result.partialErrors[0].source}：{result.partialErrors[0].message}
            {result.partialErrors.length > 1 ? `，另有 ${result.partialErrors.length - 1} 个来源异常。` : ""}
          </AlertDescription>
        </Alert>
      )}

      {!online && (
        <Alert>
          <Info />
          <AlertTitle>当前处于离线状态</AlertTitle>
          <AlertDescription>已显示本地缓存，恢复网络后可主动刷新详情。</AlertDescription>
        </Alert>
      )}

      <section className="min-w-0 border-b pb-6">
        {detail?.bannerUrl && (
          <div className="mb-4 h-36 overflow-hidden rounded-md border bg-muted sm:h-44 md:h-52">
            <CachedImage alt="" className="size-full object-cover" sourceUrl={detail.bannerUrl} />
          </div>
        )}

        <div className="grid min-w-0 grid-cols-[112px_minmax(0,1fr)] gap-4 md:grid-cols-[176px_minmax(0,1fr)] md:gap-6 lg:grid-cols-[176px_minmax(0,1fr)_auto]">
          <div className="aspect-[2/3] w-full overflow-hidden rounded-md border bg-muted">
            {result.anime.coverUrl ? (
              <CachedImage alt={viewModel.title} className="size-full object-cover" sourceUrl={result.anime.coverUrl} />
            ) : (
              <div className="flex size-full items-center justify-center text-muted-foreground"><ImageOff /></div>
            )}
          </div>

          <div className="min-w-0 self-center">
            <div className="flex min-w-0 flex-wrap gap-2">
              {viewModel.followed && <Badge tone="green"><CheckCircle2 className="mr-1 size-3" />已追番</Badge>}
              {viewModel.airingStatus && <Badge tone="primary">{viewModel.airingStatus}</Badge>}
              {result.stale && <Badge tone="amber">缓存较旧</Badge>}
            </div>
            <h1 className="mt-3 break-words text-2xl font-bold leading-8 tracking-normal md:text-3xl md:leading-10">
              {viewModel.title}
            </h1>
            {viewModel.subtitle && (
              <p className="mt-1 break-words text-sm leading-5 text-muted-foreground">{viewModel.subtitle}</p>
            )}
            <div className="mt-3 flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" />{viewModel.premiere}</span>
              {viewModel.format && <span>{viewModel.format}</span>}
              {result.anime.rating && (
                <span className="inline-flex items-center gap-1.5 text-foreground">
                  <Star className="size-4 fill-current text-warning" />
                  <strong>{result.anime.rating.score.toFixed(1)}</strong>
                  <span className="text-muted-foreground">{result.anime.rating.source}</span>
                </span>
              )}
              {detail?.ranking && <span>#{detail.ranking.rank} · {detail.ranking.source}</span>}
            </div>
          </div>

          <div className="col-span-2 flex min-w-0 flex-col gap-2 lg:col-span-1 lg:w-48 lg:self-end">
            {!desktopClient ? (
              result.myAnime ? (
                <Button onClick={() => onOpenLibraryAction(animeId, "tasks")} variant="outline">
                  <ListTodo data-icon="inline-start" />查看追番
                </Button>
              ) : null
            ) : result.myAnime ? (
              <>
                <Button onClick={() => onOpenLibraryAction(animeId, "rules")}>
                  <SlidersHorizontal data-icon="inline-start" />编辑规则
                </Button>
                <Button onClick={() => onOpenLibraryAction(animeId, "resources")} variant="outline">
                  <Download data-icon="inline-start" />查看资源
                </Button>
              </>
            ) : (
              <>
                <Button disabled={tracking} onClick={() => void addTracker()}>
                  <Plus data-icon="inline-start" />{tracking ? "添加中" : "添加追番"}
                </Button>
                <Button onClick={() => onOpenReleaseSearch(result.anime)} variant="outline">
                  <Search data-icon="inline-start" />搜索资源
                </Button>
              </>
            )}
          </div>
        </div>
      </section>

      {sectionLinks.length > 1 && (
        <nav aria-label="番剧详情分区" className="sticky top-0 z-20 -mx-4 hidden border-y bg-background px-4 md:flex md:-mx-5 md:px-5 xl:-mx-6 xl:px-6">
          {sectionLinks.map((item) => (
            <a className="border-b-2 border-transparent px-3 py-3 text-sm font-medium text-muted-foreground hover:border-primary hover:text-foreground" href={`#${item.id}`} key={item.id}>
              {item.label}
            </a>
          ))}
        </nav>
      )}

      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-8">
          {result.anime.summary && (
            <DetailSection id="detail-overview" title="简介">
              <p
                className={cn(
                  "whitespace-pre-line break-words text-sm leading-7 text-muted-foreground",
                  !summaryExpanded && "line-clamp-6 md:line-clamp-none"
                )}
                ref={summaryRef}
              >
                {result.anime.summary}
              </p>
              {summaryOverflow && (
                <Button className="mt-2 h-auto min-h-0 p-0 text-sm md:hidden" onClick={() => setSummaryExpanded(true)} variant="ghost">
                  展开简介
                </Button>
              )}
              {summaryExpanded && (
                <Button className="mt-2 h-auto min-h-0 p-0 text-sm md:hidden" onClick={() => setSummaryExpanded(false)} variant="ghost">
                  收起简介
                </Button>
              )}
            </DetailSection>
          )}

          {hasBasicInfo && (
            <DetailSection id="detail-info" title="基本信息">
              <div className="grid min-w-0 gap-x-8 gap-y-0 sm:grid-cols-2">
                {viewModel.format && <DetailFact label="形式" value={viewModel.format} />}
                {viewModel.airingStatus && <DetailFact label="放送状态" value={viewModel.airingStatus} />}
                {detail?.episodeCount && <DetailFact label="总集数" value={`${detail.episodeCount} 集`} />}
                {detail?.durationMinutes && <DetailFact label="单集时长" value={`${detail.durationMinutes} 分钟`} />}
                <DetailFact label="首播" value={viewModel.premiere} />
                {viewModel.endDate && <DetailFact label="完结" value={viewModel.endDate} />}
                {detail?.sourceMaterial && <DetailFact label="原作类型" value={formatMetadataValue(detail.sourceMaterial)} />}
                {detail?.contentRating && <DetailFact label="内容分级" value={detail.contentRating} />}
                {detail?.demographic && <DetailFact label="受众" value={detail.demographic} />}
              </div>
            </DetailSection>
          )}

          {detail?.genres?.length && (
            <DetailSection id="detail-genres" title="题材">
              <div className="flex flex-wrap gap-2">
                {detail.genres.map((genre) => <Badge key={genre}>{genre}</Badge>)}
              </div>
            </DetailSection>
          )}

          {hasProduction && (
            <DetailSection id="detail-production" title="制作信息">
              {detail?.studios?.length && (
                <div>
                  <h3 className="text-sm font-medium">制作公司</h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {detail.studios.map((studio) => <Badge tone="blue" key={studio}>{studio}</Badge>)}
                  </div>
                </div>
              )}
              {detail?.studios?.length && detail?.staff?.length && <Separator className="my-5" />}
              {detail?.staff?.length && (
                <div className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">
                  {detail.staff.map((credit) => (
                    <div className="min-w-0 border-b pb-3" key={`${credit.name}-${credit.role}`}>
                      <div className="break-words text-sm font-medium">{credit.name}</div>
                      <div className="mt-0.5 break-words text-xs text-muted-foreground">{credit.role}</div>
                    </div>
                  ))}
                </div>
              )}
            </DetailSection>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          {(viewModel.nextAiring || viewModel.broadcast) && (
            <DetailSection title="放送信息">
              {viewModel.nextAiring && <DetailFact icon={<Clock3 />} label="下一次放送" value={viewModel.nextAiring} />}
              {viewModel.broadcast && <DetailFact icon={<CalendarDays />} label="固定时段" value={viewModel.broadcast} />}
            </DetailSection>
          )}

          {result.myAnime && (
            <TrackerCard
              defaultFansubName={defaultFansubName}
              item={result.myAnime}
              result={result}
              viewModel={viewModel}
              onOpenAction={(action) => onOpenLibraryAction(animeId, action)}
              onRemove={() => setRemoveDialogOpen(true)}
              readOnly={!desktopClient}
            />
          )}

          {viewModel.aliases.length > 0 && (
            <DetailSection title="别名">
              <ul className="flex min-w-0 flex-col gap-2 text-sm text-muted-foreground">
                {viewModel.aliases.map((alias) => <li className="break-words" key={alias}>{alias}</li>)}
              </ul>
            </DetailSection>
          )}

          {viewModel.externalLinks.length > 0 && (
            <DetailSection id="detail-sources" title="外部来源">
              <div className="flex min-w-0 flex-col gap-1">
                {viewModel.externalLinks.map((link) => (
                  <Button className="min-w-0 justify-between px-2" key={link.key} onClick={() => void openExternal(link.url)} variant="ghost">
                    <span className="truncate">{link.label}</span><ExternalLink data-icon="inline-end" />
                  </Button>
                ))}
              </div>
              {viewModel.metadataSources.length > 0 && (
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  元数据来源：{viewModel.metadataSources.join("、")}
                </p>
              )}
            </DetailSection>
          )}
        </aside>
      </div>

      <AlertDialog onOpenChange={setRemoveDialogOpen} open={removeDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认移除追番？</AlertDialogTitle>
            <AlertDialogDescription>
              「{viewModel.title}」及其追番规则将被移除，已下载文件不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={removing} onClick={() => void removeTracker()} variant="destructive">
              {removing ? "移除中" : "移除追番"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

/** 渲染详情页中的无卡片分区。 */
function DetailSection({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 scroll-mt-14 border-t pt-4" id={id}>
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** 渲染标签和值组成的详情事实行。 */
function DetailFact({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3 border-b py-3 first:pt-0">
      {icon && <div className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</div>}
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 break-words text-sm font-medium">{value}</div>
      </div>
    </div>
  );
}

/** 渲染已追番详情中的进度、偏好与快捷操作。 */
function TrackerCard({
  defaultFansubName,
  item,
  result,
  viewModel,
  onOpenAction,
  onRemove,
  readOnly
}: {
  defaultFansubName?: string;
  item: MyAnime;
  result: AnimeDetailResult;
  viewModel: ReturnType<typeof buildAnimeDetailViewModel>;
  onOpenAction: (action: AnimeDetailLibraryAction) => void;
  onRemove: () => void;
  readOnly: boolean;
}) {
  const subtitleLanguages = resolveSubtitleLanguages(item.preferredSubtitleLanguages, item.preferredSubtitle);
  const progressLabel = viewModel.totalEpisodes
    ? `${viewModel.watchedCount} / ${viewModel.totalEpisodes} 集已看`
    : `${viewModel.watchedCount} 集已看`;

  return (
    <Card id="detail-tracker">
      <CardHeader>
        <CardTitle>追番概览</CardTitle>
        <CardDescription>{viewModel.trackerStatus} · {progressLabel}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">观看进度</span>
            <span className="font-medium tabular-nums">{Math.round((viewModel.progress ?? 0) * 100)}%</span>
          </div>
          <Progress className="mt-2 h-2" value={viewModel.progress ?? 0} />
          <div className="mt-2 text-xs text-muted-foreground">已下载或看完 {viewModel.downloadedCount} 集</div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <TrackerFact label="字幕组" value={defaultFansubName} />
          <TrackerFact label="自动下载" value={item.autoDownload ? "开启" : "关闭"} />
          <TrackerFact label="清晰度" value={item.preferredResolution} />
          <TrackerFact label="编码" value={item.preferredCodec} />
          <TrackerFact label="位深" value={item.preferredBitDepth ? formatVideoBitDepth(item.preferredBitDepth) : undefined} />
          <TrackerFact label="字幕" value={subtitleLanguages.length ? formatSubtitleLanguages(subtitleLanguages) : undefined} />
        </div>
        {result.episodes.length === 0 && <p className="text-xs text-muted-foreground">尚未建立单集记录。</p>}
      </CardContent>
      {!readOnly && <CardFooter className="grid grid-cols-3 gap-2">
        <Button aria-label="编辑规则" className="px-0" onClick={() => onOpenAction("rules")} title="编辑规则" variant="outline">
          <SlidersHorizontal />
        </Button>
        <Button aria-label="查看资源" className="px-0" onClick={() => onOpenAction("resources")} title="查看资源" variant="outline">
          <Download />
        </Button>
        <Button aria-label="下载任务" className="px-0" onClick={() => onOpenAction("tasks")} title="下载任务" variant="outline">
          <ListTodo />
        </Button>
        <Button className="col-span-3" onClick={onRemove} variant="ghost">
          <Trash2 data-icon="inline-start" />移除追番
        </Button>
      </CardFooter>}
    </Card>
  );
}

function TrackerFact({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return <div className="min-w-0"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 break-words font-medium">{value}</div></div>;
}

function DetailMoreMenu({
  externalLinks,
  followed,
  onOpenExternal,
  onRemove
}: {
  externalLinks: ReturnType<typeof buildAnimeDetailViewModel>["externalLinks"];
  followed: boolean;
  onOpenExternal: (url: string) => Promise<void>;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="更多详情操作" className="size-9 px-0" title="更多操作" variant="outline"><MoreHorizontal /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {externalLinks.length > 0 && (
          <DropdownMenuGroup>
            {externalLinks.map((link) => (
              <DropdownMenuItem key={link.key} onSelect={() => void onOpenExternal(link.url)}>
                <ExternalLink />打开 {link.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        {externalLinks.length > 0 && followed && <DropdownMenuSeparator />}
        {followed && (
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onRemove}>
            <Trash2 />移除追番
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 创建发现页和详情页共用的默认追番配置。 */
function createDefaultMyAnime(anime: Anime, timestamp: string): MyAnime {
  return {
    id: `my-${anime.id}`,
    anime,
    status: "watching",
    autoDownload: false,
    preferredResolution: "1080p",
    preferredCodec: "H.265/HEVC",
    preferredSubtitleLanguages: ["chs"],
    addedAt: timestamp,
    updatedAt: timestamp
  };
}

function formatMetadataValue(value: string): string {
  return value.replaceAll("_", " ").toLocaleLowerCase();
}

/** 保持海报、标题、动作区和双列内容尺寸稳定的详情骨架。 */
function AnimeDetailSkeleton() {
  return (
    <Page className="gap-5">
      <div className="hidden items-center justify-between border-b pb-3 md:flex"><Skeleton className="h-9 w-48" /><Skeleton className="h-9 w-28" /></div>
      <section className="border-b pb-6">
        <Skeleton className="mb-4 h-36 w-full sm:h-44 md:h-52" />
        <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-4 md:grid-cols-[176px_minmax(0,1fr)] md:gap-6 lg:grid-cols-[176px_minmax(0,1fr)_192px]">
          <Skeleton className="aspect-[2/3] w-full" />
          <div className="flex flex-col justify-center gap-3"><Skeleton className="h-6 w-28" /><Skeleton className="h-9 w-4/5" /><Skeleton className="h-5 w-3/5" /><Skeleton className="h-5 w-2/5" /></div>
          <div className="col-span-2 flex flex-col gap-2 lg:col-span-1 lg:justify-end"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
        </div>
      </section>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-8"><Skeleton className="h-48 w-full" /><Skeleton className="h-64 w-full" /></div>
        <div className="flex flex-col gap-6"><Skeleton className="h-40 w-full" /><Skeleton className="h-64 w-full" /></div>
      </div>
    </Page>
  );
}
