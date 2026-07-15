import { CalendarDays, Check, ChevronDown, ChevronRight, Download, ImageOff, Link2, MoreHorizontal, Plus, RefreshCw, Save, Search, SlidersHorizontal, Star, Trash2, Unlink, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { appApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatBytes, formatMonth, formatPercent } from "@/lib/format";
import { buildAnimeReleaseSearchTerms } from "@shared/anime-release-search";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
import type { AddReleaseDownloadInput, AnimeSourceBindingState, AnimeSourceCandidate, EpisodeReleasePreview, ReleaseSearchResult, RssSubscriptionReleaseResult } from "@shared/contracts";
import type {
  AnimeRssSubscription,
  AnimeStatus,
  DownloadTask,
  Episode,
  EpisodePreference,
  EpisodeStatus,
  FansubGroup,
  MyAnime,
  NormalizedVideoCodec,
  Release,
  SubtitlePreference
} from "@shared/domain";

const statusText: Record<AnimeStatus, string> = {
  watching: "在追",
  planned: "想看",
  completed: "已完成",
  paused: "暂停",
  dropped: "已弃"
};

const statusOptions = Object.entries(statusText) as Array<[AnimeStatus, string]>;
const episodeStatusText: Record<EpisodeStatus, string> = {
  upcoming: "未开播",
  aired: "已开播",
  matched: "已匹配",
  downloading: "下载中",
  downloaded: "已下载",
  watched: "已观看"
};
const downloadStatusText: Record<DownloadTask["status"], string> = {
  queued: "排队中",
  fetching_metadata: "获取元数据",
  downloading: "下载中",
  stalled: "等待连接",
  paused: "已暂停",
  checking: "校验中",
  moving: "移动文件",
  completed: "已完成",
  seeding: "做种中",
  error: "错误",
  missing_files: "文件缺失"
};

const episodeStatusOptions = Object.entries(episodeStatusText) as Array<[EpisodeStatus, string]>;
const resolutionOptions = ["", "720p", "1080p", "2160p"];
const codecOptions: Array<"" | NormalizedVideoCodec> = ["", "H.264/AVC", "H.265/HEVC", "AV1", "VP9", "Unknown"];
const subtitleOptions: Array<"" | SubtitlePreference> = ["", "chs", "cht", "multi", "jpn", "eng"];
const subtitleText: Record<SubtitlePreference, string> = {
  chs: "简体",
  cht: "繁体",
  multi: "多语",
  jpn: "日语",
  eng: "英语"
};
const unknownFansubFilter = "__unknown__";
const batchAddingReleaseId = "__batch__";
type DownloadResourceTab = "rss" | "search";
type AnimeDownloadDetailFilter = "all" | "active" | "completed";

interface AnimeDownloadDetailState {
  item: MyAnime;
  filter: AnimeDownloadDetailFilter;
}

interface RssReleaseGroupState {
  subscription: AnimeRssSubscription;
  releases: Release[];
  errors: RssSubscriptionReleaseResult["errors"];
}

const downloadDetailFilters: Array<{ value: AnimeDownloadDetailFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "active", label: "下载中" },
  { value: "completed", label: "已完成" }
];
const releaseSearchCacheTtlMs = 24 * 60 * 60 * 1000;

export function MyAnimePage() {
  const [items, setItems] = useState<MyAnime[]>([]);
  const [fansubs, setFansubs] = useState<FansubGroup[]>([]);
  const [draft, setDraft] = useState<MyAnime | null>(null);
  const [downloadTarget, setDownloadTarget] = useState<MyAnime | null>(null);
  const [downloadDetail, setDownloadDetail] = useState<AnimeDownloadDetailState | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodePreferences, setEpisodePreferences] = useState<EpisodePreference[]>([]);
  const [downloadTasks, setDownloadTasks] = useState<DownloadTask[]>([]);
  const [releasePreviews, setReleasePreviews] = useState<Record<string, EpisodeReleasePreview>>({});
  const [animeReleases, setAnimeReleases] = useState<Release[]>([]);
  const [animeReleaseErrors, setAnimeReleaseErrors] = useState<ReleaseSearchResult["errors"]>([]);
  const [animeRssReleaseGroups, setAnimeRssReleaseGroups] = useState<RssReleaseGroupState[]>([]);
  const [animeRssReleaseLoading, setAnimeRssReleaseLoading] = useState(false);
  const [downloadResourceTab, setDownloadResourceTab] = useState<DownloadResourceTab>("rss");
  const [animeReleaseFansubId, setAnimeReleaseFansubId] = useState("");
  const [animeReleaseLoading, setAnimeReleaseLoading] = useState(false);
  const [sourceBindingState, setSourceBindingState] = useState<AnimeSourceBindingState | null>(null);
  const [sourceBindingLoading, setSourceBindingLoading] = useState(false);
  const [sourceBindingActionKey, setSourceBindingActionKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [episodeLoading, setEpisodeLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewingEpisodeId, setPreviewingEpisodeId] = useState<string | null>(null);
  const [addingReleaseId, setAddingReleaseId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let active = true;

    Promise.all([appApi.listMyAnime(), appApi.listFansubs(), appApi.listDownloads()])
      .then(([animeItems, groups, downloads]) => {
        if (!active) {
          return;
        }

        setItems(animeItems);
        setFansubs(groups);
        setDownloadTasks(downloads);
      })
      .catch((error) => {
        if (active) {
          setMessage({
            tone: "error",
            text: error instanceof Error ? error.message : "加载追番数据失败"
          });
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const fansubNames = useMemo(() => new Map(fansubs.map((group) => [group.id, group.name])), [fansubs]);
  const draftPersisted = Boolean(draft && items.some((item) => item.id === draft.id));

  useEffect(() => {
    if (!downloadTarget) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeAnimeDownloads();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [downloadTarget]);

  useEffect(() => {
    if (!downloadDetail) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeDownloadDetail();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [downloadDetail]);

  useEffect(() => {
    if (!draft) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDraft(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [draft]);

  useEffect(() => {
    let active = true;

    if (!draft?.anime.id || !draftPersisted) {
      setEpisodes([]);
      setEpisodePreferences([]);
      return;
    }

    setEpisodeLoading(true);
    Promise.all([appApi.listEpisodes(draft.anime.id), appApi.listEpisodePreferences(draft.anime.id), appApi.listDownloads()])
      .then(([loadedEpisodes, loadedPreferences, downloads]) => {
        if (!active) {
          return;
        }

        setEpisodes(loadedEpisodes);
        setEpisodePreferences(loadedPreferences);
        setDownloadTasks(downloads);
      })
      .catch((error) => {
        if (active) {
          setMessage({
            tone: "error",
            text: error instanceof Error ? error.message : "加载单集规则失败"
          });
        }
      })
      .finally(() => {
        if (active) {
          setEpisodeLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [draft?.anime.id, draftPersisted]);

  async function saveDraft() {
    if (!draft) {
      return;
    }

    if (!draft.anime.title.trim()) {
      setMessage({ tone: "error", text: "番剧名称不能为空" });
      return;
    }

    setSaving(true);
    try {
      const now = new Date().toISOString();
      const updated = await appApi.upsertMyAnime({
        ...draft,
        rssSubscriptions: normalizeRssSubscriptions(draft, now),
        anime: {
          ...draft.anime,
          title: draft.anime.title.trim(),
          originalTitle: draft.anime.originalTitle?.trim() || undefined,
          premiereYear: Number(draft.anime.premiereYear),
          premiereMonth: clampMonth(Number(draft.anime.premiereMonth))
        },
        addedAt: draft.addedAt || now,
        updatedAt: now
      });

      setItems(updated);
      setDraft(null);
      setMessage({ tone: "success", text: "追番规则已保存" });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "保存追番规则失败"
      });
    } finally {
      setSaving(false);
    }
  }

  async function removeItem(item: MyAnime) {
    const titleDisplay = resolveAnimeTitleDisplay(item.anime);
    const confirmed = window.confirm(`确认从我的追番移除「${titleDisplay.title}」？`);
    if (!confirmed) {
      return;
    }

    try {
      const updated = await appApi.removeMyAnime(item.id);
      setItems(updated);
      if (draft?.id === item.id) {
        setDraft(null);
      }
      if (downloadTarget?.id === item.id) {
        closeAnimeDownloads();
      }
      if (downloadDetail?.item.id === item.id) {
        closeDownloadDetail();
      }
      setMessage({ tone: "success", text: "已移除追番" });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "移除追番失败"
      });
    }
  }

  async function addNextEpisode() {
    if (!draft || !draftPersisted) {
      setMessage({ tone: "error", text: "请先保存追番，再添加单集" });
      return;
    }

    const nextEpisodeNo = Math.max(0, ...episodes.map((episode) => episode.episodeNo)) + 1;
    const now = new Date().toISOString();
    const episode: Episode = {
      id: createId("episode"),
      animeId: draft.anime.id,
      episodeNo: nextEpisodeNo,
      status: "upcoming",
      airTime: now
    };

    try {
      setEpisodes(await appApi.upsertEpisode(episode));
      setMessage({ tone: "success", text: `已添加第 ${nextEpisodeNo} 集` });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "添加单集失败"
      });
    }
  }

  async function updateEpisodeStatus(episode: Episode, status: EpisodeStatus) {
    try {
      setEpisodes(
        await appApi.upsertEpisode({
          ...episode,
          status
        })
      );
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "更新单集状态失败"
      });
    }
  }

  async function updateEpisodeFansub(episode: Episode, fansubGroupId: string) {
    try {
      if (!fansubGroupId) {
        setEpisodePreferences(await appApi.removeEpisodePreference(episode.id));
        clearEpisodePreview(episode.id);
        setMessage({ tone: "success", text: "已恢复跟随默认字幕组" });
        return;
      }

      const existing = episodePreferences.find((preference) => preference.episodeId === episode.id);
      setEpisodePreferences(
        await appApi.upsertEpisodePreference({
          id: existing?.id ?? createId("episode-pref"),
          animeId: episode.animeId,
          episodeId: episode.id,
          fansubGroupId,
          releaseId: existing?.releaseId,
          isManualOverride: true
        })
      );
      clearEpisodePreview(episode.id);
      setMessage({ tone: "success", text: "已切换单集字幕组，重新查看发布后会按新字幕组匹配" });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "更新单集字幕组失败"
      });
    }
  }

  async function previewEpisodeReleases(episode: Episode) {
    setPreviewingEpisodeId(episode.id);
    try {
      const preview = await appApi.previewEpisodeReleases(episode.animeId, episode.id);
      setReleasePreviews((current) => ({
        ...current,
        [episode.id]: preview
      }));
      setMessage({ tone: "success", text: `已找到 ${preview.candidates.length} 个候选资源` });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "匹配单集资源失败"
      });
    } finally {
      setPreviewingEpisodeId(null);
    }
  }

  function clearEpisodePreview(episodeId: string) {
    setReleasePreviews((current) => {
      const next = { ...current };
      delete next[episodeId];
      return next;
    });
  }

  async function openAnimeDownloads(item: MyAnime) {
    const target = cloneMyAnime(item);
    const nextTab: DownloadResourceTab = getEnabledRssSubscriptions(target).length > 0 ? "rss" : "search";
    setDraft(null);
    setDownloadTarget(target);
    setDownloadResourceTab(nextTab);
    setAnimeReleaseFansubId(target.defaultFansubGroupId ?? "");
    void refreshAnimeSourceBindings(target.anime.id);
    if (nextTab === "rss") {
      await searchAnimeRssReleases(target);
    } else {
      await searchAnimeReleases(target);
    }
  }

  function closeAnimeDownloads() {
    setDownloadTarget(null);
    setAnimeReleases([]);
    setAnimeReleaseErrors([]);
    setAnimeRssReleaseGroups([]);
    setAnimeReleaseFansubId("");
    setSourceBindingState(null);
    setSourceBindingActionKey(null);
  }

  /** 打开某部追番的下载任务明细抽屉。 */
  function openDownloadDetail(item: MyAnime, filter: AnimeDownloadDetailFilter) {
    setDownloadDetail({
      item: cloneMyAnime(item),
      filter
    });
  }

  function closeDownloadDetail() {
    setDownloadDetail(null);
  }

  /** 打开追番规则抽屉，并保留已采集的番剧元数据快照。 */
  function openRulesDrawer(item: MyAnime) {
    closeAnimeDownloads();
    closeDownloadDetail();
    setDraft(cloneMyAnime(item));
  }

  /** 查询某部追番的下载资源，默认使用 1 天缓存，强制刷新时绕过缓存。 */
  async function searchAnimeReleases(target = downloadTarget, options: { forceRefresh?: boolean } = {}) {
    if (!target) {
      return;
    }

    setAnimeReleaseLoading(true);
    try {
      const result = await appApi.searchAnimeReleases({
        animeId: target.anime.id,
        preferredResolution: target.preferredResolution,
        limit: 200,
        cacheTtlMs: releaseSearchCacheTtlMs,
        forceRefresh: options.forceRefresh
      });
      const releases = sortReleases(
        dedupeReleases(result.releases).map((release) => ({
          ...release,
          animeId: target.anime.id
        }))
      );
      const errors = dedupeReleaseErrors(result.errors);
      setAnimeReleases(releases);
      setAnimeReleaseErrors(errors);
      setMessage({
        tone: releases.length === 0 && errors.length > 0 ? "error" : "success",
        text:
          releases.length === 0 && errors.length > 0
            ? "下载源请求失败，未获取到可用资源"
            : `已找到 ${releases.length} 个资源`
      });
    } catch (error) {
      setAnimeReleases([]);
      setAnimeReleaseErrors([]);
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "查询发布资源失败"
      });
    } finally {
      setAnimeReleaseLoading(false);
    }
  }

  /** 读取精确来源绑定和待确认候选。 */
  async function refreshAnimeSourceBindings(animeId: string) {
    setSourceBindingLoading(true);
    try {
      setSourceBindingState(await appApi.getAnimeSourceBindingState(animeId, true));
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "读取来源匹配失败" });
    } finally {
      setSourceBindingLoading(false);
    }
  }

  /** 确认来源候选并重新读取精确资源。 */
  async function confirmAnimeSourceCandidate(candidate: AnimeSourceCandidate) {
    if (!downloadTarget) return;
    setSourceBindingActionKey(`${candidate.sourceId}:${candidate.sourceAnimeId}`);
    try {
      const state = await appApi.confirmAnimeSourceBinding({
        animeId: downloadTarget.anime.id,
        sourceId: candidate.sourceId,
        sourceAnimeId: candidate.sourceAnimeId,
        sourceAnimeTitle: candidate.title,
        sourceUrl: candidate.sourceUrl,
        confidence: candidate.score / 100
      });
      setSourceBindingState(state);
      await searchAnimeReleases(downloadTarget, { forceRefresh: true });
      setMessage({ tone: "success", text: `已绑定 ${candidate.sourceName}：${candidate.title}` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "确认来源匹配失败" });
    } finally {
      setSourceBindingActionKey(null);
    }
  }

  /** 移除来源绑定并重新发现候选。 */
  async function removeAnimeSourceBinding(sourceId: string) {
    if (!downloadTarget) return;
    setSourceBindingActionKey(sourceId);
    try {
      setSourceBindingState(await appApi.removeAnimeSourceBinding(downloadTarget.anime.id, sourceId));
      setAnimeReleases((current) => current.filter((release) => release.sourceId !== sourceId));
      setMessage({ tone: "success", text: "已移除来源绑定，请重新确认候选" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "移除来源绑定失败" });
    } finally {
      setSourceBindingActionKey(null);
    }
  }

  /** 查询某部追番已配置的 RSS 订阅资源。 */
  async function searchAnimeRssReleases(target = downloadTarget) {
    if (!target) {
      return;
    }

    const subscriptions = getEnabledRssSubscriptions(target);
    if (subscriptions.length === 0) {
      setAnimeRssReleaseGroups([]);
      setMessage({ tone: "error", text: "请先在规则中配置启用的 RSS 订阅" });
      return;
    }

    setAnimeRssReleaseLoading(true);
    try {
      const results = await Promise.all(
        subscriptions.map((subscription) =>
          appApi.searchRssSubscriptionReleases({
            animeId: target.anime.id,
            subscriptionId: subscription.id,
            preferredResolution: target.preferredResolution,
            limit: 200
          })
        )
      );
      const groups = results.map((result, index) => ({
        subscription: subscriptions.find((subscription) => subscription.id === result.query.subscriptionId) ?? subscriptions[index],
        releases: sortReleases(
          dedupeReleases(result.releases).map((release) => ({
            ...release,
            animeId: target.anime.id
          }))
        ),
        errors: result.errors
      }));
      const releaseCount = groups.reduce((sum, group) => sum + group.releases.length, 0);
      const errorCount = groups.reduce((sum, group) => sum + group.errors.length, 0);
      setAnimeRssReleaseGroups(groups);
      setMessage({
        tone: releaseCount === 0 && errorCount > 0 ? "error" : "success",
        text:
          releaseCount === 0 && errorCount > 0
            ? "RSS 订阅请求失败，未获取到可用资源"
            : `RSS 已找到 ${releaseCount} 个资源`
      });
    } catch (error) {
      setAnimeRssReleaseGroups([]);
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "查询 RSS 订阅资源失败"
      });
    } finally {
      setAnimeRssReleaseLoading(false);
    }
  }

  async function addEpisodeReleaseDownload(episode: Episode, release: Release) {
    setAddingReleaseId(release.id);
    try {
      const preference = episodePreferences.find((item) => item.episodeId === episode.id);
      const updatedDownloads = await appApi.addReleaseDownload({
        release,
        animeId: episode.animeId,
        episodeId: episode.id,
        episodeNo: episode.episodeNo,
        fansubGroupId: preference?.fansubGroupId ?? release.fansubGroupId ?? draft?.defaultFansubGroupId
      });
      const [updatedEpisodes, updatedPreferences] = await Promise.all([
        appApi.listEpisodes(episode.animeId),
        appApi.listEpisodePreferences(episode.animeId)
      ]);
      setDownloadTasks(updatedDownloads);
      setEpisodes(updatedEpisodes);
      setEpisodePreferences(updatedPreferences);
      setMessage({ tone: "success", text: "已添加到下载队列" });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "添加下载失败"
      });
    } finally {
      setAddingReleaseId(null);
    }
  }

  async function addAnimeReleaseDownload(release: Release) {
    if (!downloadTarget) {
      return;
    }

    setAddingReleaseId(release.id);
    try {
      const updatedDownloads = await appApi.addReleaseDownload(
        buildAnimeReleaseDownloadInput(release, downloadTarget, animeReleaseFansubId)
      );
      setDownloadTasks(updatedDownloads);
      setMessage({ tone: "success", text: "已添加到下载队列" });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "添加下载失败"
      });
    } finally {
      setAddingReleaseId(null);
    }
  }

  /** 批量添加当前追番的多个资源下载。 */
  async function addAnimeReleaseDownloads(releases: Release[]) {
    if (!downloadTarget || releases.length === 0) {
      return;
    }

    const linkedTasks = downloadTasks.filter((task) => task.animeId === downloadTarget.anime.id);
    const candidates = dedupeReleases(releases).filter((release) => {
      const canDownload = Boolean(release.magnetUrl ?? release.torrentUrl);
      return canDownload && !findReleaseDownloadTask(linkedTasks, release);
    });
    if (candidates.length === 0) {
      setMessage({ tone: "error", text: "选中的资源都已加入或没有可下载地址" });
      return;
    }

    setAddingReleaseId(batchAddingReleaseId);
    let latestDownloads = downloadTasks;
    let successCount = 0;
    const failed: string[] = [];
    for (const release of candidates) {
      try {
        latestDownloads = await appApi.addReleaseDownload(
          buildAnimeReleaseDownloadInput(release, downloadTarget, animeReleaseFansubId)
        );
        successCount += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "添加下载失败";
        failed.push(`${release.title}: ${reason}`);
      }
    }

    setDownloadTasks(latestDownloads);
    setAddingReleaseId(null);
    setMessage({
      tone: failed.length > 0 ? "error" : "success",
      text: failed.length > 0
        ? `批量下载完成：成功 ${successCount} 个，失败 ${failed.length} 个`
        : `已批量添加 ${successCount} 个下载任务`
    });
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">正在加载追番列表...</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">我的追番</h1>
          <p className="mt-1 text-sm text-muted-foreground">按首播年月管理，默认字幕组会用于自动下载。</p>
        </div>
        <Button
          onClick={() => {
            closeAnimeDownloads();
            setDraft(createEmptyDraft());
          }}
        >
          <Plus className="h-4 w-4" />
          添加追番
        </Button>
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

      {items.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
          {items.map((item) => (
            <MyAnimeCard
              key={item.id}
              item={item}
              defaultFansubName={fansubNames.get(item.defaultFansubGroupId ?? "") ?? "未设置"}
              downloadSummary={summarizeAnimeDownloads(downloadTasks, item.anime.id)}
              onOpenActive={() => openDownloadDetail(item, "active")}
              onOpenCompleted={() => openDownloadDetail(item, "completed")}
              onOpenDownloads={() => void openAnimeDownloads(item)}
              onOpenRules={() => openRulesDrawer(item)}
              onRemove={() => void removeItem(item)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          当前还没有追番。
        </div>
      )}

      {draft && (
        <RulesDrawer
          addingReleaseId={addingReleaseId}
          draft={draft}
          downloadTasks={downloadTasks}
          draftPersisted={draftPersisted}
          episodeLoading={episodeLoading}
          episodePreferences={episodePreferences}
          episodes={episodes}
          fansubNames={fansubNames}
          fansubs={fansubs}
          previewingEpisodeId={previewingEpisodeId}
          releasePreviews={releasePreviews}
          saving={saving}
          onAddEpisode={() => void addNextEpisode()}
          onAddRelease={(episode, release) => void addEpisodeReleaseDownload(episode, release)}
          onCancel={() => setDraft(null)}
          onChange={setDraft}
          onFansubChange={(episode, fansubGroupId) => void updateEpisodeFansub(episode, fansubGroupId)}
          onPreviewReleases={(episode) => void previewEpisodeReleases(episode)}
          onSave={() => void saveDraft()}
          onStatusChange={(episode, status) => void updateEpisodeStatus(episode, status)}
        />
      )}

      {downloadTarget && (
        <Drawer
          ariaLabel="资源下载"
          className="max-w-5xl overflow-hidden"
          onClose={closeAnimeDownloads}
        >
          <AnimeDownloadPanel
            addingReleaseId={addingReleaseId}
            activeTab={downloadResourceTab}
            batchAdding={addingReleaseId === batchAddingReleaseId}
            downloadTasks={downloadTasks}
            errors={animeReleaseErrors}
            fansubNames={fansubNames}
            fansubs={fansubs}
            listClassName="max-h-[calc(100vh-22rem)] overflow-y-auto pr-1"
            loading={animeReleaseLoading}
            panelClassName="h-full overflow-hidden rounded-none border-0 shadow-none"
            releases={animeReleases}
            rssGroups={animeRssReleaseGroups}
            rssLoading={animeRssReleaseLoading}
            selectedFansubId={animeReleaseFansubId}
            sourceBindingActionKey={sourceBindingActionKey}
            sourceBindingLoading={sourceBindingLoading}
            sourceBindingState={sourceBindingState}
            target={downloadTarget}
            onAddRelease={(release) => void addAnimeReleaseDownload(release)}
            onAddSelected={(releases) => void addAnimeReleaseDownloads(releases)}
            onClose={closeAnimeDownloads}
            onFansubChange={setAnimeReleaseFansubId}
            onConfirmSourceCandidate={(candidate) => void confirmAnimeSourceCandidate(candidate)}
            onRemoveSourceBinding={(sourceId) => void removeAnimeSourceBinding(sourceId)}
            onRefreshSourceBindings={() => void refreshAnimeSourceBindings(downloadTarget.anime.id)}
            onRefreshRss={() => void searchAnimeRssReleases(downloadTarget)}
            onRefresh={() => void searchAnimeReleases()}
            onForceRefresh={() => void searchAnimeReleases(downloadTarget, { forceRefresh: true })}
            onTabChange={(tab) => {
              setDownloadResourceTab(tab);
              if (tab === "rss" && animeRssReleaseGroups.length === 0 && !animeRssReleaseLoading) {
                void searchAnimeRssReleases(downloadTarget);
              }
              if (tab === "search" && animeReleases.length === 0 && !animeReleaseLoading) {
                void searchAnimeReleases(downloadTarget);
              }
            }}
          />
        </Drawer>
      )}

      {downloadDetail && (
        <AnimeDownloadDetailDrawer
          detail={downloadDetail}
          downloadTasks={downloadTasks}
          fansubNames={fansubNames}
          onClose={closeDownloadDetail}
          onFilterChange={(filter) =>
            setDownloadDetail((current) => (current ? { ...current, filter } : current))
          }
        />
      )}

    </div>
  );
}

/** 渲染我的追番卡片，并承载右上角快捷操作入口。 */
function MyAnimeCard({
  item,
  defaultFansubName,
  downloadSummary,
  onOpenActive,
  onOpenCompleted,
  onOpenDownloads,
  onOpenRules,
  onRemove
}: {
  item: MyAnime;
  defaultFansubName: string;
  downloadSummary: ReturnType<typeof summarizeAnimeDownloads>;
  onOpenActive: () => void;
  onOpenCompleted: () => void;
  onOpenDownloads: () => void;
  onOpenRules: () => void;
  onRemove: () => void;
}) {
  const titleDisplay = resolveAnimeTitleDisplay(item.anime);
  const ratingText = item.anime.rating ? item.anime.rating.score.toFixed(1) : "暂无";

  return (
    <article className="relative overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow hover:shadow-md focus-within:shadow-md">
      <div className="relative aspect-[16/9] bg-muted">
        {item.anime.coverUrl ? (
          <img
            alt={titleDisplay.title}
            className="h-full w-full object-cover"
            loading="lazy"
            src={item.anime.coverUrl}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageOff className="h-8 w-8" />
          </div>
        )}

        <div className="absolute left-3 top-3 inline-flex h-7 items-center gap-1 rounded-md border border-amber-200 bg-amber-50/95 px-2 text-xs font-medium text-amber-700 shadow-sm">
          <Star className="h-3.5 w-3.5" />
          {ratingText}
        </div>

        <div className="group/actions absolute right-3 top-3 z-10 flex justify-end">
          <button
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background/95 text-muted-foreground shadow-sm"
            type="button"
            aria-label="显示操作"
            title="显示操作"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          <div className="pointer-events-none absolute right-0 top-10 w-28 translate-y-1 rounded-md border bg-background/95 p-1 opacity-0 shadow-lg transition-all group-hover/actions:pointer-events-auto group-hover/actions:translate-y-0 group-hover/actions:opacity-100 group-focus-within/actions:pointer-events-auto group-focus-within/actions:translate-y-0 group-focus-within/actions:opacity-100">
            <CardActionButton label="下载资源" onClick={onOpenDownloads} />
            <CardActionButton label="规则" onClick={onOpenRules} />
            <button
              className="flex h-8 w-full items-center rounded px-2 text-left text-xs font-medium text-rose-700 hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-200"
              type="button"
              onClick={onRemove}
            >
              删除
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3 p-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold" title={titleDisplay.title}>
            {titleDisplay.title}
          </h2>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={titleDisplay.subtitle ?? "无原名"}>
            {titleDisplay.subtitle ?? "无原名"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="h-3.5 w-3.5" />
            {formatMonth(item.anime.premiereYear, item.anime.premiereMonth)}
          </span>
          <Badge>{statusText[item.status]}</Badge>
          <Badge tone={item.autoDownload ? "green" : "neutral"}>{item.autoDownload ? "自动" : "手动"}</Badge>
        </div>

        <p className="line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground" title={item.anime.summary ?? "暂无简介"}>
          {item.anime.summary ?? "暂无简介"}
        </p>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <CardMetric
            label="已完成"
            value={downloadSummary.completed}
            tone="green"
            onClick={onOpenCompleted}
          />
          <CardMetric
            label="下载中"
            value={downloadSummary.active}
            tone="blue"
            onClick={onOpenActive}
          />
          <CardMetric label="关联集" value={downloadSummary.linked} />
        </div>

        <div className="flex min-w-0 flex-wrap gap-2">
          <Badge className="max-w-full truncate" title={defaultFansubName}>
            {defaultFansubName}
          </Badge>
          {item.preferredResolution && <Badge>{item.preferredResolution}</Badge>}
          {item.preferredCodec && <Badge tone="blue">{item.preferredCodec}</Badge>}
        </div>
      </div>
    </article>
  );
}

/** 渲染卡片悬停菜单中的单个操作按钮。 */
function CardActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="flex h-8 w-full items-center rounded px-2 text-left text-xs font-medium text-foreground hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary/25"
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** 渲染卡片内的下载统计指标。 */
function CardMetric({
  label,
  value,
  tone = "neutral",
  onClick
}: {
  label: string;
  value: number;
  tone?: "neutral" | "green" | "blue";
  onClick?: () => void;
}) {
  const toneClassName =
    tone === "green" ? "text-emerald-700" : tone === "blue" ? "text-cyan-700" : "text-foreground";
  const content = (
    <>
      <div className={cn("text-sm font-semibold tabular-nums", toneClassName)}>{value}</div>
      <div className="mt-0.5 truncate text-muted-foreground">{label}</div>
    </>
  );

  if (onClick) {
    return (
      <button
        aria-label={`查看${label}任务，共 ${value} 集`}
        className="rounded-md bg-muted/60 px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        title={`查看${label}任务`}
        type="button"
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return (
    <div className="rounded-md bg-muted/60 px-2 py-1.5">
      {content}
    </div>
  );
}

/** 渲染追番规则和单集规则的右侧抽屉。 */
function RulesDrawer({
  draft,
  fansubs,
  saving,
  draftPersisted,
  episodes,
  episodePreferences,
  downloadTasks,
  releasePreviews,
  fansubNames,
  episodeLoading,
  previewingEpisodeId,
  addingReleaseId,
  onChange,
  onCancel,
  onSave,
  onAddEpisode,
  onStatusChange,
  onFansubChange,
  onPreviewReleases,
  onAddRelease
}: {
  draft: MyAnime;
  fansubs: FansubGroup[];
  saving: boolean;
  draftPersisted: boolean;
  episodes: Episode[];
  episodePreferences: EpisodePreference[];
  downloadTasks: DownloadTask[];
  releasePreviews: Record<string, EpisodeReleasePreview>;
  fansubNames: Map<string, string>;
  episodeLoading: boolean;
  previewingEpisodeId: string | null;
  addingReleaseId: string | null;
  onChange: (item: MyAnime | null) => void;
  onCancel: () => void;
  onSave: () => void;
  onAddEpisode: () => void;
  onStatusChange: (episode: Episode, status: EpisodeStatus) => void;
  onFansubChange: (episode: Episode, fansubGroupId: string) => void;
  onPreviewReleases: (episode: Episode) => void;
  onAddRelease: (episode: Episode, release: Release) => void;
}) {
  return (
    <Drawer
      ariaLabel="追番规则"
      className="max-w-3xl overflow-y-auto bg-background p-4"
      onClose={onCancel}
    >
      <div className="space-y-4">
        <RulesPanel
          draft={draft}
          fansubs={fansubs}
          saving={saving}
          onChange={onChange}
          onCancel={onCancel}
          onSave={onSave}
        />
        <EpisodeRulesPanel
          draft={draft}
          persisted={draftPersisted}
          episodes={episodes}
          episodePreferences={episodePreferences}
          downloadTasks={downloadTasks}
          releasePreviews={releasePreviews}
          fansubs={fansubs}
          fansubNames={fansubNames}
          loading={episodeLoading}
          previewingEpisodeId={previewingEpisodeId}
          addingReleaseId={addingReleaseId}
          onAddEpisode={onAddEpisode}
          onStatusChange={onStatusChange}
          onFansubChange={onFansubChange}
          onPreviewReleases={onPreviewReleases}
          onAddRelease={onAddRelease}
        />
      </div>
    </Drawer>
  );
}

function AnimeDownloadDetailDrawer({
  detail,
  downloadTasks,
  fansubNames,
  onFilterChange,
  onClose
}: {
  detail: AnimeDownloadDetailState;
  downloadTasks: DownloadTask[];
  fansubNames: Map<string, string>;
  onFilterChange: (filter: AnimeDownloadDetailFilter) => void;
  onClose: () => void;
}) {
  const titleDisplay = resolveAnimeTitleDisplay(detail.item.anime);
  const animeTasks = getAnimeDownloadTasks(downloadTasks, detail.item.anime.id);
  const visibleTasks = filterAnimeDownloadDetailTasks(animeTasks, detail.filter);
  const counts = {
    all: animeTasks.length,
    active: animeTasks.filter(isActiveDownload).length,
    completed: animeTasks.filter(isCompletedDownload).length
  };

  return (
    <Drawer
      ariaLabel="下载明细"
      className="flex max-w-2xl flex-col"
      onClose={onClose}
    >
      <div className="flex items-start justify-between gap-4 border-b p-5">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-normal">{titleDisplay.title}</h2>
          <p className="mt-1 truncate text-sm text-muted-foreground">{titleDisplay.subtitle ?? "下载任务明细"}</p>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="关闭下载明细" title="关闭下载明细">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="border-b p-4">
        <div className="grid h-9 grid-cols-3 overflow-hidden rounded-md border bg-background" role="group" aria-label="筛选下载任务">
          {downloadDetailFilters.map((filter) => (
            <button
              key={filter.value}
              aria-pressed={detail.filter === filter.value}
              className={[
                "border-r px-3 text-sm transition-colors last:border-r-0",
                detail.filter === filter.value
                  ? "bg-primary font-medium text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              ].join(" ")}
              type="button"
              onClick={() => onFilterChange(filter.value)}
            >
              {filter.label} {counts[filter.value]}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {visibleTasks.length > 0 ? (
          <div className="space-y-3">
            {visibleTasks.map((task) => (
              <DownloadDetailTaskCard key={task.id} task={task} fansubNames={fansubNames} />
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            当前筛选下没有下载任务。
          </div>
        )}
      </div>
    </Drawer>
  );
}

function DownloadDetailTaskCard({
  task,
  fansubNames
}: {
  task: DownloadTask;
  fansubNames: Map<string, string>;
}) {
  const fansubName = task.fansubName ?? (task.fansubGroupId ? fansubNames.get(task.fansubGroupId) : undefined) ?? "未识别字幕组";

  return (
    <article className="rounded-md border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {task.episodeNo !== undefined && <Badge tone="blue">第 {task.episodeNo} 集</Badge>}
            <Badge tone={getDownloadStatusTone(task.status)}>{downloadStatusText[task.status]}</Badge>
            <Badge>{fansubName}</Badge>
          </div>
          <h3 className="mt-2 truncate text-sm font-medium" title={task.name}>
            {task.name}
          </h3>
        </div>
        <div className="shrink-0 text-sm font-medium tabular-nums">{formatPercent(task.progress)}</div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${getProgressWidth(task.progress)}%` }} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <DownloadDetailMeta label="保存路径" value={task.savePath} className="col-span-2" />
        <DownloadDetailMeta label="创建时间" value={formatDateTime(task.createdAt)} />
        <DownloadDetailMeta label="完成时间" value={task.completedAt ? formatDateTime(task.completedAt) : "未完成"} />
        <DownloadDetailMeta label="下载速度" value={formatSpeedText(task.downloadSpeed)} />
        <DownloadDetailMeta label="上传速度" value={formatSpeedText(task.uploadSpeed)} />
      </dl>
    </article>
  );
}

function DownloadDetailMeta({
  label,
  value,
  className
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}

function RulesPanel({
  draft,
  fansubs,
  saving,
  onChange,
  onCancel,
  onSave
}: {
  draft: MyAnime | null;
  fansubs: FansubGroup[];
  saving: boolean;
  onChange: (item: MyAnime | null) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (!draft) {
    return (
      <Panel title="追番规则">
        <div className="rounded-md border border-dashed p-6 text-sm leading-6 text-muted-foreground">
          选择一部番剧编辑规则，或添加新的追番。
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="追番规则"
      action={
        <Button variant="ghost" onClick={onCancel} aria-label="关闭编辑" title="关闭编辑">
          <X className="h-4 w-4" />
        </Button>
      }
    >
      <div className="space-y-4">
        <TextField
          label="番剧名称"
          value={draft.anime.title}
          onChange={(value) =>
            onChange({
              ...draft,
              anime: {
                ...draft.anime,
                title: value
              }
            })
          }
        />
        <TextField
          label="原语言标题"
          value={draft.anime.originalTitle ?? ""}
          onChange={(value) =>
            onChange({
              ...draft,
              anime: {
                ...draft.anime,
                originalTitle: value
              }
            })
          }
        />
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="首播年份"
            value={draft.anime.premiereYear}
            min={1970}
            onChange={(value) =>
              onChange({
                ...draft,
                anime: {
                  ...draft.anime,
                  premiereYear: value
                }
              })
            }
          />
          <NumberField
            label="首播月份"
            value={draft.anime.premiereMonth}
            min={1}
            max={12}
            onChange={(value) =>
              onChange({
                ...draft,
                anime: {
                  ...draft.anime,
                  premiereMonth: clampMonth(value)
                }
              })
            }
          />
        </div>
        <TextareaField
          label="搜索别名"
          value={draft.anime.aliases.map((alias) => alias.alias).join("\n")}
          onChange={(value) =>
            onChange({
              ...draft,
              anime: {
                ...draft.anime,
                aliases: value
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean)
                  .map((alias, index) => ({
                    id: `${draft.anime.id}-alias-${index + 1}`,
                    animeId: draft.anime.id,
                    alias,
                    language: "custom",
                    priority: 50 - index
                  }))
              }
            })
          }
        />
        <SelectField
          label="状态"
          value={draft.status}
          options={statusOptions.map(([value, label]) => ({ value, label }))}
          onChange={(value) =>
            onChange({
              ...draft,
              status: value as AnimeStatus
            })
          }
        />
        <SelectField
          label="默认字幕组"
          value={draft.defaultFansubGroupId ?? ""}
          options={[
            { value: "", label: "未设置" },
            ...fansubs.map((group) => ({
              value: group.id,
              label: group.name
            }))
          ]}
          onChange={(value) =>
            onChange({
              ...draft,
              defaultFansubGroupId: value || undefined
            })
          }
        />
        <SelectField
          label="自动下载"
          value={draft.autoDownload ? "on" : "off"}
          options={[
            { value: "on", label: "开启" },
            { value: "off", label: "关闭" }
          ]}
          onChange={(value) =>
            onChange({
              ...draft,
              autoDownload: value === "on"
            })
          }
        />
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="偏好分辨率"
            value={draft.preferredResolution ?? ""}
            options={resolutionOptions.map((value) => ({
              value,
              label: value || "不限"
            }))}
            onChange={(value) =>
              onChange({
                ...draft,
                preferredResolution: (value || undefined) as MyAnime["preferredResolution"]
              })
            }
          />
          <SelectField
            label="偏好字幕"
            value={draft.preferredSubtitle ?? ""}
            options={subtitleOptions.map((value) => ({
              value,
              label: value || "不限"
            }))}
            onChange={(value) =>
              onChange({
                ...draft,
                preferredSubtitle: (value || undefined) as MyAnime["preferredSubtitle"]
              })
            }
          />
        </div>
        <SelectField
          label="偏好编码"
          value={draft.preferredCodec ?? ""}
          options={codecOptions.map((value) => ({
            value,
            label: value || "不限"
          }))}
          onChange={(value) =>
            onChange({
              ...draft,
              preferredCodec: (value || undefined) as MyAnime["preferredCodec"]
            })
          }
        />
        <TextField
          label="下载目录覆盖"
          value={draft.downloadDir ?? ""}
          onChange={(value) =>
            onChange({
              ...draft,
              downloadDir: value || undefined
            })
          }
        />
        <RssSubscriptionsEditor draft={draft} onChange={onChange} />
        <Button className="w-full" onClick={onSave} disabled={saving}>
          <Save className="h-4 w-4" />
          {saving ? "保存中" : "保存规则"}
        </Button>
      </div>
    </Panel>
  );
}

function RssSubscriptionsEditor({
  draft,
  onChange
}: {
  draft: MyAnime;
  onChange: (item: MyAnime | null) => void;
}) {
  const subscriptions = draft.rssSubscriptions ?? [];
  const mikanRssUrl = buildMikanRssUrl(draft);

  /** 更新追番草稿中的 RSS 订阅数组。 */
  function updateSubscriptions(next: AnimeRssSubscription[]) {
    onChange({
      ...draft,
      rssSubscriptions: next
    });
  }

  /** 新增一条空 RSS 订阅。 */
  function addSubscription(initial?: Partial<AnimeRssSubscription>) {
    const now = new Date().toISOString();
    updateSubscriptions([
      ...subscriptions,
      {
        id: createId("rss"),
        myAnimeId: draft.id,
        name: initial?.name ?? "RSS订阅",
        url: initial?.url ?? "",
        enabled: initial?.enabled ?? true,
        createdAt: now,
        updatedAt: now
      }
    ]);
  }

  /** 更新单条 RSS 订阅。 */
  function updateSubscription(id: string, patch: Partial<AnimeRssSubscription>) {
    const now = new Date().toISOString();
    updateSubscriptions(
      subscriptions.map((subscription) =>
        subscription.id === id
          ? {
              ...subscription,
              ...patch,
              updatedAt: now
            }
          : subscription
      )
    );
  }

  /** 删除单条 RSS 订阅。 */
  function removeSubscription(id: string) {
    updateSubscriptions(subscriptions.filter((subscription) => subscription.id !== id));
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">RSS订阅</div>
          <div className="mt-1 text-xs text-muted-foreground">可为同一番剧配置多个 RSS 源。</div>
        </div>
        <div className="flex shrink-0 gap-2">
          {mikanRssUrl && (
            <Button
              variant="outline"
              onClick={() => addSubscription({ name: "蜜柑计划", url: mikanRssUrl })}
              disabled={subscriptions.some((subscription) => subscription.url === mikanRssUrl)}
            >
              蜜柑RSS
            </Button>
          )}
          <Button variant="outline" onClick={() => addSubscription()}>
            <Plus className="h-4 w-4" />
            添加
          </Button>
        </div>
      </div>

      {subscriptions.length > 0 ? (
        <div className="space-y-3">
          {subscriptions.map((subscription) => (
            <div key={subscription.id} className="grid grid-cols-[auto_minmax(0,0.8fr)_minmax(0,1.4fr)_auto] items-center gap-2 rounded-md bg-muted/40 p-2">
              <label className="flex items-center justify-center" title="启用订阅">
                <input
                  checked={subscription.enabled}
                  className="h-4 w-4"
                  type="checkbox"
                  onChange={(event) => updateSubscription(subscription.id, { enabled: event.target.checked })}
                />
              </label>
              <input
                className="h-9 min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
                placeholder="订阅名称"
                value={subscription.name}
                onChange={(event) => updateSubscription(subscription.id, { name: event.target.value })}
              />
              <input
                className="h-9 min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
                placeholder="RSS 地址"
                title={subscription.url}
                value={subscription.url}
                onChange={(event) => updateSubscription(subscription.id, { url: event.target.value })}
              />
              <Button variant="ghost" onClick={() => removeSubscription(subscription.id)} aria-label="删除RSS订阅" title="删除RSS订阅">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          未配置 RSS 订阅。
        </div>
      )}
    </div>
  );
}

function AnimeDownloadPanel({
  target,
  releases,
  rssGroups,
  errors,
  downloadTasks,
  fansubs,
  fansubNames,
  activeTab,
  selectedFansubId,
  loading,
  rssLoading,
  addingReleaseId,
  batchAdding,
  sourceBindingState,
  sourceBindingLoading,
  sourceBindingActionKey,
  panelClassName,
  listClassName,
  onTabChange,
  onConfirmSourceCandidate,
  onRemoveSourceBinding,
  onRefreshSourceBindings,
  onFansubChange,
  onRefreshRss,
  onRefresh,
  onForceRefresh,
  onAddRelease,
  onAddSelected,
  onClose
}: {
  target: MyAnime;
  releases: Release[];
  rssGroups: RssReleaseGroupState[];
  errors: ReleaseSearchResult["errors"];
  downloadTasks: DownloadTask[];
  fansubs: FansubGroup[];
  fansubNames: Map<string, string>;
  activeTab: DownloadResourceTab;
  selectedFansubId: string;
  loading: boolean;
  rssLoading: boolean;
  addingReleaseId: string | null;
  batchAdding: boolean;
  sourceBindingState: AnimeSourceBindingState | null;
  sourceBindingLoading: boolean;
  sourceBindingActionKey: string | null;
  panelClassName?: string;
  listClassName?: string;
  onTabChange: (tab: DownloadResourceTab) => void;
  onConfirmSourceCandidate: (candidate: AnimeSourceCandidate) => void;
  onRemoveSourceBinding: (sourceId: string) => void;
  onRefreshSourceBindings: () => void;
  onFansubChange: (fansubGroupId: string) => void;
  onRefreshRss: () => void;
  onRefresh: () => void;
  onForceRefresh: () => void;
  onAddRelease: (release: Release) => void;
  onAddSelected: (releases: Release[]) => void;
  onClose: () => void;
}) {
  const titleDisplay = resolveAnimeTitleDisplay(target.anime);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set());
  const [selectedReleaseKeys, setSelectedReleaseKeys] = useState<Set<string>>(() => new Set());
  const rssReleases = rssGroups.flatMap((group) => group.releases);
  const tabReleases = activeTab === "rss" ? rssReleases : releases;
  const visibleReleases = filterReleasesByFansub(tabReleases, selectedFansubId);
  const releaseGroups = groupReleasesByFansub(visibleReleases, fansubNames);
  const visibleErrors = activeTab === "rss"
    ? dedupeReleaseErrors(rssGroups.flatMap((group) => group.errors))
    : dedupeReleaseErrors(errors);
  const unknownFansubCount = tabReleases.filter((release) => !release.fansubGroupId).length;
  const activeLoading = activeTab === "rss" ? rssLoading : loading;
  const sourceFailed = tabReleases.length === 0 && visibleErrors.length > 0;
  const linkedTasks = downloadTasks.filter((task) => task.animeId === target.anime.id);
  const releaseSignature = tabReleases.map(releaseKey).join("|");
  const linkedEpisodeCount = new Set(linkedTasks.map((task) => task.episodeNo).filter((value) => value !== undefined)).size;
  const completedEpisodeCount = new Set(
    linkedTasks
      .filter((task) => task.status === "completed" || task.status === "seeding")
      .map((task) => task.episodeNo)
      .filter((value) => value !== undefined)
  ).size;
  const selectedReleases = visibleReleases.filter((release) => selectedReleaseKeys.has(releaseKey(release)));
  const selectedDownloadableReleases = selectedReleases.filter((release) => isReleaseSelectable(release, linkedTasks));
  const selectableVisibleReleases = visibleReleases.filter((release) => isReleaseSelectable(release, linkedTasks));

  useEffect(() => {
    setSelectedReleaseKeys(new Set());
  }, [activeTab, releaseSignature]);

  /** 切换字幕组资源分组的折叠状态。 */
  function toggleGroup(groupKey: string) {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }

  /** 切换某个资源的批量选择状态。 */
  function toggleReleaseSelection(release: Release) {
    const key = releaseKey(release);
    setSelectedReleaseKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  /** 选择或取消当前筛选下所有可下载资源。 */
  function toggleAllVisibleReleases() {
    setSelectedReleaseKeys((current) => {
      const next = new Set(current);
      const selectableKeys = selectableVisibleReleases.map(releaseKey);
      const allSelected = selectableKeys.length > 0 && selectableKeys.every((key) => next.has(key));
      for (const key of selectableKeys) {
        if (allSelected) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      return next;
    });
  }

  function renderEpisodeGroups(groupReleases: Release[]) {
    return groupReleaseEpisodes(groupReleases).map((episodeGroup) => (
      <section key={episodeGroup.key}>
        <div className="flex items-center justify-between bg-muted/30 px-3 py-2 text-xs">
          <span className="font-medium" title={episodeGroup.label}>
            {episodeGroup.label}
          </span>
          <span className="text-muted-foreground">{episodeGroup.releases.length} 个版本</span>
        </div>
        <div className="divide-y border-t">
          {episodeGroup.releases.map((release) => {
            const linkedTask = findReleaseDownloadTask(linkedTasks, release);
            return (
              <ReleaseDownloadRow
                key={releaseKey(release)}
                addingReleaseId={addingReleaseId}
                fansubNames={fansubNames}
                linkedTask={linkedTask}
                release={release}
                selected={selectedReleaseKeys.has(releaseKey(release))}
                onAddRelease={onAddRelease}
                onToggleSelected={toggleReleaseSelection}
              />
            );
          })}
        </div>
      </section>
    ));
  }

  return (
    <Panel
      className={cn("flex flex-col", panelClassName)}
      title="资源下载"
      action={
        <Button variant="ghost" onClick={onClose} aria-label="关闭下载" title="关闭下载">
          <X className="h-4 w-4" />
        </Button>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="truncate text-sm font-medium" title={titleDisplay.title}>
            {titleDisplay.title}
          </div>
          {titleDisplay.subtitle && (
            <div className="mt-1 truncate text-xs text-muted-foreground" title={titleDisplay.subtitle}>
              {titleDisplay.subtitle}
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3 border-y py-3">
          <DownloadMetric label="已关联集数" value={linkedEpisodeCount} />
          <DownloadMetric label="已完成" value={completedEpisodeCount} />
          <DownloadMetric label="下载任务" value={linkedTasks.length} />
        </div>

        <div className="grid h-9 grid-cols-2 overflow-hidden rounded-md border bg-background" role="tablist" aria-label="资源获取方式">
          <button
            aria-selected={activeTab === "rss"}
            className={cn(
              "border-r px-3 text-sm transition-colors",
              activeTab === "rss"
                ? "bg-primary font-medium text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
            role="tab"
            type="button"
            onClick={() => onTabChange("rss")}
          >
            RSS订阅
          </button>
          <button
            aria-selected={activeTab === "search"}
            className={cn(
              "px-3 text-sm transition-colors",
              activeTab === "search"
                ? "bg-primary font-medium text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
            role="tab"
            type="button"
            onClick={() => onTabChange("search")}
          >
            资源搜索
          </button>
        </div>

        {activeTab === "search" && (
          <AnimeSourceBindingPanel
            actionKey={sourceBindingActionKey}
            loading={sourceBindingLoading}
            state={sourceBindingState}
            onConfirm={onConfirmSourceCandidate}
            onRefresh={onRefreshSourceBindings}
            onRemove={onRemoveSourceBinding}
          />
        )}

        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3">
          <select
            className="h-9 min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            value={selectedFansubId}
            onChange={(event) => onFansubChange(event.target.value)}
          >
            <option value="">全部字幕组（{tabReleases.length}）</option>
            {fansubs.map((group) => {
              const count = countReleasesByFansub(tabReleases, group.id);
              return (
                <option key={group.id} value={group.id}>
                  {group.name}
                  {count > 0 ? `（${count}）` : ""}
                </option>
              );
            })}
            {unknownFansubCount > 0 && <option value={unknownFansubFilter}>未识别字幕组（{unknownFansubCount}）</option>}
          </select>
          {activeTab === "rss" ? (
            <Button variant="outline" onClick={onRefreshRss} disabled={rssLoading}>
              <RefreshCw className="h-4 w-4" />
              {rssLoading ? "读取中" : "刷新RSS"}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={onRefresh} disabled={loading}>
                <Search className="h-4 w-4" />
                {loading ? "查询中" : "刷新"}
              </Button>
              <Button variant="outline" onClick={onForceRefresh} disabled={loading} title="绕过 1 天缓存重新查询下载源">
                <RefreshCw className="h-4 w-4" />
                强制刷新
              </Button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span>显示 {visibleReleases.length} 条</span>
            <span>共 {tabReleases.length} 条</span>
            <span>已选 {selectedDownloadableReleases.length} 条</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={toggleAllVisibleReleases} disabled={selectableVisibleReleases.length === 0 || activeLoading}>
              全选可下载
            </Button>
            <Button
              onClick={() => onAddSelected(selectedDownloadableReleases)}
              disabled={selectedDownloadableReleases.length === 0 || batchAdding || activeLoading}
            >
              <Download className="h-4 w-4" />
              {batchAdding ? "添加中" : "批量下载"}
            </Button>
          </div>
        </div>

        {activeTab === "search" && visibleErrors.length > 0 && (
          <div className="space-y-2">
            {visibleErrors.slice(0, 3).map((error, index) => (
              <div
                key={`${error.sourceId}-${index}`}
                className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
              >
                {error.sourceId}: {error.message}
              </div>
            ))}
          </div>
        )}

        {activeLoading ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {activeTab === "rss" ? "正在读取 RSS 订阅..." : "正在查询发布资源..."}
          </div>
        ) : (
          <div className={cn("space-y-4", listClassName)}>
            {activeTab === "rss"
              ? rssGroups.map((group) => {
                  const groupKey = `rss:${group.subscription.id}`;
                  const groupReleases = filterReleasesByFansub(group.releases, selectedFansubId);
                  return (
                    <section key={group.subscription.id} className="overflow-hidden rounded-md border bg-background">
                      <button
                        className="flex w-full items-center justify-between border-b bg-muted/70 px-3 py-2 text-left hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/25"
                        type="button"
                        onClick={() => toggleGroup(groupKey)}
                        aria-expanded={!collapsedGroupKeys.has(groupKey)}
                        title={group.subscription.url}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {collapsedGroupKeys.has(groupKey) ? (
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate text-sm font-semibold">{group.subscription.name}</span>
                          <Badge>{groupReleases.length} 个资源</Badge>
                        </div>
                        <span className="text-xs text-muted-foreground">{countEpisodes(groupReleases)} 集</span>
                      </button>
                      {!collapsedGroupKeys.has(groupKey) && (
                        <div>
                          {group.errors.length > 0 && (
                            <div className="space-y-2 border-b p-3">
                              {group.errors.map((error, index) => (
                                <div
                                  key={`${error.sourceId}-${index}`}
                                  className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                                >
                                  {group.subscription.name}: {error.message}
                                </div>
                              ))}
                            </div>
                          )}
                          {groupReleases.length > 0 ? (
                            <div className="divide-y">{renderEpisodeGroups(groupReleases)}</div>
                          ) : (
                            <div className="p-6 text-center text-sm text-muted-foreground">当前订阅没有匹配资源。</div>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })
              : releaseGroups.map((group) => (
                  <section key={group.key} className="overflow-hidden rounded-md border bg-background">
                    <button
                      className="flex w-full items-center justify-between border-b bg-muted/70 px-3 py-2 text-left hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/25"
                      type="button"
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={!collapsedGroupKeys.has(group.key)}
                      title={group.name}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {collapsedGroupKeys.has(group.key) ? (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate text-sm font-semibold">{group.name}</span>
                        <Badge>{group.releases.length} 个资源</Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">{countEpisodes(group.releases)} 集</span>
                    </button>
                    {!collapsedGroupKeys.has(group.key) && <div className="divide-y">{renderEpisodeGroups(group.releases)}</div>}
                  </section>
                ))}

            {visibleReleases.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                {sourceFailed
                  ? activeTab === "rss"
                    ? "RSS 订阅请求失败，暂时无法获取发布资源。"
                    : "下载源请求失败，暂时无法获取发布资源和字幕组文件信息。"
                  : selectedFansubId
                    ? "当前字幕组没有可下载资源。"
                    : activeTab === "rss"
                      ? "没有找到 RSS 订阅资源，或尚未配置启用的 RSS 订阅。"
                      : "没有找到可下载资源。"}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function ReleaseDownloadRow({
  release,
  linkedTask,
  fansubNames,
  selected,
  addingReleaseId,
  onToggleSelected,
  onAddRelease
}: {
  release: Release;
  linkedTask?: DownloadTask;
  fansubNames: Map<string, string>;
  selected: boolean;
  addingReleaseId: string | null;
  onToggleSelected: (release: Release) => void;
  onAddRelease: (release: Release) => void;
}) {
  const canDownload = Boolean(release.magnetUrl ?? release.torrentUrl);
  const selectable = canDownload && !linkedTask;

  return (
    <div className="p-3">
      <div className="flex items-start justify-between gap-3">
        <label className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
          <input
            aria-label={`选择资源 ${release.title}`}
            checked={selected}
            className="h-4 w-4 rounded border"
            disabled={!selectable}
            type="checkbox"
            onChange={() => onToggleSelected(release)}
          />
        </label>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={release.title}>
            {release.title}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge tone="blue">{release.sourceName}</Badge>
            <Badge>{getReleaseFansubName(release, fansubNames)}</Badge>
            {release.resolution && <Badge>{release.resolution}</Badge>}
            {release.normalizedVideoCodec && <Badge tone="green">{release.normalizedVideoCodec}</Badge>}
            {release.subtitle && <Badge>{subtitleText[release.subtitle]}</Badge>}
            {release.size && <Badge>{formatBytes(release.size)}</Badge>}
            {linkedTask && (
              <Badge tone={isCompletedDownload(linkedTask) ? "green" : "amber"}>
                {downloadStatusText[linkedTask.status]}
              </Badge>
            )}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {formatReleaseDate(release.publishedAt)}
          </div>
        </div>
        <Button
          className="shrink-0"
          variant="outline"
          onClick={() => onAddRelease(release)}
          disabled={!canDownload || Boolean(linkedTask) || addingReleaseId === release.id || addingReleaseId === batchAddingReleaseId}
        >
          <Download className="h-4 w-4" />
          {linkedTask ? "已加入" : addingReleaseId === release.id ? "添加中" : "添加下载"}
        </Button>
      </div>
    </div>
  );
}

/** 展示精确下载源的绑定状态和待确认候选。 */
function AnimeSourceBindingPanel({
  state,
  loading,
  actionKey,
  onConfirm,
  onRemove,
  onRefresh
}: {
  state: AnimeSourceBindingState | null;
  loading: boolean;
  actionKey: string | null;
  onConfirm: (candidate: AnimeSourceCandidate) => void;
  onRemove: (sourceId: string) => void;
  onRefresh: () => void;
}) {
  const groupedCandidates = groupSourceCandidates(state?.candidates ?? []);
  const confirmedBindings = state?.bindings.filter((binding) => binding.confirmed) ?? [];
  const hasContent = Boolean(confirmedBindings.length || groupedCandidates.length || state?.errors.length);

  return (
    <section className="overflow-hidden rounded-md border bg-background">
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          来源匹配
        </div>
        <Button variant="ghost" onClick={onRefresh} disabled={loading} title="重新读取来源候选" aria-label="重新读取来源候选">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>
      {loading && !hasContent ? (
        <div className="px-3 py-4 text-sm text-muted-foreground">正在匹配来源番剧...</div>
      ) : hasContent ? (
        <div className="max-h-72 divide-y overflow-y-auto">
          {confirmedBindings.map((binding) => (
            <div key={binding.sourceId} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge tone="green"><Check className="mr-1 h-3 w-3" />已绑定</Badge>
                  <span className="truncate text-sm font-medium">{binding.sourceAnimeTitle ?? binding.sourceId}</span>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {binding.sourceId} · ID {binding.sourceAnimeId} · {getBindingMethodText(binding.matchMethod)}
                </div>
              </div>
              <Button
                variant="ghost"
                onClick={() => onRemove(binding.sourceId)}
                disabled={actionKey === binding.sourceId}
                title="移除来源绑定"
                aria-label="移除来源绑定"
              >
                <Unlink className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {groupedCandidates.map((group) => (
            <div key={group.sourceId} className="px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-medium">{group.sourceName}</div>
                <Badge tone="amber">待确认</Badge>
              </div>
              <div className="space-y-2">
                {group.candidates.slice(0, 1).map((candidate) => {
                  const candidateKey = `${candidate.sourceId}:${candidate.sourceAnimeId}`;
                  return (
                    <div key={candidateKey} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm" title={candidate.title}>{candidate.title}</div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          ID {candidate.sourceAnimeId} · {candidate.reasons.join(" · ")}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => onConfirm(candidate)}
                        disabled={actionKey === candidateKey}
                      >
                        <Check className="h-4 w-4" />
                        {candidate.score} 分
                      </Button>
                    </div>
                  );
                })}
                {group.candidates.length > 1 && (
                  <details>
                    <summary className="cursor-pointer py-1 text-xs text-muted-foreground hover:text-foreground">
                      其他候选（{group.candidates.length - 1}）
                    </summary>
                    <div className="mt-2 space-y-2">
                      {group.candidates.slice(1).map((candidate) => {
                        const candidateKey = `${candidate.sourceId}:${candidate.sourceAnimeId}`;
                        return (
                          <div key={candidateKey} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm" title={candidate.title}>{candidate.title}</div>
                              <div className="mt-1 truncate text-xs text-muted-foreground">
                                ID {candidate.sourceAnimeId} · {candidate.reasons.join(" · ")}
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              onClick={() => onConfirm(candidate)}
                              disabled={actionKey === candidateKey}
                            >
                              <Check className="h-4 w-4" />
                              {candidate.score} 分
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
              </div>
            </div>
          ))}
          {state?.errors.map((error) => (
            <div key={`${error.sourceId}:${error.message}`} className="px-3 py-2 text-xs text-amber-700">
              {error.sourceId}: {error.message}
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-4 text-sm text-muted-foreground">没有启用支持精确匹配的来源。</div>
      )}
    </section>
  );
}

function groupSourceCandidates(candidates: AnimeSourceCandidate[]) {
  const groups = new Map<string, { sourceId: string; sourceName: string; candidates: AnimeSourceCandidate[] }>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.sourceId) ?? {
      sourceId: candidate.sourceId,
      sourceName: candidate.sourceName,
      candidates: []
    };
    group.candidates.push(candidate);
    groups.set(candidate.sourceId, group);
  }
  return [...groups.values()];
}

function getBindingMethodText(method: "manual" | "external_id" | "scored"): string {
  if (method === "manual") return "人工确认";
  if (method === "external_id") return "外部ID";
  return "评分缓存";
}

function DownloadMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 px-2">
      <div className="text-lg font-semibold">{value}</div>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function EpisodeRulesPanel({
  draft,
  persisted,
  episodes,
  episodePreferences,
  downloadTasks,
  releasePreviews,
  fansubs,
  fansubNames,
  loading,
  previewingEpisodeId,
  addingReleaseId,
  onAddEpisode,
  onStatusChange,
  onFansubChange,
  onPreviewReleases,
  onAddRelease
}: {
  draft: MyAnime | null;
  persisted: boolean;
  episodes: Episode[];
  episodePreferences: EpisodePreference[];
  downloadTasks: DownloadTask[];
  releasePreviews: Record<string, EpisodeReleasePreview>;
  fansubs: FansubGroup[];
  fansubNames: Map<string, string>;
  loading: boolean;
  previewingEpisodeId: string | null;
  addingReleaseId: string | null;
  onAddEpisode: () => void;
  onStatusChange: (episode: Episode, status: EpisodeStatus) => void;
  onFansubChange: (episode: Episode, fansubGroupId: string) => void;
  onPreviewReleases: (episode: Episode) => void;
  onAddRelease: (episode: Episode, release: Release) => void;
}) {
  if (!draft) {
    return (
      <Panel title="单集规则">
        <div className="rounded-md border border-dashed p-6 text-sm leading-6 text-muted-foreground">
          选择一部番剧后可管理每集的字幕组覆盖。
        </div>
      </Panel>
    );
  }

  if (!persisted) {
    return (
      <Panel title="单集规则">
        <div className="rounded-md border border-dashed p-6 text-sm leading-6 text-muted-foreground">
          新追番需要先保存，之后才能添加单集规则。
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="单集规则"
      description="不设置时跟随番剧默认字幕组；设置后这一集会优先使用覆盖字幕组。"
      action={
        <Button variant="outline" onClick={onAddEpisode}>
          <Plus className="h-4 w-4" />
          添加下一集
        </Button>
      }
    >
      {loading ? (
        <div className="text-sm text-muted-foreground">正在加载单集规则...</div>
      ) : (
        <div className="space-y-3">
          {episodes.map((episode) => {
            const preference = episodePreferences.find((item) => item.episodeId === episode.id);
            const preview = releasePreviews[episode.id];
            const linkedDownload = findEpisodeDownloadTask(downloadTasks, episode);
            const inheritedFansub = draft.defaultFansubGroupId
              ? (fansubNames.get(draft.defaultFansubGroupId) ?? "默认字幕组")
              : "未设置默认字幕组";
            const effectiveFansub = preference?.fansubGroupId
              ? (fansubNames.get(preference.fansubGroupId) ?? preference.fansubGroupId)
              : inheritedFansub;

            return (
              <div key={episode.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">第 {episode.episodeNo} 集</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{episode.title ?? "未命名单集"}</div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>当前字幕组：{effectiveFansub}</span>
                      {linkedDownload && (
                        <span>
                          下载任务：{downloadStatusText[linkedDownload.status]} · {formatPercent(linkedDownload.progress)}
                        </span>
                      )}
                    </div>
                  </div>
                  <Badge tone={episode.status === "downloaded" || episode.status === "watched" ? "green" : "neutral"}>
                    {episodeStatusText[episode.status]}
                  </Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <select
                    className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
                    value={episode.status}
                    onChange={(event) => onStatusChange(episode, event.target.value as EpisodeStatus)}
                  >
                    {episodeStatusOptions.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
                    value={preference?.fansubGroupId ?? ""}
                    onChange={(event) => onFansubChange(episode, event.target.value)}
                  >
                    <option value="">跟随默认：{inheritedFansub}</option>
                    {fansubs.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 text-xs text-muted-foreground">
                    {preview ? `候选 ${preview.candidates.length} 个` : "尚未匹配资源"}
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => onPreviewReleases(episode)}
                    disabled={previewingEpisodeId === episode.id}
                  >
                    <Search className="h-4 w-4" />
                    {previewingEpisodeId === episode.id ? "查询中" : "查看发布"}
                  </Button>
                </div>
                {preference?.fansubGroupId && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    当前覆盖：{fansubNames.get(preference.fansubGroupId) ?? preference.fansubGroupId}
                  </div>
                )}
                {preview && (
                  <div className="mt-3 space-y-2">
                    {preview.candidates.slice(0, 6).map((candidate) => (
                      <div key={candidate.release.id} className="rounded-md bg-muted p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{candidate.release.title}</div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Badge tone="blue">{candidate.score} 分</Badge>
                              <Badge>{candidate.release.sourceName}</Badge>
                              <Badge>第 {candidate.release.episodeNo ?? episode.episodeNo} 集</Badge>
                              <Badge>{getReleaseFansubName(candidate.release, fansubNames)}</Badge>
                              {candidate.release.resolution && <Badge>{candidate.release.resolution}</Badge>}
                              {candidate.release.normalizedVideoCodec && (
                                <Badge tone="green">{candidate.release.normalizedVideoCodec}</Badge>
                              )}
                              {candidate.release.subtitle && <Badge>{subtitleText[candidate.release.subtitle]}</Badge>}
                              {candidate.release.size && <Badge>{formatBytes(candidate.release.size)}</Badge>}
                              {typeof candidate.release.seeders === "number" && (
                                <Badge tone={candidate.release.seeders > 0 ? "green" : "neutral"}>
                                  {candidate.release.seeders} 做种
                                </Badge>
                              )}
                            </div>
                            <div className="mt-2 text-xs text-muted-foreground">
                              {candidate.reasons.join("，") || "规则匹配"}
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            onClick={() => onAddRelease(episode, candidate.release)}
                            disabled={addingReleaseId === candidate.release.id}
                          >
                            <Download className="h-4 w-4" />
                            {addingReleaseId === candidate.release.id ? "添加中" : "添加下载"}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {episodes.length === 0 && (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              还没有单集，添加后可为每集设置字幕组。
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function findEpisodeDownloadTask(downloadTasks: DownloadTask[], episode: Episode): DownloadTask | undefined {
  return downloadTasks.find((task) => task.episodeId === episode.id);
}

/** 汇总一部追番已关联的唯一集数。 */
function summarizeAnimeDownloads(downloadTasks: DownloadTask[], animeId: string) {
  const tasks = downloadTasks.filter((task) => task.animeId === animeId && task.episodeNo !== undefined);
  return {
    linked: countDownloadEpisodes(tasks),
    completed: countDownloadEpisodes(tasks.filter(isCompletedDownload)),
    active: countDownloadEpisodes(tasks.filter(isActiveDownload))
  };
}

function countDownloadEpisodes(downloadTasks: DownloadTask[]): number {
  return new Set(downloadTasks.map((task) => task.episodeNo).filter((value) => value !== undefined)).size;
}

function isActiveDownload(task: DownloadTask): boolean {
  return ["queued", "fetching_metadata", "downloading", "stalled", "paused", "checking", "moving"].includes(
    task.status
  );
}

/** 读取并按集数、创建时间排序某部番的下载任务。 */
function getAnimeDownloadTasks(downloadTasks: DownloadTask[], animeId: string): DownloadTask[] {
  return downloadTasks
    .filter((task) => task.animeId === animeId)
    .sort((left, right) => {
      const leftEpisode = left.episodeNo ?? -1;
      const rightEpisode = right.episodeNo ?? -1;
      if (leftEpisode !== rightEpisode) {
        return rightEpisode - leftEpisode;
      }

      return right.createdAt.localeCompare(left.createdAt);
    });
}

function filterAnimeDownloadDetailTasks(
  downloadTasks: DownloadTask[],
  filter: AnimeDownloadDetailFilter
): DownloadTask[] {
  if (filter === "active") {
    return downloadTasks.filter(isActiveDownload);
  }

  if (filter === "completed") {
    return downloadTasks.filter(isCompletedDownload);
  }

  return downloadTasks;
}

function getDownloadStatusTone(status: DownloadTask["status"]): "neutral" | "green" | "amber" | "red" | "blue" {
  if (status === "completed" || status === "seeding") return "green";
  if (status === "error" || status === "missing_files") return "red";
  if (status === "paused" || status === "stalled") return "amber";
  if (status === "downloading") return "blue";
  return "neutral";
}

function getProgressWidth(progress: number): number {
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

function buildSearchTerms(item: MyAnime): string[] {
  return buildAnimeReleaseSearchTerms(item.anime, [], 8);
}

/** 读取当前追番已启用且地址有效的 RSS 订阅。 */
function getEnabledRssSubscriptions(item: MyAnime): AnimeRssSubscription[] {
  return (item.rssSubscriptions ?? []).filter((subscription) => subscription.enabled && subscription.url.trim());
}

/** 保存前清理 RSS 订阅内容，过滤空地址并补齐时间字段。 */
function normalizeRssSubscriptions(item: MyAnime, timestamp: string): AnimeRssSubscription[] {
  return (item.rssSubscriptions ?? [])
    .map((subscription, index) => ({
      ...subscription,
      myAnimeId: item.id,
      name: subscription.name.trim() || `RSS订阅 ${index + 1}`,
      url: subscription.url.trim(),
      createdAt: subscription.createdAt || timestamp,
      updatedAt: timestamp
    }))
    .filter((subscription) => subscription.url);
}

/** 根据番剧的 Mikan 外部 ID 生成蜜柑计划 RSS 地址。 */
function buildMikanRssUrl(item: MyAnime): string | undefined {
  const mikanId = item.anime.externalIds.mikan?.trim();
  return mikanId ? `https://mikanani.me/RSS/Bangumi?bangumiId=${encodeURIComponent(mikanId)}` : undefined;
}

/** 构造追番资源添加下载时需要的关联参数。 */
function buildAnimeReleaseDownloadInput(
  release: Release,
  target: MyAnime,
  selectedFansubId: string
): AddReleaseDownloadInput {
  return {
    release: {
      ...release,
      animeId: target.anime.id
    },
    animeId: target.anime.id,
    episodeNo: release.episodeNo,
    fansubGroupId:
      release.fansubGroupId ??
      (selectedFansubId && selectedFansubId !== unknownFansubFilter ? selectedFansubId : undefined) ??
      target.defaultFansubGroupId,
    savePath: target.downloadDir
  };
}

function dedupeReleases(releases: Release[]): Release[] {
  const seen = new Set<string>();

  return releases.filter((release) => {
    const key = releaseKey(release);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function dedupeReleaseErrors(errors: ReleaseSearchResult["errors"]): ReleaseSearchResult["errors"] {
  const seen = new Set<string>();

  return errors.filter((error) => {
    const key = `${error.sourceId}:${error.message}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function sortReleases(releases: Release[]): Release[] {
  return [...releases].sort((left, right) => {
    const leftEpisode = left.episodeNo ?? -1;
    const rightEpisode = right.episodeNo ?? -1;
    if (leftEpisode !== rightEpisode) {
      return rightEpisode - leftEpisode;
    }

    return (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "");
  });
}

function filterReleasesByFansub(releases: Release[], fansubGroupId: string): Release[] {
  if (!fansubGroupId) {
    return releases;
  }

  if (fansubGroupId === unknownFansubFilter) {
    return releases.filter((release) => !release.fansubGroupId);
  }

  return releases.filter((release) => release.fansubGroupId === fansubGroupId);
}

function countReleasesByFansub(releases: Release[], fansubGroupId: string): number {
  return releases.filter((release) => release.fansubGroupId === fansubGroupId).length;
}

interface ReleaseFansubGroup {
  key: string;
  name: string;
  releases: Release[];
}

function groupReleasesByFansub(releases: Release[], fansubNames: Map<string, string>): ReleaseFansubGroup[] {
  const groups = new Map<string, ReleaseFansubGroup>();
  for (const release of releases) {
    const key = release.fansubGroupId ?? release.fansubName ?? unknownFansubFilter;
    const group = groups.get(key) ?? {
      key,
      name: getReleaseFansubName(release, fansubNames),
      releases: []
    };
    group.releases.push(release);
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function countEpisodes(releases: Release[]): number {
  return new Set(releases.map((release) => release.episodeNo).filter((value) => value !== undefined)).size;
}

interface ReleaseEpisodeGroup {
  key: string;
  label: string;
  releases: Release[];
}

function groupReleaseEpisodes(releases: Release[]): ReleaseEpisodeGroup[] {
  const groups = new Map<string, ReleaseEpisodeGroup>();
  for (const release of releases) {
    const key = release.episodeNo === undefined ? "unknown" : String(release.episodeNo);
    const group = groups.get(key) ?? {
      key,
      label: release.episodeNo === undefined ? "未识别集数" : `第 ${release.episodeNo} 集`,
      releases: []
    };
    group.releases.push(release);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function findReleaseDownloadTask(tasks: DownloadTask[], release: Release): DownloadTask | undefined {
  return tasks.find((task) => {
    if (task.releaseId === release.id) {
      return true;
    }

    const releaseFansubKey = release.fansubGroupId ?? release.fansubName;
    return Boolean(
      releaseFansubKey &&
      task.episodeNo !== undefined &&
      task.episodeNo === release.episodeNo &&
      (task.fansubGroupId ?? task.fansubName) === releaseFansubKey
    );
  });
}

/** 判断资源是否可被批量选择下载。 */
function isReleaseSelectable(release: Release, linkedTasks: DownloadTask[]): boolean {
  return Boolean(release.magnetUrl ?? release.torrentUrl) && !findReleaseDownloadTask(linkedTasks, release);
}

function isCompletedDownload(task: DownloadTask): boolean {
  return task.status === "completed" || task.status === "seeding";
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatSpeedText(value: number): string {
  return `${formatBytes(value)}/s`;
}

function getReleaseFansubName(release: Release, fansubNames: Map<string, string>): string {
  if (!release.fansubGroupId) {
    return release.fansubName ?? "未识别字幕组";
  }

  return fansubNames.get(release.fansubGroupId) ?? release.fansubName ?? release.fansubGroupId;
}

function releaseKey(release: Release): string {
  return release.infoHash ?? release.magnetUrl ?? release.torrentUrl ?? `${release.sourceId}:${release.title}`;
}

function formatReleaseDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function TextField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 text-sm font-medium">{label}</div>
      <input
        className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextareaField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 text-sm font-medium">{label}</div>
      <textarea
        className="min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 text-sm font-medium">{label}</div>
      <input
        className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
        max={max}
        min={min}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 text-sm font-medium">{label}</div>
      <select
        className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value || "empty"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function createEmptyDraft(): MyAnime {
  const now = new Date();
  const animeId = createId("anime");

  return {
    id: createId("my"),
    anime: {
      id: animeId,
      title: "",
      originalTitle: "",
      aliases: [],
      premiereYear: now.getFullYear(),
      premiereMonth: now.getMonth() + 1,
      externalIds: {}
    },
    status: "watching",
    autoDownload: false,
    preferredResolution: "1080p",
    preferredCodec: "H.265/HEVC",
    preferredSubtitle: "chs",
    addedAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function cloneMyAnime(item: MyAnime): MyAnime {
  return JSON.parse(JSON.stringify(item)) as MyAnime;
}

function clampMonth(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.min(12, value));
}

function createId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
