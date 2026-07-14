import {
  CalendarDays,
  CalendarPlus,
  ExternalLink,
  ImageOff,
  Plus,
  RotateCcw,
  Search,
  Star
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">新番发现</h1>
          <p className="mt-1 text-sm text-muted-foreground">按播出季度浏览新番，可按月份缩小范围。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void collectSeason(true)} disabled={collecting}>
            <RotateCcw className="h-4 w-4" />
            {collecting ? `刷新中 ${collectProgress}/3` : "强制刷新季度"}
          </Button>
          <Button onClick={() => void collectSeason(false)} disabled={collecting}>
            <CalendarPlus className="h-4 w-4" />
            {collectingLabel}
          </Button>
        </div>
      </div>

      {message && (
        <div
          className={
            message.tone === "success"
              ? "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              : "rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          }
        >
          {message.text}
        </div>
      )}

      <Panel className="p-0">
        <div className="grid grid-cols-[128px_minmax(0,1fr)_140px] items-center gap-3 p-3">
          <select
            aria-label="选择年份"
            className="h-10 rounded-md border bg-background px-3 text-sm font-medium outline-none focus:border-primary"
            value={target.year}
            onChange={(event) => setTarget((current) => ({ ...current, year: Number(event.target.value) }))}
          >
            {yearOptions.map((year) => (
              <option key={year} value={year}>
                {year} 年
              </option>
            ))}
          </select>

          <div className="grid h-10 grid-cols-4 overflow-hidden rounded-md border bg-background" role="group" aria-label="选择季度">
            {seasonOptions.map((season) => {
              const selected = target.season === season.value;
              return (
                <button
                  key={season.value}
                  aria-pressed={selected}
                  className={[
                    "border-r px-3 text-sm transition-colors last:border-r-0",
                    selected
                      ? "bg-primary font-medium text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  ].join(" ")}
                  type="button"
                  onClick={() => selectSeason(season.value)}
                >
                  <span className="font-medium">{season.shortLabel}</span>
                  <span className="ml-1.5 text-xs opacity-80">{season.months[0]}-{season.months[2]}月</span>
                </button>
              );
            })}
          </div>

          <div className="text-right text-sm font-medium tabular-nums">{resultLabel}</div>
        </div>

        <div className="grid grid-cols-[auto_160px_minmax(240px,1fr)_auto] items-center gap-3 border-t p-3">
          <div className="flex h-9 overflow-hidden rounded-md border bg-background" role="group" aria-label="选择月份">
            <button
              aria-pressed={selectedMonth === null}
              className={monthFilterClassName(selectedMonth === null)}
              type="button"
              onClick={() => setSelectedMonth(null)}
            >
              全部
            </button>
            {activeSeason.months.map((month) => (
              <button
                key={month}
                aria-pressed={selectedMonth === month}
                className={monthFilterClassName(selectedMonth === month)}
                type="button"
                onClick={() => setSelectedMonth(month)}
              >
                {month} 月
              </button>
            ))}
          </div>

          <select
            aria-label="排序方式"
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as DiscoverySortKey)}
          >
            <option value="premiereAsc">发布时间升序</option>
            <option value="premiereDesc">发布时间降序</option>
            <option value="ratingDesc">评分降序</option>
          </select>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
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
          </div>
          <Button variant="outline" onClick={searchCatalog} disabled={loading}>
            <Search className="h-4 w-4" />
            搜索
          </Button>
        </div>
      </Panel>

      {loading ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          正在加载季度新番目录...
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {visibleItems.map((anime) => {
            const followed = followedIds.has(anime.id);
            const externalIds = buildExternalIdBadges(anime);
            const titleDisplay = resolveAnimeTitleDisplay(anime);
            const hiddenAliases = titleDisplay.aliases.slice(2);

            return (
              <Panel key={anime.id} className="flex h-full flex-col overflow-hidden p-0">
                {anime.coverUrl ? (
                  <img
                    alt={titleDisplay.title}
                    className="aspect-[16/5] w-full bg-muted object-cover"
                    loading="lazy"
                    src={anime.coverUrl}
                  />
                ) : (
                  <div className="flex aspect-[16/5] w-full items-center justify-center bg-muted text-muted-foreground">
                    <ImageOff className="h-6 w-6" />
                  </div>
                )}

                <div className="flex flex-1 flex-col p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium" title={titleDisplay.title}>
                        {titleDisplay.title}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground" title={titleDisplay.subtitle}>
                        {titleDisplay.subtitle ?? "无别名"}
                      </div>
                    </div>
                    <Badge className="flex-none" tone={followed ? "green" : "blue"}>
                      {followed ? "已追番" : `${anime.premiereMonth} 月`}
                    </Badge>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <CalendarDays className="h-3.5 w-3.5 flex-none" />
                    <span>{formatPremiere(anime)}</span>
                    {anime.season && <span>· {seasonText[anime.season]}</span>}
                    <span className="inline-flex items-center gap-1">
                      <Star className="h-3.5 w-3.5 flex-none text-amber-500" />
                      {formatAnimeRating(anime)}
                    </span>
                  </div>

                  <p className="mt-2 line-clamp-2 min-h-12 text-sm leading-6 text-muted-foreground">
                    {anime.summary ?? "暂无简介"}
                  </p>

                  {titleDisplay.aliases.length > 0 && (
                    <div className="mt-3 flex min-h-6 flex-wrap gap-2">
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
                    <div className="mt-2 flex flex-wrap gap-2">
                      {externalIds.map((externalId) =>
                        externalId.url ? (
                          <button
                            key={externalId.key}
                            className={externalId.className}
                            title={`${externalId.label}: ${externalId.value}`}
                            type="button"
                            onClick={() => void openExternalId(externalId)}
                          >
                            <span className="truncate">
                              {externalId.label} {externalId.value}
                            </span>
                            <ExternalLink className="h-3 w-3 flex-none" />
                          </button>
                        ) : (
                          <Badge key={externalId.key} title={`${externalId.label}: ${externalId.value}`}>
                            {externalId.label} {externalId.value}
                          </Badge>
                        )
                      )}
                    </div>
                  )}

                  <div className="mt-auto pt-4">
                    <Button
                      className="w-full"
                      variant={followed ? "secondary" : "outline"}
                      disabled={followed || addingAnimeId === anime.id}
                      onClick={() => void addToMyAnime(anime)}
                    >
                      <Plus className="h-4 w-4" />
                      {followed ? "已在我的追番" : addingAnimeId === anime.id ? "添加中" : "添加追番"}
                    </Button>
                  </div>
                </div>
              </Panel>
            );
          })}

          {visibleItems.length === 0 && (
            <div className="col-span-full rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              {items.length === 0
                ? "当前季度没有本地目录。点击采集当前季度获取新番数据。"
                : "当前筛选条件下没有匹配的新番。"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const externalIdText: Record<string, { label: string; className: string }> = {
  bangumi: {
    label: "Bangumi",
    className: "border-cyan-200 bg-cyan-50 text-cyan-700 hover:border-cyan-400"
  },
  anilist: {
    label: "AniList",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-400"
  },
  mikan: {
    label: "Mikan",
    className: "border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-400"
  },
  mal: {
    label: "MAL",
    className: "border-border bg-muted text-muted-foreground hover:border-primary"
  }
};

const externalIdOrder = ["bangumi", "anilist", "mikan", "mal"];

interface ExternalIdBadge {
  key: string;
  label: string;
  value: string;
  className: string;
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

/** Returns the active and inactive styles for month filter buttons. */
function monthFilterClassName(selected: boolean): string {
  return [
    "min-w-14 border-r px-3 text-sm transition-colors last:border-r-0",
    selected
      ? "bg-accent font-medium text-accent-foreground"
      : "text-muted-foreground hover:bg-muted hover:text-foreground"
  ].join(" ");
}

/** Builds ordered metadata-source badges for an anime entry. */
function buildExternalIdBadges(anime: Anime): ExternalIdBadge[] {
  return Object.entries(anime.externalIds)
    .filter(([, value]) => Boolean(value))
    .sort(([left], [right]) => getExternalIdRank(left) - getExternalIdRank(right))
    .map(([key, value]) => ({
      key,
      label: externalIdText[key]?.label ?? key,
      value,
      className: [
        "inline-flex h-6 max-w-full items-center gap-1 rounded-md border px-2 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-primary/30",
        externalIdText[key]?.className ?? "border-border bg-muted text-muted-foreground"
      ].join(" "),
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
