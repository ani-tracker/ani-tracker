import {
  AlertCircle,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  ExternalLink,
  ImageOff,
  Plus,
  RotateCcw,
  Search,
  Star
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
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
export function DiscoveryPage() {
  const [target, setTarget] = useState<SeasonTarget>(getCurrentSeasonTarget);
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");
  const [sortKey, setSortKey] = useState<DiscoverySortKey>("premiereAsc");
  const [items, setItems] = useState<Anime[]>([]);
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [collectProgress, setCollectProgress] = useState(0);
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
    const months = activeSeason.months;
    setCollecting(true);
    setCollectProgress(0);
    console.info("[discovery] collecting season catalog", { ...target, forceRefresh });

    try {
      const results = [];
      const requestErrors: string[] = [];
      for (const [index, month] of months.entries()) {
        try {
          const result = await appApi.collectAnimeMonth({
            year: target.year,
            month,
            forceRefresh
          });
          results.push(result);
        } catch (error) {
          const errorText = error instanceof Error ? error.message : `${month} 月采集失败`;
          requestErrors.push(`${month} 月：${errorText}`);
          console.error("[discovery] failed to collect month catalog", { year: target.year, month, error });
        } finally {
          setCollectProgress(index + 1);
        }
      }

      await loadSeasonCatalog(target.year, target.season);
      const collectedItems = mergeAnimeItems(results.flatMap((result) => result.items));
      const errors = [...requestErrors, ...results.flatMap((result) => result.errors)];
      const addedCount = results.reduce((total, result) => total + result.addedCount, 0);
      const existingCount = results.reduce((total, result) => total + result.existingCount, 0);
      setMessage({
        tone: errors.length ? "error" : "success",
        text: errors.length
          ? `部分月份采集失败，已保留本地缓存：${errors[0]}`
          : `季度采集完成：新增 ${addedCount}，更新 ${existingCount}，共 ${collectedItems.length} 部`
      });
      console.info("[discovery] season catalog collected", {
        ...target,
        itemCount: collectedItems.length,
        errorCount: errors.length
      });
    } catch (error) {
      console.error("[discovery] failed to collect season catalog", { ...target, error });
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "采集新番失败"
      });
    } finally {
      setCollecting(false);
      setCollectProgress(0);
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
        preferredSubtitle: "chs",
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

  const collectingLabel = collecting ? `采集中 ${collectProgress}/3` : "采集当前季度";
  const resultLabel = loading
    ? "正在加载"
    : `${target.year} ${activeSeason.label} · ${visibleItems.length} 部`;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">新番发现</h1>
          <p className="mt-1 text-sm text-muted-foreground">按播出季度浏览新番，可按月份缩小范围。</p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button className="w-full" variant="outline" onClick={() => void collectSeason(true)} disabled={collecting}>
            <RotateCcw data-icon="inline-start" />
            {collecting ? `刷新中 ${collectProgress}/3` : "强制刷新季度"}
          </Button>
          <Button className="w-full" onClick={() => void collectSeason(false)} disabled={collecting}>
            <CalendarPlus data-icon="inline-start" />
            {collectingLabel}
          </Button>
        </div>
      </div>

      {message && (
        <Alert variant={message.tone === "error" ? "destructive" : "default"}>
          {message.tone === "error" ? <AlertCircle /> : <CheckCircle2 />}
          <AlertTitle>{message.tone === "error" ? "操作未完成" : "操作完成"}</AlertTitle>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex min-w-0 flex-col gap-3 md:grid md:grid-cols-[128px_minmax(0,1fr)_140px] md:items-end">
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
                    <span className="hidden lg:inline">{season.months[0]}-{season.months[2]}月</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="text-sm font-medium tabular-nums md:text-right">{resultLabel}</div>
          </div>
        </CardHeader>

        <CardContent className="pt-4 sm:pt-5">
          <FieldGroup className="gap-3 lg:grid lg:grid-cols-[minmax(0,auto)_160px_minmax(0,1fr)_auto] lg:items-end">
            <Field className="min-w-0">
              <FieldLabel className="sr-only">选择月份</FieldLabel>
              <Tabs
                value={selectedMonth === null ? "all" : String(selectedMonth)}
                onValueChange={(value) => setSelectedMonth(value === "all" ? null : Number(value))}
              >
                <TabsList className="grid h-auto w-full grid-cols-4 lg:w-auto" aria-label="选择月份">
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

            <Field className="min-w-0">
              <FieldLabel className="sr-only" htmlFor="discovery-keyword">搜索番剧</FieldLabel>
              <Input
                id="discovery-keyword"
                placeholder="搜索中文名、日文名、罗马音或英文名"
                value={keyword}
                onChange={(event) => {
                  const value = event.target.value;
                  setKeyword(value);
                  if (!value) {
                    setAppliedKeyword("");
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    searchCatalog();
                  }
                }}
              />
            </Field>

            <Button className="w-full lg:w-auto" variant="outline" onClick={searchCatalog} disabled={loading}>
              <Search data-icon="inline-start" />
              搜索
            </Button>
          </FieldGroup>
        </CardContent>
      </Card>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="正在加载季度新番目录">
          {Array.from({ length: 6 }, (_, index) => (
            <Card key={index} className="overflow-hidden">
              <Skeleton className="aspect-[16/7] w-full rounded-none" />
              <CardHeader>
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleItems.map((anime) => {
            const followed = followedIds.has(anime.id);
            const externalIds = buildExternalIdBadges(anime);
            const titleDisplay = resolveAnimeTitleDisplay(anime);
            const hiddenAliases = titleDisplay.aliases.slice(2);

            return (
              <Card key={anime.id} className="flex h-full min-w-0 flex-col overflow-hidden">
                {anime.coverUrl ? (
                  <img
                    alt={titleDisplay.title}
                    className="aspect-[16/7] w-full bg-muted object-cover"
                    loading="lazy"
                    src={anime.coverUrl}
                  />
                ) : (
                  <div className="flex aspect-[16/7] w-full items-center justify-center bg-muted text-muted-foreground">
                    <ImageOff className="h-6 w-6" />
                  </div>
                )}

                <CardHeader className="flex-row items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate" title={titleDisplay.title}>
                      {titleDisplay.title}
                    </CardTitle>
                    <CardDescription className="mt-1 truncate" title={titleDisplay.subtitle}>
                      {titleDisplay.subtitle ?? "无别名"}
                    </CardDescription>
                  </div>
                  <Badge className="flex-none" tone={followed ? "green" : "blue"}>
                    {followed ? "已追番" : `${anime.premiereMonth} 月`}
                  </Badge>
                </CardHeader>

                <CardContent className="flex flex-1 flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <CalendarDays className="h-3.5 w-3.5 flex-none" />
                    <span>{formatPremiere(anime)}</span>
                    {anime.season && <span>· {seasonText[anime.season]}</span>}
                    <span className="inline-flex items-center gap-1">
                      <Star className="h-3.5 w-3.5 flex-none text-primary" />
                      {formatAnimeRating(anime)}
                    </span>
                  </div>

                  <p className="line-clamp-2 min-h-12 text-sm leading-6 text-muted-foreground">
                    {anime.summary ?? "暂无简介"}
                  </p>

                  {titleDisplay.aliases.length > 0 && (
                    <div className="flex min-h-6 flex-wrap gap-2">
                      {titleDisplay.aliases.slice(0, 2).map((alias) => (
                        <Badge key={alias.id} className="max-w-[220px] truncate" title={alias.alias}>
                          {alias.alias}
                        </Badge>
                      ))}
                      {hiddenAliases.length > 0 && (
                        <Badge title={hiddenAliases.map((alias) => alias.alias).join("\n")}>
                          +{hiddenAliases.length}
                        </Badge>
                      )}
                    </div>
                  )}

                  {externalIds.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {externalIds.map((externalId) =>
                        externalId.url ? (
                          <Button
                            key={externalId.key}
                            className="max-w-full"
                            title={`${externalId.label}: ${externalId.value}`}
                            type="button"
                            variant="outline"
                            onClick={() => void openExternalId(externalId)}
                          >
                            <span className="min-w-0 truncate">{externalId.label} {externalId.value}</span>
                            <ExternalLink data-icon="inline-end" />
                          </Button>
                        ) : (
                          <Badge className="max-w-full truncate" key={externalId.key} title={`${externalId.label}: ${externalId.value}`}>
                            {externalId.label} {externalId.value}
                          </Badge>
                        )
                      )}
                    </div>
                  )}
                </CardContent>

                <CardFooter className="mt-auto">
                  <Button
                    className="w-full"
                    variant={followed ? "secondary" : "outline"}
                    disabled={followed || addingAnimeId === anime.id}
                    onClick={() => void addToMyAnime(anime)}
                  >
                    <Plus data-icon="inline-start" />
                    {followed ? "已在我的追番" : addingAnimeId === anime.id ? "添加中" : "添加追番"}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}

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
    </div>
  );
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

function formatAnimeRating(anime: Anime): string {
  if (!anime.rating) {
    return "暂无评分";
  }

  const countText = anime.rating.count ? ` / ${anime.rating.count} 人` : "";
  return `${anime.rating.score.toFixed(1)}${countText}`;
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
