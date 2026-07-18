import { CalendarDays, ImageOff, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CachedImage } from "@/components/cached-image";
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
    <div className="flex min-w-0 flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-normal">新番发现</h1>
        <p className="mt-1 text-sm text-muted-foreground">浏览桌面端已同步的新番目录。</p>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>新番目录读取失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>季度筛选</CardTitle>
          <CardDescription>{year} 年 · {visibleItems.length} 部</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-3 lg:grid lg:grid-cols-[128px_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
            <Field>
              <FieldLabel className="sr-only" htmlFor="remote-discovery-year">选择年份</FieldLabel>
              <Select value={String(year)} onValueChange={(value) => setYear(Number(value))}>
                <SelectTrigger id="remote-discovery-year"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {yearOptions.map((option) => <SelectItem key={option} value={String(option)}>{option} 年</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel className="sr-only">选择季度</FieldLabel>
              <Tabs
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

          <Tabs
            className="mt-3"
            value={selectedMonth === null ? "all" : String(selectedMonth)}
            onValueChange={(value) => setSelectedMonth(value === "all" ? null : Number(value))}
          >
            <TabsList className="grid h-auto w-full grid-cols-4 lg:w-fit">
              <TabsTrigger value="all">全部</TabsTrigger>
              {activeSeason.months.map((month) => <TabsTrigger key={month} value={String(month)}>{month} 月</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </CardContent>
      </Card>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="正在加载新番目录">
          {Array.from({ length: 6 }, (_, index) => <Skeleton className="h-72 w-full" key={index} />)}
        </div>
      ) : visibleItems.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleItems.map((anime) => {
            const titleDisplay = resolveAnimeTitleDisplay(anime);
            const followed = followedIds.has(anime.id);
            return (
              <Card key={anime.id} className="flex min-w-0 flex-col overflow-hidden">
                {anime.coverUrl ? (
                  <CachedImage alt={titleDisplay.title} className="aspect-[16/7] w-full bg-muted object-cover" loading="lazy" sourceUrl={anime.coverUrl} />
                ) : (
                  <div className="flex aspect-[16/7] w-full items-center justify-center bg-muted text-muted-foreground"><ImageOff /></div>
                )}
                <CardHeader>
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate" title={titleDisplay.title}>{titleDisplay.title}</CardTitle>
                      <CardDescription className="mt-1 truncate" title={titleDisplay.subtitle}>{titleDisplay.subtitle ?? "无别名"}</CardDescription>
                    </div>
                    <Badge tone={followed ? "green" : "blue"}>{followed ? "已追番" : `${anime.premiereMonth} 月`}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <CalendarDays />
                    <span>{formatPremiere(anime)}</span>
                    <Star />
                    <span>{anime.rating ? anime.rating.score.toFixed(1) : "暂无评分"}</span>
                  </div>
                  <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{anime.summary ?? "暂无简介"}</p>
                </CardContent>
              </Card>
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

/** 格式化番剧首播日期用于卡片展示。 */
function formatPremiere(anime: Anime): string {
  return anime.premiereDate ?? `${anime.premiereYear} 年 ${anime.premiereMonth} 月`;
}
