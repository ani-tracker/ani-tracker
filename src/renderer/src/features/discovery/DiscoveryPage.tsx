import { CalendarPlus, ExternalLink, Plus, RotateCcw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appApi } from "@/lib/api";
import { formatMonth } from "@/lib/format";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
import type { Anime, MyAnime } from "@shared/domain";

export function DiscoveryPage() {
  const defaultTarget = getPreviousMonth();
  const [target, setTarget] = useState(defaultTarget);
  const [keyword, setKeyword] = useState("");
  const [items, setItems] = useState<Anime[]>([]);
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [addingAnimeId, setAddingAnimeId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const monthOptions = useMemo(() => buildMonthOptions(), []);
  const followedIds = useMemo(() => new Set(myAnime.map((item) => item.anime.id)), [myAnime]);

  useEffect(() => {
    void loadCatalog(target.year, target.month);
  }, [target.year, target.month]);

  async function loadCatalog(year: number, month: number) {
    setLoading(true);
    try {
      const [catalogItems, followed] = await Promise.all([appApi.listAnimeCatalog(year, month), appApi.listMyAnime()]);
      setItems(catalogItems);
      setMyAnime(followed);
      setMessage(null);
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "加载新番目录失败"
      });
    } finally {
      setLoading(false);
    }
  }

  async function collectMonth(forceRefresh = false) {
    setCollecting(true);
    try {
      const result = await appApi.collectAnimeMonth({
        year: target.year,
        month: target.month,
        forceRefresh
      });
      setItems(result.items);
      setMessage({
        tone: result.errors.length ? "error" : "success",
        text: result.errors.length
          ? `采集失败，显示本地缓存 ${result.items.length} 部：${result.errors[0]}`
          : `采集完成：新增 ${result.addedCount}，更新 ${result.existingCount}，共 ${result.items.length} 部`
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "采集新番失败"
      });
    } finally {
      setCollecting(false);
    }
  }

  async function searchCatalog() {
    const value = keyword.trim();
    if (!value) {
      await loadCatalog(target.year, target.month);
      return;
    }

    setLoading(true);
    try {
      setItems(await appApi.searchAnimeCatalog(value));
      setMessage(null);
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "搜索番剧目录失败"
      });
    } finally {
      setLoading(false);
    }
  }

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
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "添加追番失败"
      });
    } finally {
      setAddingAnimeId(null);
    }
  }

  async function openExternalId(externalId: ExternalIdBadge) {
    if (!externalId.url) {
      return;
    }

    try {
      await appApi.openExternal(externalId.url);
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "打开外部页面失败"
      });
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">新番发现</h1>
          <p className="mt-1 text-sm text-muted-foreground">按首播年月采集新番，确认后添加到我的追番。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void collectMonth(true)} disabled={collecting}>
            <RotateCcw className="h-4 w-4" />
            {collecting ? "采集中" : "强制刷新"}
          </Button>
          <Button onClick={() => void collectMonth(false)} disabled={collecting}>
            <CalendarPlus className="h-4 w-4" />
            {collecting ? "采集中" : "采集选中月份"}
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

      <Panel>
        <div className="grid grid-cols-[220px_minmax(0,1fr)_auto] gap-3">
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            value={`${target.year}-${target.month}`}
            onChange={(event) => {
              const [year, month] = event.target.value.split("-").map(Number);
              setTarget({ year, month });
            }}
          >
            {monthOptions.map((option) => (
              <option key={`${option.year}-${option.month}`} value={`${option.year}-${option.month}`}>
                {formatMonth(option.year, option.month)}
              </option>
            ))}
          </select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
              placeholder="搜索中文名、日文名、罗马音或英文名"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void searchCatalog();
                }
              }}
            />
          </div>
          <Button variant="outline" onClick={() => void searchCatalog()} disabled={loading}>
            <Search className="h-4 w-4" />
            搜索
          </Button>
        </div>
      </Panel>

      {loading ? (
        <div className="text-sm text-muted-foreground">正在加载新番目录...</div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {items.map((anime) => {
            const followed = followedIds.has(anime.id);
            const externalIds = buildExternalIdBadges(anime);
            const titleDisplay = resolveAnimeTitleDisplay(anime);
            return (
              <Panel key={anime.id} className="p-0">
                {anime.coverUrl && (
                  <img
                    alt={titleDisplay.title}
                    className="h-48 w-full rounded-t-lg object-cover"
                    src={anime.coverUrl}
                  />
                )}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{titleDisplay.title}</div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {titleDisplay.subtitle ?? "无别名"}
                      </div>
                    </div>
                    <Badge tone={followed ? "green" : "blue"}>{followed ? "已追番" : formatMonth(anime.premiereYear, anime.premiereMonth)}</Badge>
                  </div>
                  <p className="mt-3 line-clamp-3 min-h-16 text-sm leading-6 text-muted-foreground">
                    {anime.summary ?? "暂无简介"}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {anime.season && <Badge>{seasonText[anime.season]}</Badge>}
                    {titleDisplay.aliases.slice(0, 2).map((alias) => (
                      <Badge key={alias.id}>{alias.alias}</Badge>
                    ))}
                  </div>
                  {externalIds.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {externalIds.map((externalId) => (
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
                          <Badge
                            key={externalId.key}
                            title={`${externalId.label}: ${externalId.value}`}
                          >
                            {externalId.label} {externalId.value}
                          </Badge>
                        )
                      ))}
                    </div>
                  )}
                  <Button
                    className="mt-4 w-full"
                    variant={followed ? "secondary" : "outline"}
                    disabled={followed || addingAnimeId === anime.id}
                    onClick={() => void addToMyAnime(anime)}
                  >
                    <Plus className="h-4 w-4" />
                    {followed ? "已在我的追番" : addingAnimeId === anime.id ? "添加中" : "添加追番"}
                  </Button>
                </div>
              </Panel>
            );
          })}

          {items.length === 0 && (
            <div className="col-span-3 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              当前月份没有本地目录。点击采集按钮获取新番数据。
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const seasonText = {
  winter: "冬季",
  spring: "春季",
  summer: "夏季",
  fall: "秋季"
};

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

function getPreviousMonth(): { year: number; month: number } {
  const date = new Date();
  date.setMonth(date.getMonth() - 1);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1
  };
}

function buildMonthOptions(): Array<{ year: number; month: number }> {
  const now = new Date();
  return Array.from({ length: 18 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1
    };
  });
}

interface ExternalIdBadge {
  key: string;
  label: string;
  value: string;
  className: string;
  url?: string;
}

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

function getExternalIdRank(key: string): number {
  const index = externalIdOrder.indexOf(key);
  return index >= 0 ? index : externalIdOrder.length;
}

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
