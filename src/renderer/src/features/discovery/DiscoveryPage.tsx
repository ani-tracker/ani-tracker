import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  CalendarRange,
  CalendarPlus,
  CheckCircle2,
  Download,
  ExternalLink,
  ImageOff,
  Info,
  LayoutGrid,
  List,
  Plus,
  RotateCcw,
  Search,
  Star
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
import { YearPicker } from "@/components/year-picker";
import { appApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
import { createDefaultMyAnimePreferences } from "@shared/my-anime-policy";
import type { Anime, MyAnime, Season } from "@shared/domain";

export interface SeasonTarget {
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
type ScheduleView = "grid" | "list";
interface DiscoveryPageProps {
  onOpenAnimeDetail?: (animeId: string) => void;
  onOpenSchedule?: (target: SeasonTarget) => void;
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
export function DiscoveryPage({ onOpenAnimeDetail, onOpenSchedule }: DiscoveryPageProps = {}) {
  const [target, setTarget] = useState<SeasonTarget>(getCurrentSeasonTarget);
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");
  const [sortKey, setSortKey] = useState<DiscoverySortKey>("premiereAsc");
  const [items, setItems] = useState<Anime[]>([]);
  const [searchItems, setSearchItems] = useState<Anime[]>([]);
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [addingAnimeId, setAddingAnimeId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const loadRequestId = useRef(0);
  const searchRequestId = useRef(0);

  const activeSeason = getSeasonOption(target.season);
  const followedIds = useMemo(() => new Set(myAnime.map((item) => item.anime.id)), [myAnime]);
  const visibleItems = useMemo(
    () => sortAnimeItems(
      appliedKeyword ? searchItems : filterAnimeItems(items, selectedMonth, ""),
      sortKey
    ),
    [appliedKeyword, items, searchItems, selectedMonth, sortKey]
  );
  const visibleLoading = appliedKeyword ? searching : loading;

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
      if (!appliedKeyword) {
        setMessage(null);
      }
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

  /** 搜索本地全量缓存与在线元数据来源。 */
  async function searchCatalog() {
    const normalizedKeyword = keyword.trim();
    if (!normalizedKeyword) {
      searchRequestId.current += 1;
      setAppliedKeyword("");
      setSearchItems([]);
      setSearching(false);
      return;
    }

    const requestId = ++searchRequestId.current;
    setAppliedKeyword(normalizedKeyword);
    setSearchItems([]);
    setSearching(true);
    setMessage(null);
    console.info("[discovery] searching local and online catalog", { keyword: normalizedKeyword });

    try {
      const result = await appApi.searchAnimeCatalog(normalizedKeyword);
      if (requestId !== searchRequestId.current) return;
      setSearchItems(result.items);
      setMessage(result.errors.length ? {
        tone: "error",
        text: `部分来源搜索失败，已展示可用结果：${result.errors[0]}`
      } : null);
      console.info("[discovery] catalog search completed", {
        keyword: normalizedKeyword,
        source: result.source,
        itemCount: result.items.length,
        errorCount: result.errors.length
      });
    } catch (error) {
      if (requestId !== searchRequestId.current) return;
      console.error("[discovery] catalog search failed", { keyword: normalizedKeyword, error });
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "搜索新番失败"
      });
    } finally {
      if (requestId === searchRequestId.current) {
        setSearching(false);
      }
    }
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
        ...createDefaultMyAnimePreferences(),
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

  /** 通过本地宿主打开外部元数据页面。 */
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

  /** 清空目录筛选并恢复默认首播排序。 */
  function resetFilters() {
    setSelectedMonth(null);
    setKeyword("");
    setAppliedKeyword("");
    setSearchItems([]);
    searchRequestId.current += 1;
    setSearching(false);
    setSortKey("premiereAsc");
  }

  const collectingLabel = collecting ? "采集中" : "采集当前季度";
  const resultLabel = visibleLoading
    ? appliedKeyword ? "正在搜索" : "正在加载"
    : appliedKeyword
      ? `“${appliedKeyword}” · ${visibleItems.length} 部`
      : `${target.year} ${activeSeason.label} · ${visibleItems.length} 部`;
  const emptyCatalog = !appliedKeyword && items.length === 0;

  return (
    <Page>
      <PageHeader>
        <PageHeading description="按季度浏览新番目录，并查看作品信息。" title="新番发现" />
        <PageActions className="grid grid-cols-1 sm:grid-cols-2">
          <Button className="w-full" variant="outline" onClick={() => onOpenSchedule?.(target)}>
            <CalendarRange data-icon="inline-start" />
            新番时间表
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
        <div className="grid min-w-0 gap-3 md:grid-cols-[8rem_minmax(14rem,1fr)] md:items-end min-[1440px]:grid-cols-[8rem_minmax(14rem,1fr)_150px]">
          <SeasonTargetPicker
            id="discovery-season"
            value={target}
            onValueChange={(nextTarget) => {
              if (nextTarget.season !== target.season) setSelectedMonth(null);
              setTarget(nextTarget);
            }}
          />

          <Field className="min-w-0">
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
                    if (!value) {
                      searchRequestId.current += 1;
                      setAppliedKeyword("");
                      setSearchItems([]);
                      setSearching(false);
                    }
                  }}
                />
                <InputGroupAddon>
                  <InputGroupButton aria-label="搜索新番" disabled={searching} title="搜索" type="submit">
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

      {visibleLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5" aria-label="正在加载季度新番目录">
          {Array.from({ length: 10 }, (_, index) => (
            <div className="flex min-w-0 flex-col gap-3" key={index}>
              <Skeleton className="aspect-[2/3] w-full rounded-lg" />
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ))}
        </div>
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
                  {emptyCatalog ? <CalendarPlus /> : <Search />}
                </EmptyMedia>
                <EmptyTitle>{emptyCatalog ? "当前季度暂无本地目录" : "没有匹配的新番"}</EmptyTitle>
                <EmptyDescription>
                  {emptyCatalog
                    ? "采集当前季度后即可浏览新番数据。"
                    : appliedKeyword ? "请更换关键词后重试。" : "请调整月份后重试。"}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                {emptyCatalog ? (
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
                      setSearchItems([]);
                      searchRequestId.current += 1;
                      setSearching(false);
                      if (!appliedKeyword) setSelectedMonth(null);
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

interface DiscoverySchedulePageProps {
  initialTarget: SeasonTarget;
  onBack: () => void;
  onOpenAnimeDetail?: (animeId: string) => void;
}

/** 渲染独立的新番时间表二级页面。 */
export function DiscoverySchedulePage({ initialTarget, onBack, onOpenAnimeDetail }: DiscoverySchedulePageProps) {
  const [target, setTarget] = useState(initialTarget);
  const [view, setView] = useState<ScheduleView>("grid");
  const [items, setItems] = useState<Anime[]>([]);
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingAnimeId, setAddingAnimeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRequestId = useRef(0);
  const activeSeason = getSeasonOption(target.season);
  const followedIds = useMemo(() => new Set(myAnime.map((item) => item.anime.id)), [myAnime]);
  const visibleItems = useMemo(
    () => sortAnimeItems(items, "premiereAsc"),
    [items]
  );
  const today = new Date();
  const todayItems = visibleItems.filter((anime) => getAnimeWeekday(anime) === today.getDay());

  useEffect(() => {
    const requestId = ++loadRequestId.current;
    setLoading(true);
    Promise.all([
      Promise.all(activeSeason.months.map((month) => appApi.listAnimeCatalog(target.year, month))),
      appApi.listMyAnime()
    ])
      .then(([catalogs, followed]) => {
        if (requestId !== loadRequestId.current) return;
        setItems(mergeAnimeItems(catalogs.flat()));
        setMyAnime(followed);
        setError(null);
      })
      .catch((caught) => {
        if (requestId !== loadRequestId.current) return;
        console.error("[discovery-schedule] 时间表加载失败", { ...target, error: caught });
        setError(caught instanceof Error ? caught.message : "加载新番时间表失败");
      })
      .finally(() => {
        if (requestId === loadRequestId.current) setLoading(false);
      });
  }, [activeSeason.months, target.season, target.year]);

  /** 添加时间表中的番剧到我的追番。 */
  async function addToMyAnime(anime: Anime) {
    setAddingAnimeId(anime.id);
    try {
      const now = new Date().toISOString();
      const updated = await appApi.upsertMyAnime({
        id: `my-${anime.id}`,
        anime,
        status: "watching",
        ...createDefaultMyAnimePreferences(),
        addedAt: now,
        updatedAt: now
      });
      setMyAnime(updated);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "添加追番失败");
    } finally {
      setAddingAnimeId(null);
    }
  }

  return (
    <Page>
      <PageHeader className="items-center sm:items-center" data-window-controls-clearance="">
        <Button className="h-auto w-fit min-h-0 justify-start px-0 text-xs" onClick={onBack} variant="ghost">
          <ArrowLeft data-icon="inline-start" />
          新番发现 / 新番时间表
        </Button>
        <div className="flex items-center gap-2 text-xs font-medium">
          <span className="uppercase text-muted-foreground">今日放送</span>
          <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
          <span>{formatTodayLabel(today)}</span>
        </div>
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>时间表加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <FilterToolbar className="items-stretch sm:items-center">
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[8rem_auto] sm:items-center sm:justify-between">
          <SeasonTargetPicker
            id="schedule-season"
            value={target}
            onValueChange={(nextTarget) => setTarget(nextTarget)}
          />
          <ToggleGroup
            aria-label="选择时间表视图"
            className="grid grid-cols-2 sm:w-fit"
            type="single"
            value={view}
            onValueChange={(value) => value && setView(value as ScheduleView)}
          >
            <ToggleGroupItem value="grid"><LayoutGrid data-icon="inline-start" />网格视图</ToggleGroupItem>
            <ToggleGroupItem value="list"><List data-icon="inline-start" />列表视图</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </FilterToolbar>

      {loading ? (
        <div className="min-w-0 overflow-x-auto" aria-label="正在加载新番时间表">
          <div className="grid min-w-[70rem] grid-cols-7 gap-2 overflow-hidden">
            {Array.from({ length: 7 }, (_, index) => <Skeleton className="h-48 w-full" key={index} />)}
          </div>
        </div>
      ) : view === "grid" ? (
        <DiscoverySchedule
          addingAnimeId={addingAnimeId}
          followedIds={followedIds}
          items={visibleItems}
          onAdd={addToMyAnime}
          onOpenDetail={onOpenAnimeDetail}
        />
      ) : (
        <DiscoveryScheduleList
          addingAnimeId={addingAnimeId}
          followedIds={followedIds}
          items={todayItems}
          onAdd={addToMyAnime}
          onOpenDetail={onOpenAnimeDetail}
        />
      )}
    </Page>
  );
}

/** 渲染新番页面共用的年份与季度选择器。 */
function SeasonTargetPicker({
  id,
  value,
  onValueChange
}: {
  id: string;
  value: SeasonTarget;
  onValueChange: (target: SeasonTarget) => void;
}) {
  const activeSeason = getSeasonOption(value.season);

  /** 选择季度，并保留当前年份。 */
  function selectSeason(season: string) {
    if (!season) return;
    console.info("[season-target-picker] 季度已选择", { year: value.year, season });
    onValueChange({ ...value, season: season as Season });
  }

  return (
    <Field className="min-w-0">
      <FieldLabel className="sr-only" htmlFor={`${id}-year`}>选择年份和季度</FieldLabel>
      <YearPicker
        closeOnValueChange={false}
        id={`${id}-year`}
        triggerLabel={`${value.year} ${activeSeason.shortLabel}`}
        value={value.year}
        onValueChange={(year) => onValueChange({ ...value, year })}
        renderAside={({ close }) => (
          <ToggleGroup
            aria-label="在选择器中选择季度"
            className="grid h-full grid-rows-4 items-stretch gap-2 rounded-2xl bg-muted/50 p-1.5"
            orientation="vertical"
            type="single"
            value={value.season}
            variant="outline"
            onValueChange={(season) => {
              if (!season) return;
              selectSeason(season);
              close();
            }}
          >
            {seasonOptions.map((season) => (
              <ToggleGroupItem
                aria-label={`选择${season.label}`}
                className="h-auto min-h-9 whitespace-nowrap rounded-xl px-3"
                key={season.value}
                value={season.value}
              >
                {season.shortLabel}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      />
    </Field>
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

/** 按首播日期将季度目录组织为 Stitch 周视图。 */
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
  const todayWeekday = new Date().getDay();

  return (
    <div className="min-w-0">
      <div className="overflow-x-auto pb-2">
        <div className="grid min-w-[1040px] grid-cols-7 divide-x border-y">
          {schedule.map((weekday) => (
            <section
              className={cn("min-w-0 px-2 pb-4", weekday.day === todayWeekday && "bg-primary/5")}
              key={weekday.day}
            >
              <div className="sticky top-0 border-b bg-inherit py-3 text-xs font-semibold uppercase">
                {weekday.label}
                {weekday.day === todayWeekday && <span className="ml-1 text-primary">（今天）</span>}
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

/** 按 Stitch 列表视图展示今天星期对应的番剧。 */
function DiscoveryScheduleList({
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
  if (items.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><CalendarDays /></EmptyMedia>
          <EmptyTitle>今天暂无番剧放送</EmptyTitle>
          <EmptyDescription>当前季度没有安排在今天首播的番剧。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="min-w-0 overflow-x-auto">
      <div className="min-w-[760px] border-y">
        <div className="grid grid-cols-[4.5rem_minmax(17rem,1.7fr)_7rem_7rem_minmax(11rem,1fr)_6rem] gap-4 border-b bg-muted/40 px-3 py-2 text-xs font-semibold uppercase text-muted-foreground">
          <span>海报</span><span>标题与信息</span><span>放送</span><span>状态</span><span>资源</span><span className="text-right">操作</span>
        </div>
        <div className="divide-y">
          {items.map((anime) => {
            const titleDisplay = resolveAnimeTitleDisplay(anime);
            const followed = followedIds.has(anime.id);
            const metadata = anime.detail;
            const detail = [metadata?.genres?.slice(0, 2).join("、"), metadata?.studios?.[0]].filter(Boolean).join(" · ");
            return (
              <article
                className="grid min-h-28 grid-cols-[4.5rem_minmax(17rem,1.7fr)_7rem_7rem_minmax(11rem,1fr)_6rem] items-center gap-4 px-3 py-3"
                key={anime.id}
              >
                <button className="aspect-[2/3] overflow-hidden border bg-muted" onClick={() => onOpenDetail?.(anime.id)} type="button">
                  {anime.coverUrl ? <CachedImage alt={titleDisplay.title} className="size-full object-cover" sourceUrl={anime.coverUrl} /> : <ImageOff className="m-auto" />}
                </button>
                <button className="min-w-0 text-left" onClick={() => onOpenDetail?.(anime.id)} type="button">
                  <h3 className="line-clamp-2 text-sm font-semibold">{titleDisplay.title}{titleDisplay.subtitle ? `（${titleDisplay.subtitle}）` : ""}</h3>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{detail || `${anime.premiereYear} ${seasonText[anime.season ?? "winter"]}`}</p>
                </button>
                <span className="text-xs font-medium text-primary">{formatBroadcastTime(anime)}</span>
                <Badge className="w-fit" tone={followed ? "primary-soft" : "neutral"}>{followed ? "追番中" : "待关注"}</Badge>
                <div className="min-w-0 text-xs">
                  <div className="truncate font-medium">{followed ? "可搜索最新资源" : "等待追番后匹配"}</div>
                  <div className="mt-1 truncate text-muted-foreground">{formatScheduleDate(anime)}</div>
                </div>
                <div className="flex justify-end gap-1">
                  <Button aria-label={`搜索${titleDisplay.title}资源`} className="size-9 p-0" onClick={() => onOpenDetail?.(anime.id)} title="查看资源" variant="ghost"><Download /></Button>
                  <Button
                    aria-label={followed ? `${titleDisplay.title}已追番` : `添加${titleDisplay.title}到追番`}
                    className="size-9 p-0"
                    disabled={followed || addingAnimeId === anime.id}
                    onClick={() => void onAdd(anime)}
                    title={followed ? "已追番" : "添加追番"}
                    variant="ghost"
                  >
                    {followed ? <Info /> : <Plus />}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
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
    <article className={cn("flex min-w-0 items-start gap-2 bg-background p-3", followed && "border-l-2 border-primary")}>
      <button
        className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpenDetail?.(anime.id)}
        type="button"
      >
        <div className="text-xs font-medium text-primary">{formatBroadcastTime(anime)}</div>
        <h3 className="mt-1 line-clamp-2 text-sm font-semibold">{titleDisplay.title}</h3>
        <p className="mt-1 truncate text-xs text-muted-foreground">{followed ? "追番中" : titleDisplay.subtitle ?? formatScheduleDate(anime)}</p>
      </button>
      <Button
        aria-label={followed ? `${titleDisplay.title}已追番` : `添加${titleDisplay.title}到追番`}
        className="size-11 shrink-0 p-0 md:size-9"
        disabled={followed || adding}
        onClick={() => void onAdd(anime)}
        title={followed ? "已追番" : "添加追番"}
        variant={followed ? "secondary" : "outline"}
      >
        {followed ? <Star /> : <Search />}
      </Button>
    </article>
  );
}

/** 返回新番首播日期对应的星期索引。 */
function getAnimeWeekday(anime: Anime): number | null {
  if (anime.detail?.broadcast?.weekday !== undefined) return anime.detail.broadcast.weekday;
  if (!anime.premiereDate) return null;
  const date = new Date(`${anime.premiereDate.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.getDay();
}

/** 格式化番剧的常规放送时间。 */
function formatBroadcastTime(anime: Anime): string {
  const time = anime.detail?.broadcast?.time;
  const timezone = anime.detail?.broadcast?.timezone;
  return time ? `${time}${timezone ? ` ${timezone}` : ""}` : formatScheduleDate(anime);
}

/** 格式化时间表右上角的今天日期。 */
function formatTodayLabel(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(date);
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
