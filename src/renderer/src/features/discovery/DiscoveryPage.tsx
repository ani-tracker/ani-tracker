import {
  AlertCircle,
  CalendarDays,
  CalendarRange,
  CalendarPlus,
  CheckCircle2,
  ExternalLink,
  ImageOff,
  LayoutGrid,
  Plus,
  RotateCcw,
  Search
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CachedImage } from "@/components/cached-image";
import { FilterToolbar, Page, PageActions, PageHeader, PageHeading } from "@/components/page-layout";
import { appApi } from "@/lib/api";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
import type { Anime, MyAnime, Season } from "@shared/domain";

interface SeasonTarget {
  year: number;
  season: Season;
}

interface SeasonOption {
  value: Season;
  label: string;
  shortLabel: string;
  months: readonly [number, number, number];
}

type DiscoverySortKey = "premiereAsc" | "premiereDesc" | "ratingDesc";
type DiscoveryView = "catalog" | "schedule";

interface DiscoveryPageProps {
  onOpenAnimeDetail?: (animeId: string) => void;
}

const seasonOptions: readonly SeasonOption[] = [
  { value: "winter", label: "冬季", shortLabel: "冬", months: [1, 2, 3] },
  { value: "spring", label: "春季", shortLabel: "春", months: [4, 5, 6] },
  { value: "summer", label: "夏季", shortLabel: "夏", months: [7, 8, 9] },
  { value: "fall", label: "秋季", shortLabel: "秋", months: [10, 11, 12] }
];

const seasonText: Record<Season, string> = {
  winter: "冬季",
  spring: "春季",
  summer: "夏季",
  fall: "秋季"
};

/** Renders the seasonal anime catalog and its follow actions. */
export function DiscoveryPage({ onOpenAnimeDetail }: DiscoveryPageProps = {}) {
  const [target, setTarget] = useState<SeasonTarget>(getCurrentSeasonTarget);
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");
  const [sortKey, setSortKey] = useState<DiscoverySortKey>("premiereAsc");
  const [viewMode, setViewMode] = useState<DiscoveryView>("catalog");
  const [items, setItems] = useState<Anime[]>([]);
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [addingAnimeId, setAddingAnimeId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const loadRequestId = useRef(0);

  const yearOptions = useMemo(buildYearOptions, []);
  const activeSeason = getSeasonOption(target.season);
  const followedIds = useMemo(() => new Set(myAnime.map((item) => item.anime.id)), [myAnime]);
  const visibleItems = useMemo(
    () => sortAnimeItems(filterAnimeItems(items, selectedMonth, appliedKeyword), sortKey),
    [appliedKeyword, items, selectedMonth, sortKey]
  );

  useEffect(() => {
    void loadSeasonCatalog(target.year, target.season);
  }, [target.year, target.season]);

  /** Loads and merges the three local month catalogs in the selected season. */
  async function loadSeasonCatalog(year: number, season: Season) {
    const requestId = ++loadRequestId.current;
    const months = getSeasonOption(season).months;
    setLoading(true);

    try {
      const [catalogs, followed] = await Promise.all([
        Promise.all(months.map((month) => appApi.listAnimeCatalog(year, month))),
        appApi.listMyAnime()
      ]);

      if (requestId !== loadRequestId.current) {
        return;
      }

      setItems(mergeAnimeItems(catalogs.flat()));
      setMyAnime(followed);
      setMessage(null);
    } catch (error) {
      if (requestId !== loadRequestId.current) {
        return;
      }

      console.error("[discovery] failed to load season catalog", { year, season, error });
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "加载新番目录失败"
      });
    } finally {
      if (requestId === loadRequestId.current) {
        setLoading(false);
      }
    }
  }

  /** Collects metadata for every month in the selected season. */
  async function collectSeason(forceRefresh = false) {
    setCollecting(true);
    console.info("[discovery] collecting season catalog", { ...target, forceRefresh });

    try {
      const result = await appApi.collectAnimeSeason({ ...target, forceRefresh });
      await loadSeasonCatalog(target.year, target.season);
      setMessage({
        tone: result.errors.length ? "error" : "success",
        text: result.errors.length
          ? `部分来源采集失败，已保留本地缓存：${result.errors[0]}`
          : `季度采集完成：新增 ${result.addedCount}，更新 ${result.existingCount}，共 ${result.items.length} 部`
      });
      console.info("[discovery] season catalog collected", {
        ...target,
        itemCount: result.items.length,
        errorCount: result.errors.length
      });
    } catch (error) {
      console.error("[discovery] failed to collect season catalog", { ...target, error });
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "采集新番失败"
      });
    } finally {
      setCollecting(false);
    }
  }

  /** Applies the current keyword to the selected season catalog. */
  function searchCatalog() {
    setAppliedKeyword(keyword.trim());
  }

  /** Adds one catalog entry to the user's anime library. */
  async function addToMyAnime(anime: Anime) {
    setAddingAnimeId(anime.id);
    try {
      const now = new Date().toISOString();
      const updated = await appApi.upsertMyAnime({
        id: `my-${anime.id}`,
        anime,
        status: "watching",
        autoDownload: false,
        preferredResolution: "1080p",
        preferredCodec: "H.265/HEVC",
        preferredSubtitleLanguages: ["chs"],
        addedAt: now,
        updatedAt: now
      });
      setMyAnime(updated);
      setMessage({ tone: "success", text: `已添加「${resolveAnimeTitleDisplay(anime).title}」到我的追番` });
      console.info("[discovery] anime added to library", { animeId: anime.id });
    } catch (error) {
      console.error("[discovery] failed to add anime", { animeId: anime.id, error });
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "添加追番失败"
      });
    } finally {
      setAddingAnimeId(null);
    }
  }

  /** Opens an external metadata page through the Electron bridge. */
  async function openExternalId(externalId: ExternalIdBadge) {
    if (!externalId.url) {
      return;
    }

    try {
      await appApi.openExternal(externalId.url);
    } catch (error) {
      console.error("[discovery] failed to open external page", { url: externalId.url, error });
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "打开外部页面失败"
      });
    }
  }

  /** Changes the active season and resets its month-only filter. */
  function selectSeason(season: Season) {
    setSelectedMonth(null);
    setTarget((current) => ({ ...current, season }));
  }

  /** 清空目录筛选并恢复默认首播排序。 */
  function resetFilters() {
    setSelectedMonth(null);
    setKeyword("");
    setAppliedKeyword("");
    setSortKey("premiereAsc");
  }

  const collectingLabel = collecting ? "采集中" : "采集当前季度";
  const resultLabel = loading
    ? "正在加载"
    : `${target.year} ${activeSeason.label} · ${visibleItems.length} 部`;

  return (
    <Page>
      <PageHeader>
        <PageHeading description="按季度浏览新番目录，并在时间表中查看首播安排。" title="新番发现" />
        <PageActions className="grid grid-cols-1 sm:grid-cols-2">
          <Button className="w-full" variant="outline" onClick={() => void collectSeason(true)} disabled={collecting}>
            <RotateCcw data-icon="inline-start" />
            {collecting ? "刷新中" : "强制刷新季度"}
          </Button>
          <Button className="w-full" onClick={() => void collectSeason(false)} disabled={collecting}>
            <CalendarPlus data-icon="inline-start" />
            {collectingLabel}
          </Button>
        </PageActions>
      </PageHeader>

      {message && (
        <Alert variant={message.tone === "error" ? "destructive" : "default"}>
          {message.tone === "error" ? <AlertCircle /> : <CheckCircle2 />}
          <AlertTitle>{message.tone === "error" ? "操作未完成" : "操作完成"}</AlertTitle>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <FilterToolbar className="items-stretch sm:flex-col sm:items-stretch">
          <div className="grid min-w-0 gap-3 md:grid-cols-[112px_minmax(18rem,1fr)] md:items-end min-[1440px]:grid-cols-[112px_minmax(16rem,1fr)_minmax(14rem,auto)_150px_auto]">
            <Field className="min-w-0">
              <FieldLabel className="sr-only" htmlFor="discovery-year">选择年份</FieldLabel>
              <Select
                value={String(target.year)}
                onValueChange={(value) => setTarget((current) => ({ ...current, year: Number(value) }))}
              >
                <SelectTrigger id="discovery-year">
                  <SelectValue placeholder="选择年份" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {yearOptions.map((year) => (
                      <SelectItem key={year} value={String(year)}>
                        {year} 年
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Tabs className="min-w-0" value={target.season} onValueChange={(value) => selectSeason(value as Season)}>
              <TabsList className="grid h-auto w-full grid-cols-4" aria-label="选择季度">
                {seasonOptions.map((season) => (
                  <TabsTrigger className="min-w-0 px-2" key={season.value} value={season.value}>
                    <span>{season.shortLabel}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <Field className="min-w-0 md:col-span-2 min-[1440px]:col-span-1">
              <FieldLabel className="sr-only">选择月份</FieldLabel>
              <Tabs
                value={selectedMonth === null ? "all" : String(selectedMonth)}
                onValueChange={(value) => setSelectedMonth(value === "all" ? null : Number(value))}
              >
                <TabsList className="grid h-auto w-full grid-cols-4" aria-label="选择月份">
                  <TabsTrigger value="all">全部</TabsTrigger>
                  {activeSeason.months.map((month) => (
                    <TabsTrigger key={month} value={String(month)}>{month} 月</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </Field>

            <Field className="min-w-0">
              <FieldLabel className="sr-only" htmlFor="discovery-sort">排序方式</FieldLabel>
              <Select value={sortKey} onValueChange={(value) => setSortKey(value as DiscoverySortKey)}>
                <SelectTrigger id="discovery-sort">
                  <SelectValue placeholder="排序方式" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="premiereAsc">发布时间升序</SelectItem>
                    <SelectItem value="premiereDesc">发布时间降序</SelectItem>
                    <SelectItem value="ratingDesc">评分降序</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <ToggleGroup
              aria-label="选择新番视图"
              className="grid grid-cols-2"
              type="single"
              value={viewMode}
              onValueChange={(value) => value && setViewMode(value as DiscoveryView)}
            >
              <ToggleGroupItem value="catalog">
                <LayoutGrid />
                图鉴
              </ToggleGroupItem>
              <ToggleGroupItem value="schedule">
                <CalendarRange />
                时间表
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <form
            className="min-w-0"
            onSubmit={(event) => {
              event.preventDefault();
              searchCatalog();
            }}
          >
            <Field className="min-w-0">
              <FieldLabel className="sr-only" htmlFor="discovery-keyword">搜索番剧</FieldLabel>
              <InputGroup>
                <InputGroupAddon className="pl-3 pr-0 text-muted-foreground">
                  <Search aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  id="discovery-keyword"
                  placeholder="搜索中文名、日文名、罗马音或英文名"
                  value={keyword}
                  onChange={(event) => {
                    const value = event.target.value;
                    setKeyword(value);
                    if (!value) setAppliedKeyword("");
                  }}
                />
                <InputGroupAddon>
                  <InputGroupButton aria-label="搜索新番" disabled={loading} title="搜索" type="submit">
                    <Search />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </form>
      </FilterToolbar>

      <div className="flex min-w-0 items-center justify-between gap-3 border-b pb-3">
        <div className="text-sm font-semibold tabular-nums text-primary">{resultLabel}</div>
        {(selectedMonth !== null || appliedKeyword || sortKey !== "premiereAsc") && (
          <Button className="h-auto min-h-0 p-0 text-xs" onClick={resetFilters} variant="ghost">
            <RotateCcw data-icon="inline-start" />
            重置所有筛选
          </Button>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5" aria-label="正在加载季度新番目录">
          {Array.from({ length: 10 }, (_, index) => (
            <div className="flex min-w-0 flex-col gap-3" key={index}>
              <Skeleton className="aspect-[2/3] w-full rounded-lg" />
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ))}
        </div>
      ) : viewMode === "schedule" ? (
        <DiscoverySchedule
          addingAnimeId={addingAnimeId}
          followedIds={followedIds}
          items={visibleItems}
          onAdd={addToMyAnime}
          onOpenDetail={onOpenAnimeDetail}
        />
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:gap-x-4 2xl:grid-cols-5">
          {visibleItems.map((anime) => (
            <DiscoveryAnimeCard
              adding={addingAnimeId === anime.id}
              anime={anime}
              followed={followedIds.has(anime.id)}
              key={anime.id}
              onAdd={addToMyAnime}
              onOpenDetail={onOpenAnimeDetail}
              onOpenExternal={openExternalId}
            />
          ))}

          {visibleItems.length === 0 && (
            <Empty className="col-span-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  {items.length === 0 ? <CalendarPlus /> : <Search />}
                </EmptyMedia>
                <EmptyTitle>{items.length === 0 ? "当前季度暂无本地目录" : "没有匹配的新番"}</EmptyTitle>
                <EmptyDescription>
                  {items.length === 0
                    ? "采集当前季度后即可浏览新番数据。"
                    : "请调整月份或关键词后重试。"}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                {items.length === 0 ? (
                  <Button onClick={() => void collectSeason(false)} disabled={collecting}>
                    <CalendarPlus data-icon="inline-start" />
                    {collectingLabel}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setKeyword("");
                      setAppliedKeyword("");
                      setSelectedMonth(null);
                    }}
                  >
                    <RotateCcw data-icon="inline-start" />
                    清除筛选
                  </Button>
                )}
              </EmptyContent>
            </Empty>
          )}
        </div>
      )}
    </Page>
  );
}

/** 渲染无外层装饰卡片的 2:3 新番海报项。 */
function DiscoveryAnimeCard({
  adding,
  anime,
  followed,
  onAdd,
  onOpenDetail,
  onOpenExternal
}: {
  adding: boolean;
  anime: Anime;
  followed: boolean;
  onAdd: (anime: Anime) => Promise<void>;
  onOpenDetail?: (animeId: string) => void;
  onOpenExternal: (externalId: ExternalIdBadge) => Promise<void>;
}) {
  const titleDisplay = resolveAnimeTitleDisplay(anime);
  const externalIds = buildExternalIdBadges(anime).filter((item) => item.url).slice(0, 2);
  const aliasTitle = titleDisplay.aliases.map((alias) => alias.alias).join("\n");

  return (
    <article className="flex min-w-0 flex-col" title={aliasTitle || undefined}>
      <button
        aria-label={`查看${titleDisplay.title}详情`}
        className="relative aspect-[2/3] overflow-hidden rounded-lg border bg-muted text-left outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => onOpenDetail?.(anime.id)}
        type="button"
      >
        {anime.coverUrl ? (
          <CachedImage
            alt={titleDisplay.title}
            className="size-full object-cover"
            loading="lazy"
            sourceUrl={anime.coverUrl}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <ImageOff className="size-7" />
          </div>
        )}
        <Badge className="absolute right-2 top-2" tone="primary">
          {anime.rating ? anime.rating.score.toFixed(1) : `${anime.premiereMonth}月`}
        </Badge>
        {followed && <Badge className="absolute left-2 top-2" tone="green">已追番</Badge>}
      </button>

      <div className="mt-3 min-w-0">
        <button
          className="block w-full truncate text-left text-sm font-semibold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpenDetail?.(anime.id)}
          title={titleDisplay.title}
          type="button"
        >
          {titleDisplay.title}
        </button>
        <p className="mt-1 truncate text-xs text-muted-foreground" title={titleDisplay.subtitle}>
          {titleDisplay.subtitle ?? formatPremiere(anime)}
        </p>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarDays className="size-4 shrink-0" />
          <span className="truncate">{formatPremiere(anime)}</span>
        </div>
      </div>

      {externalIds.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {externalIds.map((externalId) => (
            <Button
              className="min-w-0 px-2"
              key={externalId.key}
              onClick={() => void onOpenExternal(externalId)}
              title={`${externalId.label}: ${externalId.value}`}
              type="button"
              variant="ghost"
            >
              <span className="truncate">{externalId.label}</span>
              <ExternalLink data-icon="inline-end" />
            </Button>
          ))}
        </div>
      )}

      <Button
        className="mt-2 w-full"
        disabled={followed || adding}
        onClick={() => void onAdd(anime)}
        variant={followed ? "secondary" : "primary"}
      >
        <Plus data-icon="inline-start" />
        {followed ? "已在追番" : adding ? "添加中" : "添加追番"}
      </Button>
    </article>
  );
}

const weekdayOptions = [
  { day: 1, label: "周一" },
  { day: 2, label: "周二" },
  { day: 3, label: "周三" },
  { day: 4, label: "周四" },
  { day: 5, label: "周五" },
  { day: 6, label: "周六" },
  { day: 0, label: "周日" }
] as const;

/** 按首播日期将季度目录组织为桌面周网格和移动单列时间表。 */
function DiscoverySchedule({
  addingAnimeId,
  followedIds,
  items,
  onAdd,
  onOpenDetail
}: {
  addingAnimeId: string | null;
  followedIds: Set<string>;
  items: Anime[];
  onAdd: (anime: Anime) => Promise<void>;
  onOpenDetail?: (animeId: string) => void;
}) {
  const schedule = weekdayOptions.map((weekday) => ({
    ...weekday,
    items: items.filter((anime) => getAnimeWeekday(anime) === weekday.day)
  }));
  const undatedItems = items.filter((anime) => getAnimeWeekday(anime) === null);

  if (items.length === 0) {
    return <DiscoveryEmptySchedule />;
  }

  return (
    <div className="min-w-0">
      <div className="hidden overflow-x-auto pb-2 md:block">
        <div className="grid min-w-[1120px] grid-cols-7 divide-x border-y">
          {schedule.map((weekday) => (
            <section className="min-w-0 px-2 pb-3" key={weekday.day}>
              <div className="sticky top-0 border-b bg-background py-3 text-xs font-semibold">
                {weekday.label} <span className="text-muted-foreground">{weekday.items.length}</span>
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {weekday.items.map((anime) => (
                  <DiscoveryScheduleItem
                    adding={addingAnimeId === anime.id}
                    anime={anime}
                    followed={followedIds.has(anime.id)}
                    key={anime.id}
                    onAdd={onAdd}
                    onOpenDetail={onOpenDetail}
                  />
                ))}
                {weekday.items.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">暂无首播</p>}
              </div>
            </section>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-5 md:hidden">
        {schedule.map((weekday) => (
          <section key={weekday.day}>
            <div className="flex items-center justify-between border-b pb-2 text-sm font-semibold">
              <span>{weekday.label}</span>
              <Badge>{weekday.items.length} 部</Badge>
            </div>
            <div className="mt-2 flex flex-col gap-2">
              {weekday.items.map((anime) => (
                <DiscoveryScheduleItem
                  adding={addingAnimeId === anime.id}
                  anime={anime}
                  followed={followedIds.has(anime.id)}
                  key={anime.id}
                  onAdd={onAdd}
                  onOpenDetail={onOpenDetail}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {undatedItems.length > 0 && (
        <section className="mt-5 border-t pt-4">
          <h2 className="text-sm font-semibold">首播日期待定 · {undatedItems.length}</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {undatedItems.map((anime) => (
              <DiscoveryScheduleItem
                adding={addingAnimeId === anime.id}
                anime={anime}
                followed={followedIds.has(anime.id)}
                key={anime.id}
                onAdd={onAdd}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** 渲染时间表中的紧凑新番条目。 */
function DiscoveryScheduleItem({
  adding,
  anime,
  followed,
  onAdd,
  onOpenDetail
}: {
  adding: boolean;
  anime: Anime;
  followed: boolean;
  onAdd: (anime: Anime) => Promise<void>;
  onOpenDetail?: (animeId: string) => void;
}) {
  const titleDisplay = resolveAnimeTitleDisplay(anime);
  return (
    <article className="flex min-w-0 items-start gap-2 rounded-md border-l-2 border-primary bg-card p-3">
      <button
        className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpenDetail?.(anime.id)}
        type="button"
      >
        <div className="text-xs font-medium text-primary">{formatScheduleDate(anime)}</div>
        <h3 className="mt-1 line-clamp-2 text-sm font-semibold">{titleDisplay.title}</h3>
        <p className="mt-1 truncate text-xs text-muted-foreground">{titleDisplay.subtitle ?? seasonText[anime.season ?? "winter"]}</p>
      </button>
      <Button
        aria-label={followed ? `${titleDisplay.title}已追番` : `添加${titleDisplay.title}到追番`}
        className="size-11 shrink-0 p-0 md:size-9"
        disabled={followed || adding}
        onClick={() => void onAdd(anime)}
        title={followed ? "已追番" : "添加追番"}
        variant={followed ? "secondary" : "outline"}
      >
        {followed ? <CheckCircle2 /> : <Plus />}
      </Button>
    </article>
  );
}

/** 渲染时间表无结果状态。 */
function DiscoveryEmptySchedule() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><CalendarRange /></EmptyMedia>
        <EmptyTitle>暂无时间表条目</EmptyTitle>
        <EmptyDescription>当前筛选条件下没有可展示的新番首播安排。</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** 返回新番首播日期对应的星期索引。 */
function getAnimeWeekday(anime: Anime): number | null {
  if (!anime.premiereDate) return null;
  const date = new Date(`${anime.premiereDate.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.getDay();
}

/** 格式化时间表条目的首播日期。 */
function formatScheduleDate(anime: Anime): string {
  const parts = anime.premiereDate?.match(/^\d{4}-(\d{2})-(\d{2})/);
  return parts ? `${Number(parts[1])} 月 ${Number(parts[2])} 日` : "日期待定";
}

const externalIdText: Record<string, string> = {
  bangumi: "Bangumi",
  anilist: "AniList",
  mikan: "Mikan",
  mal: "MAL"
};

const externalIdOrder = ["bangumi", "anilist", "mikan", "mal"];

interface ExternalIdBadge {
  key: string;
  label: string;
  value: string;
  url?: string;
}

/** Resolves the current date to its calendar anime season. */
function getCurrentSeasonTarget(): SeasonTarget {
  const date = new Date();
  return {
    year: date.getFullYear(),
    season: getSeasonByMonth(date.getMonth() + 1)
  };
}

/** Builds a compact year range for recent and upcoming seasonal catalogs. */
function buildYearOptions(): number[] {
  const currentYear = new Date().getFullYear();
  return Array.from({ length: 4 }, (_, index) => currentYear + 1 - index);
}

/** Finds the season containing the supplied month. */
function getSeasonByMonth(month: number): Season {
  if (month <= 3) return "winter";
  if (month <= 6) return "spring";
  if (month <= 9) return "summer";
  return "fall";
}

/** Returns display metadata for a season identifier. */
function getSeasonOption(season: Season): SeasonOption {
  return seasonOptions.find((option) => option.value === season) ?? seasonOptions[0];
}

/** Merges monthly catalogs and removes duplicates. */
function mergeAnimeItems(items: Anime[]): Anime[] {
  const uniqueItems = new Map(items.map((anime) => [anime.id, anime]));
  return Array.from(uniqueItems.values());
}

/** Filters a seasonal catalog by month and normalized title text. */
function filterAnimeItems(items: Anime[], month: number | null, keyword: string): Anime[] {
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  return items.filter((anime) => {
    if (month !== null && anime.premiereMonth !== month) {
      return false;
    }

    if (!normalizedKeyword) {
      return true;
    }

    const searchableTitles = [anime.title, anime.originalTitle, ...anime.aliases.map((alias) => alias.alias)];
    return searchableTitles.some((title) => title?.toLocaleLowerCase().includes(normalizedKeyword));
  });
}

/** Applies the selected catalog sort order after filtering. */
function sortAnimeItems(items: Anime[], sortKey: DiscoverySortKey): Anime[] {
  return [...items].sort((left, right) => {
    if (sortKey === "ratingDesc") {
      const leftScore = left.rating?.score;
      const rightScore = right.rating?.score;
      if (leftScore !== undefined || rightScore !== undefined) {
        if (leftScore === undefined) return 1;
        if (rightScore === undefined) return -1;
        if (leftScore !== rightScore) return rightScore - leftScore;
        if ((left.rating?.count ?? 0) !== (right.rating?.count ?? 0)) {
          return (right.rating?.count ?? 0) - (left.rating?.count ?? 0);
        }
      }
    }

    const direction = sortKey === "premiereDesc" ? -1 : 1;
    return direction * compareAnimePremiere(left, right) || left.title.localeCompare(right.title, "zh-CN");
  });
}

/** Compares two anime entries by the most precise premiere date available. */
function compareAnimePremiere(left: Anime, right: Anime): number {
  return getPremiereSortValue(left).localeCompare(getPremiereSortValue(right));
}

function getPremiereSortValue(anime: Anime): string {
  return anime.premiereDate ?? `${anime.premiereYear}-${String(anime.premiereMonth).padStart(2, "0")}-01`;
}

/** Formats the most precise available premiere date for a card. */
function formatPremiere(anime: Anime): string {
  const dateParts = anime.premiereDate?.match(/^\d{4}-(\d{2})-(\d{2})/);
  if (dateParts) {
    return `${Number(dateParts[1])} 月 ${Number(dateParts[2])} 日首播`;
  }
  return `${anime.premiereYear} 年 ${anime.premiereMonth} 月首播`;
}

/** Builds ordered metadata-source badges for an anime entry. */
function buildExternalIdBadges(anime: Anime): ExternalIdBadge[] {
  return Object.entries(anime.externalIds)
    .filter(([, value]) => Boolean(value))
    .sort(([left], [right]) => getExternalIdRank(left) - getExternalIdRank(right))
    .map(([key, value]) => ({
      key,
      label: externalIdText[key] ?? key,
      value,
      url: buildExternalIdUrl(key, value)
    }));
}

/** Returns the configured display order for one metadata source. */
function getExternalIdRank(key: string): number {
  const index = externalIdOrder.indexOf(key);
  return index >= 0 ? index : externalIdOrder.length;
}

/** Maps a metadata source identifier to its public detail page. */
function buildExternalIdUrl(key: string, value: string): string | undefined {
  if (key === "bangumi") {
    return `https://bgm.tv/subject/${encodeURIComponent(value)}`;
  }

  if (key === "anilist") {
    return `https://anilist.co/anime/${encodeURIComponent(value)}`;
  }

  if (key === "mikan") {
    return `https://mikanani.me/Home/Bangumi/${encodeURIComponent(value)}`;
  }

  if (key === "mal") {
    return `https://myanimelist.net/anime/${encodeURIComponent(value)}`;
  }

  return undefined;
}
