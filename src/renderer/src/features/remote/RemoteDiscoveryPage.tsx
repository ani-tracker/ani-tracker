import { CalendarDays, ImageOff, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CachedImage } from "@/components/cached-image";
import { FilterToolbar, Page, PageHeader, PageHeading } from "@/components/page-layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { appApi } from "@/lib/api";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
import type { Anime, MyAnime, Season } from "@shared/domain";

interface SeasonOption {
  value: Season;
  label: string;
  months: readonly [number, number, number];
}

const seasonOptions: readonly SeasonOption[] = [
  { value: "winter", label: "冬", months: [1, 2, 3] },
  { value: "spring", label: "春", months: [4, 5, 6] },
  { value: "summer", label: "夏", months: [7, 8, 9] },
  { value: "fall", label: "秋", months: [10, 11, 12] }
];

/** 渲染远程客户端可读取的新番季度目录。 */
export function RemoteDiscoveryPage() {
  const currentTarget = getCurrentSeasonTarget();
  const [year, setYear] = useState(currentTarget.year);
  const [season, setSeason] = useState<Season>(currentTarget.season);
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");
  const [items, setItems] = useState<Anime[]>([]);
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const activeSeason = getSeasonOption(season);
  const followedIds = useMemo(() => new Set(myAnime.map((item) => item.anime.id)), [myAnime]);
  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 4 }, (_, index) => currentYear + 1 - index);
  }, []);
  const visibleItems = useMemo(
    () => filterAnimeItems(items, selectedMonth, appliedKeyword),
    [appliedKeyword, items, selectedMonth]
  );

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    Promise.all([
      Promise.all(getSeasonOption(season).months.map((month) => appApi.listAnimeCatalog(year, month))),
      appApi.listMyAnime()
    ])
      .then(([catalogs, followed]) => {
        if (requestId !== requestIdRef.current) return;
        setItems(mergeAnimeItems(catalogs.flat()));
        setMyAnime(followed);
        setError(null);
        console.info("[remote] 新番目录读取完成", { year, season, itemCount: catalogs.flat().length });
      })
      .catch((caught) => {
        if (requestId === requestIdRef.current) {
          console.error("[remote] 新番目录读取失败", { year, season, error: caught });
          setError(caught instanceof Error ? caught.message : "加载新番目录失败");
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [season, year]);

  return (
    <Page>
      <PageHeader>
        <PageHeading
          description="浏览桌面端已同步的新番目录；远程端仅提供筛选和阅读。"
          title="新番发现"
        />
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>新番目录读取失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <FilterToolbar>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <FieldGroup className="gap-3 lg:grid lg:grid-cols-[8rem_minmax(15rem,1fr)_minmax(14rem,1fr)_auto] lg:items-end">
            <Field>
              <FieldLabel className="sr-only" htmlFor="remote-discovery-year">选择年份</FieldLabel>
              <Select value={String(year)} onValueChange={(value) => setYear(Number(value))}>
                <SelectTrigger id="remote-discovery-year"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {yearOptions.map((option) => (
                      <SelectItem key={option} value={String(option)}>{option} 年</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel className="sr-only">选择季度</FieldLabel>
              <Tabs
                aria-label="选择季度"
                value={season}
                onValueChange={(value) => {
                  setSeason(value as Season);
                  setSelectedMonth(null);
                }}
              >
                <TabsList className="grid h-auto w-full grid-cols-4">
                  {seasonOptions.map((option) => (
                    <TabsTrigger key={option.value} value={option.value}>{option.label}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </Field>

            <Field>
              <FieldLabel className="sr-only" htmlFor="remote-discovery-keyword">搜索番剧</FieldLabel>
              <Input
                id="remote-discovery-keyword"
                placeholder="搜索标题、原名或别名"
                value={keyword}
                onChange={(event) => {
                  setKeyword(event.target.value);
                  if (!event.target.value) setAppliedKeyword("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") setAppliedKeyword(keyword.trim());
                }}
              />
            </Field>

            <Button className="w-full lg:w-auto" variant="outline" onClick={() => setAppliedKeyword(keyword.trim())}>
              <Search data-icon="inline-start" />
              搜索
            </Button>
          </FieldGroup>

          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Tabs
              className="min-w-0"
              value={selectedMonth === null ? "all" : String(selectedMonth)}
              onValueChange={(value) => setSelectedMonth(value === "all" ? null : Number(value))}
            >
              <TabsList className="grid h-auto w-full grid-cols-4 sm:w-fit" aria-label="筛选首播月份">
                <TabsTrigger value="all">全部</TabsTrigger>
                {activeSeason.months.map((month) => (
                  <TabsTrigger key={month} value={String(month)}>{month} 月</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <span className="text-xs text-muted-foreground">{year} 年 · 显示 {visibleItems.length} 部</span>
          </div>
        </div>
      </FilterToolbar>

      {loading ? (
        <DiscoverySkeleton />
      ) : visibleItems.length > 0 ? (
        <div className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {visibleItems.map((anime) => {
            const titleDisplay = resolveAnimeTitleDisplay(anime);
            const followed = followedIds.has(anime.id);
            return (
              <article className="min-w-0" key={anime.id}>
                <div className="aspect-[2/3] overflow-hidden rounded-md bg-muted">
                  {anime.coverUrl ? (
                    <CachedImage
                      alt={titleDisplay.title}
                      className="size-full object-cover"
                      loading="lazy"
                      sourceUrl={anime.coverUrl}
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center text-muted-foreground">
                      <ImageOff />
                    </div>
                  )}
                </div>

                <div className="mt-3 min-w-0">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={titleDisplay.title}>
                      {titleDisplay.title}
                    </h2>
                    {followed && <Badge className="shrink-0" tone="green">已追番</Badge>}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={titleDisplay.subtitle ?? "无别名"}>
                    {titleDisplay.subtitle ?? "无别名"}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <CalendarDays className="size-3.5" />
                      {formatPremiere(anime)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Star className="size-3.5" />
                      {anime.rating ? anime.rating.score.toFixed(1) : "暂无评分"}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {anime.summary ?? "暂无简介"}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Search /></EmptyMedia>
            <EmptyTitle>没有匹配的新番</EmptyTitle>
            <EmptyDescription>{items.length === 0 ? "桌面端当前季度尚无目录数据。" : "请调整月份或关键词。"}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Page>
  );
}

/** 渲染新番图鉴加载中的稳定占位布局。 */
function DiscoverySkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="正在加载新番目录"
      className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5"
    >
      {Array.from({ length: 10 }, (_, index) => (
        <div className="min-w-0" key={index}>
          <Skeleton className="aspect-[2/3] w-full rounded-md" />
          <Skeleton className="mt-3 h-4 w-4/5" />
          <Skeleton className="mt-2 h-3 w-3/5" />
        </div>
      ))}
    </div>
  );
}

/** 返回当前日期所属的新番季度。 */
function getCurrentSeasonTarget(): { year: number; season: Season } {
  const date = new Date();
  return { year: date.getFullYear(), season: getSeasonByMonth(date.getMonth() + 1) };
}

/** 将自然月映射到新番季度。 */
function getSeasonByMonth(month: number): Season {
  if (month <= 3) return "winter";
  if (month <= 6) return "spring";
  if (month <= 9) return "summer";
  return "fall";
}

/** 返回季度对应的月份配置。 */
function getSeasonOption(season: Season): SeasonOption {
  return seasonOptions.find((option) => option.value === season) ?? seasonOptions[0];
}

/** 合并三个自然月目录并按番剧 ID 去重。 */
function mergeAnimeItems(items: Anime[]): Anime[] {
  return Array.from(new Map(items.map((anime) => [anime.id, anime])).values());
}

/** 按月份与多语言标题过滤远程目录。 */
function filterAnimeItems(items: Anime[], month: number | null, keyword: string): Anime[] {
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  return items
    .filter((anime) => month === null || anime.premiereMonth === month)
    .filter((anime) => {
      if (!normalizedKeyword) return true;
      return [anime.title, anime.originalTitle, ...anime.aliases.map((alias) => alias.alias)]
        .some((title) => title?.toLocaleLowerCase().includes(normalizedKeyword));
    })
    .sort((left, right) => `${left.premiereYear}-${left.premiereMonth}`.localeCompare(`${right.premiereYear}-${right.premiereMonth}`));
}

/** 格式化番剧首播日期用于图鉴展示。 */
function formatPremiere(anime: Anime): string {
  return anime.premiereDate ?? `${anime.premiereMonth} 月`;
}
