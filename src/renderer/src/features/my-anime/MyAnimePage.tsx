import { AlertTriangle, CalendarDays, Check, ChevronDown, ChevronRight, Download, Link2, Plus, RefreshCw, Rss, Save, Search, SlidersHorizontal, Trash2, Unlink } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { FilterToolbar, Page, PageActions, PageHeader, PageHeading } from "@/components/page-layout";
import { ReleaseMetadataBadges } from "@/components/release-metadata-badges";
import { WorkbenchSheet } from "@/components/workbench-sheet";
import { appApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatBytes, formatPercent } from "@/lib/format";
import {
  AnimeDownloadTaskSheet,
  isActiveDownload,
  isCompletedDownload,
  type AnimeDownloadDetailFilter,
  type AnimeDownloadDetailState
} from "@/features/my-anime/download-task-sheet";
import { groupMyAnimeBySeason, MyAnimeRow } from "@/features/my-anime/my-anime-list";
import {
  countReleaseFamilyEpisodes,
  getReleaseVersionLabel,
  groupReleaseFamilyEpisodes,
  groupReleaseVersions,
  isReleaseSelectable,
  releaseKey,
  type ReleaseEpisodeFamilyGroup,
  type ReleaseVersionFamily
} from "@/features/my-anime/release-groups";
import { buildAnimeReleaseSearchTerms, classifyAnimeRelease } from "@shared/anime-release-search";
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
  SubtitleLanguage,
  VideoBitDepth
} from "@shared/domain";
import { formatSubtitleLanguages, formatVideoBitDepth, resolveSubtitleLanguages, subtitleLanguageText } from "@shared/release-metadata";

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
const subtitleOptions: SubtitleLanguage[] = ["chs", "cht", "jpn", "eng"];
const bitDepthOptions: Array<"" | VideoBitDepth> = ["", 8, 10, 12];
const unknownFansubFilter = "__unknown__";
const batchAddingReleaseId = "__batch__";
const emptySelectValue = "__empty__";
type DownloadResourceTab = "rss" | "search";
type MyAnimeFilter = "all" | AnimeStatus;
type RulesTab = "basic" | "download" | "rss" | "episodes";
const defaultRssRefreshIntervalMinutes = 20;

interface RssReleaseGroupState {
  subscription: AnimeRssSubscription;
  releases: Release[];
  errors: RssSubscriptionReleaseResult["errors"];
}

interface RssSubscriptionDraft {
  name: string;
  url: string;
  preferredSubtitleLanguages?: SubtitleLanguage[];
}

const myAnimeFilters: Array<{ value: MyAnimeFilter; label: string }> = [
  { value: "all", label: "全部" },
  ...statusOptions.map(([value, label]) => ({ value, label }))
];
const releaseSearchCacheTtlMs = 24 * 60 * 60 * 1000;

/** 渲染追番列表并协调规则、资源下载和任务明细抽屉。 */
export function MyAnimePage() {
  const [items, setItems] = useState<MyAnime[]>([]);
  const [removeTarget, setRemoveTarget] = useState<MyAnime | null>(null);
  const [statusFilter, setStatusFilter] = useState<MyAnimeFilter>("watching");
  const [fansubs, setFansubs] = useState<FansubGroup[]>([]);
  const [animeFansubs, setAnimeFansubs] = useState<FansubGroup[]>([]);
  const [draft, setDraft] = useState<MyAnime | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<string | null>(null);
  const [discardRulesDialogOpen, setDiscardRulesDialogOpen] = useState(false);
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

  const fansubNames = useMemo(
    () => new Map(mergeFansubGroups(fansubs, animeFansubs).map((group) => [group.id, group.name])),
    [fansubs, animeFansubs]
  );
  const visibleItems = useMemo(
    () => items.filter((item) => statusFilter === "all" || item.status === statusFilter),
    [items, statusFilter]
  );
  const groupedItems = useMemo(() => groupMyAnimeBySeason(visibleItems), [visibleItems]);
  const draftPersisted = Boolean(draft && items.some((item) => item.id === draft.id));
  const activeFansubAnimeId = draft && draftPersisted ? draft.anime.id : downloadTarget?.anime.id;

  useEffect(() => {
    let active = true;
    if (!activeFansubAnimeId) {
      setAnimeFansubs([]);
      return;
    }

    appApi.listFansubs(activeFansubAnimeId)
      .then((groups) => {
        if (!active) return;
        setAnimeFansubs(groups);
        setFansubs((current) => mergeFansubGroups(current, groups));
      })
      .catch((error) => {
        if (active) {
          setMessage({ tone: "error", text: error instanceof Error ? error.message : "加载番剧字幕组失败" });
        }
      });
    return () => {
      active = false;
    };
  }, [activeFansubAnimeId]);

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
      setDraftBaseline(null);
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

  /** 刷新某部番剧已从真实资源发现的字幕组。 */
  async function refreshAnimeFansubs(animeId: string) {
    const groups = await appApi.listFansubs(animeId);
    setAnimeFansubs(groups);
    setFansubs((current) => mergeFansubGroups(current, groups));
  }

  async function removeItem(item: MyAnime) {
    try {
      const updated = await appApi.removeMyAnime(item.id);
      setItems(updated);
      if (draft?.id === item.id) {
        setDraft(null);
        setDraftBaseline(null);
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
      throw error;
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
      await refreshAnimeFansubs(episode.animeId);
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
    setDraftBaseline(null);
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
    const nextDraft = cloneMyAnime(item);
    setDraft(nextDraft);
    setDraftBaseline(serializeMyAnimeDraft(nextDraft));
  }

  /** 打开新增追番规则侧栏，并记录初始草稿用于退出确认。 */
  function openNewAnimeDrawer() {
    closeAnimeDownloads();
    closeDownloadDetail();
    const nextDraft = createEmptyDraft();
    setDraft(nextDraft);
    setDraftBaseline(serializeMyAnimeDraft(nextDraft));
  }

  /** 请求关闭规则侧栏；草稿发生变化时先要求确认。 */
  function requestCloseRules() {
    if (draft && draftBaseline !== serializeMyAnimeDraft(draft)) {
      setDiscardRulesDialogOpen(true);
      return;
    }
    setDraft(null);
    setDraftBaseline(null);
  }

  /** 放弃当前规则草稿并关闭侧栏。 */
  function discardRulesDraft() {
    setDraft(null);
    setDraftBaseline(null);
    setDiscardRulesDialogOpen(false);
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
      await refreshAnimeFansubs(target.anime.id);
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
      await refreshAnimeFansubs(target.anime.id);
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

  /** 将资源分组推导出的 RSS 地址保存到当前追番。 */
  async function addAnimeRssSubscription(subscriptionDraft: RssSubscriptionDraft) {
    if (!downloadTarget) {
      return;
    }

    const url = subscriptionDraft.url.trim();
    if (!url) {
      setMessage({ tone: "error", text: "RSS 地址为空，无法订阅" });
      return;
    }

    const existingSubscriptions = downloadTarget.rssSubscriptions ?? [];
    if (existingSubscriptions.some((subscription) => subscription.url.trim() === url)) {
      setMessage({ tone: "success", text: "该 RSS 已在当前追番订阅中" });
      return;
    }

    const now = new Date().toISOString();
    const nextTarget: MyAnime = {
      ...downloadTarget,
      rssSubscriptions: normalizeRssSubscriptions(
        {
          ...downloadTarget,
          rssSubscriptions: [
            ...existingSubscriptions,
            {
              id: createId("rss"),
              myAnimeId: downloadTarget.id,
              name: subscriptionDraft.name.trim() || "RSS订阅",
              url,
              enabled: true,
              preferredSubtitleLanguages: subscriptionDraft.preferredSubtitleLanguages,
              refreshIntervalMinutes: defaultRssRefreshIntervalMinutes,
              createdAt: now,
              updatedAt: now
            }
          ]
        },
        now
      ),
      updatedAt: now
    };

    try {
      const updatedItems = await appApi.upsertMyAnime(nextTarget);
      const savedTarget = updatedItems.find((item) => item.id === downloadTarget.id) ?? nextTarget;
      setItems(updatedItems);
      setDownloadTarget(cloneMyAnime(savedTarget));
      setMessage({ tone: "success", text: `已添加 RSS 订阅：${subscriptionDraft.name}` });
      if (downloadResourceTab === "rss") {
        void searchAnimeRssReleases(savedTarget);
      }
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "添加 RSS 订阅失败"
      });
    }
  }

  async function addEpisodeReleaseDownload(episode: Episode, release: Release) {
    setAddingReleaseId(release.id);
    try {
      const updatedDownloads = await appApi.addReleaseDownload({
        release,
        animeId: episode.animeId,
        episodeId: episode.id,
        episodeNo: episode.episodeNo,
        fansubGroupId: release.fansubGroupId
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
        buildAnimeReleaseDownloadInput(release, downloadTarget)
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
      const compatible = classifyAnimeRelease(release, downloadTarget.anime) === "current";
      return compatible && canDownload && !findReleaseDownloadTask(linkedTasks, release);
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
          buildAnimeReleaseDownloadInput(release, downloadTarget)
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
    return <MyAnimePageSkeleton />;
  }

  return (
    <Page>
      <PageHeader>
        <PageHeading description="按季度管理追番进度、下载偏好、字幕组与单集规则。" title="我的追番" />
        <PageActions>
          <Button className="w-full sm:w-auto" onClick={openNewAnimeDrawer}>
          <Plus data-icon="inline-start" />
          添加追番
          </Button>
        </PageActions>
      </PageHeader>

      {message && (
        <Alert variant={message.tone === "error" ? "destructive" : "default"}>
          {message.tone === "error" && <AlertTriangle />}
          <AlertTitle>{message.tone === "error" ? "操作失败" : "操作完成"}</AlertTitle>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <FilterToolbar>
        <Tabs
          className="min-w-0 flex-1"
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as MyAnimeFilter)}
        >
          <TabsList className="grid h-auto w-full grid-cols-3 sm:w-fit sm:grid-cols-6" aria-label="筛选追番状态">
            {myAnimeFilters.map((filter) => (
              <TabsTrigger className="min-w-0 px-2" key={filter.value} value={filter.value}>
                {filter.label}
                <span className="ml-1 text-xs tabular-nums">
                  {filter.value === "all" ? items.length : items.filter((item) => item.status === filter.value).length}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">显示 {visibleItems.length} 部</span>
      </FilterToolbar>

      {groupedItems.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-7">
          {groupedItems.map((group) => (
            <section className="min-w-0" key={group.key}>
              <div className="mb-2 flex items-center justify-between gap-3 border-b pb-2">
                <h2 className="text-sm font-semibold">{group.label}</h2>
                <span className="text-xs text-muted-foreground">{group.items.length} 部</span>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                {group.items.map((item) => (
                  <MyAnimeRow
                    key={item.id}
                    item={item}
                    defaultFansubName={fansubNames.get(item.defaultFansubGroupId ?? "") ?? "未设置"}
                    downloadSummary={summarizeAnimeDownloads(downloadTasks, item.anime.id)}
                    onOpenActive={() => openDownloadDetail(item, "active")}
                    onOpenCompleted={() => openDownloadDetail(item, "completed")}
                    onOpenDownloads={() => void openAnimeDownloads(item)}
                    onOpenRules={() => openRulesDrawer(item)}
                    onRemove={() => setRemoveTarget(item)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty className="min-h-72">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarDays />
            </EmptyMedia>
            <EmptyTitle>{items.length ? "没有匹配的追番" : "暂无追番"}</EmptyTitle>
            <EmptyDescription>{items.length ? "请选择其他状态筛选。" : "当前还没有追番。"}</EmptyDescription>
          </EmptyHeader>
        </Empty>
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
          fansubs={animeFansubs}
          previewingEpisodeId={previewingEpisodeId}
          releasePreviews={releasePreviews}
          saving={saving}
          onAddEpisode={() => void addNextEpisode()}
          onAddRelease={(episode, release) => void addEpisodeReleaseDownload(episode, release)}
          onCancel={requestCloseRules}
          onChange={setDraft}
          onFansubChange={(episode, fansubGroupId) => void updateEpisodeFansub(episode, fansubGroupId)}
          onPreviewReleases={(episode) => void previewEpisodeReleases(episode)}
          onSave={() => void saveDraft()}
          onStatusChange={(episode, status) => void updateEpisodeStatus(episode, status)}
        />
      )}

      {downloadTarget && (
        <WorkbenchSheet
          bodyClassName="flex flex-col overflow-hidden"
          className="sm:max-w-5xl"
          description={`${resolveAnimeTitleDisplay(downloadTarget.anime).subtitle ?? "追番资源"} · ${animeReleases.length + animeRssReleaseGroups.reduce((total, group) => total + group.releases.length, 0)} 个资源`}
          onClose={closeAnimeDownloads}
          title={`下载资源 · ${resolveAnimeTitleDisplay(downloadTarget.anime).title}`}
        >
          <AnimeDownloadPanel
            addingReleaseId={addingReleaseId}
            activeTab={downloadResourceTab}
            batchAdding={addingReleaseId === batchAddingReleaseId}
            downloadTasks={downloadTasks}
            errors={animeReleaseErrors}
            fansubNames={fansubNames}
            fansubs={animeFansubs}
            loading={animeReleaseLoading}
            releases={animeReleases}
            rssGroups={animeRssReleaseGroups}
            rssLoading={animeRssReleaseLoading}
            selectedFansubId={animeReleaseFansubId}
            sourceBindingActionKey={sourceBindingActionKey}
            sourceBindingLoading={sourceBindingLoading}
            sourceBindingState={sourceBindingState}
            target={downloadTarget}
            onAddRelease={(release) => void addAnimeReleaseDownload(release)}
            onAddRssSubscription={(subscription) => void addAnimeRssSubscription(subscription)}
            onAddSelected={(releases) => void addAnimeReleaseDownloads(releases)}
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
        </WorkbenchSheet>
      )}

      {downloadDetail && (
        <AnimeDownloadTaskSheet
          detail={downloadDetail}
          downloadTasks={downloadTasks}
          fansubNames={fansubNames}
          onClose={closeDownloadDetail}
          onFilterChange={(filter) =>
            setDownloadDetail((current) => (current ? { ...current, filter } : current))
          }
        />
      )}

      <ConfirmActionDialog
        confirmLabel="移除追番"
        description={removeTarget
          ? `「${resolveAnimeTitleDisplay(removeTarget.anime).title}」及其追番规则将被移除，已下载文件不会被删除。`
          : "该追番及其规则将被移除。"}
        onConfirm={() => removeTarget ? removeItem(removeTarget) : undefined}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        open={Boolean(removeTarget)}
        title="确认移除追番？"
      />

      <ConfirmActionDialog
        confirmLabel="放弃修改"
        description="当前规则尚未保存，关闭后本次修改将丢失。"
        onConfirm={discardRulesDraft}
        onOpenChange={setDiscardRulesDialogOpen}
        open={discardRulesDialogOpen}
        title="放弃未保存的规则？"
      />

    </Page>
  );
}

/** 渲染追番列表加载中的结构化占位状态。 */
function MyAnimePageSkeleton() {
  return (
    <Page aria-busy="true" aria-label="正在加载追番列表">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {["anime-1", "anime-2", "anime-3", "anime-4"].map((item) => (
          <div className="flex gap-4 border p-3" key={item}>
            <Skeleton className="aspect-[2/3] w-16 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-3 py-1">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-2 w-full" />
            </div>
          </div>
        ))}
      </div>
    </Page>
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
  const [activeTab, setActiveTab] = useState<RulesTab>("basic");
  const titleDisplay = resolveAnimeTitleDisplay(draft.anime);

  return (
    <WorkbenchSheet
      description={titleDisplay.subtitle ?? (draftPersisted ? "编辑追番规则" : "创建新的追番")}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onCancel} variant="outline">取消</Button>
          <Button onClick={onSave} disabled={saving}>
            <Save data-icon="inline-start" />
            {saving ? "保存中" : "保存规则"}
          </Button>
        </div>
      }
      headerContent={
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as RulesTab)}>
          <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4">
            <TabsTrigger value="basic">基础信息</TabsTrigger>
            <TabsTrigger value="download">下载偏好</TabsTrigger>
            <TabsTrigger value="rss">RSS 订阅</TabsTrigger>
            <TabsTrigger value="episodes">单集规则</TabsTrigger>
          </TabsList>
        </Tabs>
      }
      onClose={onCancel}
      title={draftPersisted ? `追番规则 · ${titleDisplay.title}` : "添加追番"}
    >
      <div className="flex min-w-0 flex-col gap-4">
        {activeTab !== "episodes" && (
        <RulesPanel
          activeTab={activeTab}
          draft={draft}
          fansubs={fansubs}
          onChange={onChange}
        />
        )}
        {activeTab === "episodes" && (
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
        )}
      </div>
    </WorkbenchSheet>
  );
}

function RulesPanel({
  activeTab,
  draft,
  fansubs,
  onChange
}: {
  activeTab: Exclude<RulesTab, "episodes">;
  draft: MyAnime | null;
  fansubs: FansubGroup[];
  onChange: (item: MyAnime | null) => void;
}) {
  if (!draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>追番规则</CardTitle>
        </CardHeader>
        <CardContent>
          <Empty className="min-h-40 p-4 md:p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SlidersHorizontal />
              </EmptyMedia>
              <EmptyTitle>未选择追番</EmptyTitle>
              <EmptyDescription>选择一部番剧编辑规则，或添加新的追番。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  if (activeTab === "rss") {
    return <RssSubscriptionsEditor draft={draft} onChange={onChange} />;
  }

  return (
    <Card className="border-0 shadow-none">
      <CardHeader className="px-0 pt-0">
        <CardTitle>{activeTab === "basic" ? "基础信息" : "下载偏好"}</CardTitle>
        <CardDescription>
          {activeTab === "basic" ? "维护标题、首播时间和追番状态。" : "设置自动下载、字幕组与技术规格偏好。"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4">
          {activeTab === "basic" ? (
            <>
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
          <div className="grid gap-3 sm:grid-cols-2">
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
            </>
          ) : (
            <>
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
          <div className="grid gap-3 sm:grid-cols-2">
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
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="偏好位深"
              value={draft.preferredBitDepth ? String(draft.preferredBitDepth) : ""}
              options={bitDepthOptions.map((value) => ({
                value: value ? String(value) : "",
                label: value ? `${value}bit` : "不限"
              }))}
              onChange={(value) =>
                onChange({
                  ...draft,
                  preferredBitDepth: value ? Number(value) as VideoBitDepth : undefined
                })
              }
            />
            <SubtitleLanguageToggleField
              label="偏好字幕语言（可多选）"
              value={resolveSubtitleLanguages(draft.preferredSubtitleLanguages, draft.preferredSubtitle)}
              onChange={(value) =>
                onChange({
                  ...draft,
                  preferredSubtitleLanguages: value,
                  preferredSubtitle: undefined
                })
              }
            />
          </div>
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
            </>
          )}
        </FieldGroup>
      </CardContent>
    </Card>
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
        preferredSubtitleLanguages: initial?.preferredSubtitleLanguages,
        preferredSubtitle: initial?.preferredSubtitle,
        refreshIntervalMinutes: initial?.refreshIntervalMinutes ?? defaultRssRefreshIntervalMinutes,
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
    <FieldSet className="gap-4 rounded-md border p-3">
      <FieldLegend className="mb-0">RSS订阅</FieldLegend>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <FieldDescription>可为同一番剧配置多个 RSS 源。</FieldDescription>
        <div className="flex w-full shrink-0 gap-2 sm:w-auto">
          {mikanRssUrl && (
            <Button
              className="min-h-11 min-w-0 flex-1 px-2 sm:min-h-9 sm:flex-none sm:px-3"
              type="button"
              variant="outline"
              onClick={() => addSubscription({ name: "蜜柑计划", url: mikanRssUrl })}
              disabled={subscriptions.some((subscription) => subscription.url === mikanRssUrl)}
            >
              <Rss data-icon="inline-start" />
              蜜柑RSS
            </Button>
          )}
          <Button
            className="min-h-11 min-w-0 flex-1 px-2 sm:min-h-9 sm:flex-none sm:px-3"
            type="button"
            variant="outline"
            onClick={() => addSubscription()}
          >
            <Plus data-icon="inline-start" />
            添加
          </Button>
        </div>
      </div>

      {subscriptions.length > 0 ? (
        <FieldGroup className="gap-3">
          {subscriptions.map((subscription) => (
            <FieldGroup
              className="grid min-w-0 gap-3 rounded-md bg-muted/40 p-3 md:grid-cols-2 xl:grid-cols-3 xl:items-end"
              key={subscription.id}
            >
              <Field orientation="horizontal" className="min-w-0">
                <Checkbox
                  id={`rss-enabled-${subscription.id}`}
                  checked={subscription.enabled}
                  onCheckedChange={(checked) => updateSubscription(subscription.id, { enabled: checked === true })}
                />
                <FieldLabel htmlFor={`rss-enabled-${subscription.id}`}>启用</FieldLabel>
              </Field>
              <Field className="min-w-0">
                <FieldLabel className="sr-only" htmlFor={`rss-name-${subscription.id}`}>订阅名称</FieldLabel>
                <Input
                  id={`rss-name-${subscription.id}`}
                  placeholder="订阅名称"
                  value={subscription.name}
                  onChange={(event) => updateSubscription(subscription.id, { name: event.target.value })}
                />
              </Field>
              <Field className="min-w-0">
                <FieldLabel className="sr-only" htmlFor={`rss-url-${subscription.id}`}>RSS 地址</FieldLabel>
                <Input
                  id={`rss-url-${subscription.id}`}
                  placeholder="RSS 地址"
                  title={subscription.url}
                  value={subscription.url}
                  onChange={(event) => updateSubscription(subscription.id, { url: event.target.value })}
                />
              </Field>
              <SubtitleLanguageToggleField
                label="RSS字幕（留空继承追番）"
                value={resolveSubtitleLanguages(
                  subscription.preferredSubtitleLanguages,
                  subscription.preferredSubtitle
                )}
                onChange={(value) =>
                  updateSubscription(subscription.id, {
                    preferredSubtitleLanguages: value.length > 0 ? value : undefined,
                    preferredSubtitle: undefined
                  })
                }
              />
              <Field className="min-w-0">
                <FieldLabel htmlFor={`rss-interval-${subscription.id}`}>刷新间隔（分钟）</FieldLabel>
                <Input
                  id={`rss-interval-${subscription.id}`}
                  min={1}
                  type="number"
                  value={subscription.refreshIntervalMinutes ?? defaultRssRefreshIntervalMinutes}
                  onChange={(event) =>
                    updateSubscription(subscription.id, {
                      refreshIntervalMinutes: normalizeRssRefreshInterval(Number(event.target.value))
                    })
                  }
                />
              </Field>
              <Button
                className="min-h-11 w-full xl:min-h-9"
                type="button"
                variant="ghost"
                onClick={() => removeSubscription(subscription.id)}
                aria-label="删除RSS订阅"
                title="删除RSS订阅"
              >
                <Trash2 data-icon="inline-start" />
                删除
              </Button>
            </FieldGroup>
          ))}
        </FieldGroup>
      ) : (
        <Empty className="min-h-36 p-4">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Rss />
            </EmptyMedia>
            <EmptyTitle>未配置 RSS 订阅</EmptyTitle>
            <EmptyDescription>添加订阅后可从指定 RSS 获取发布资源。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </FieldSet>
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
  onTabChange,
  onConfirmSourceCandidate,
  onRemoveSourceBinding,
  onRefreshSourceBindings,
  onFansubChange,
  onRefreshRss,
  onRefresh,
  onForceRefresh,
  onAddRelease,
  onAddRssSubscription,
  onAddSelected
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
  onTabChange: (tab: DownloadResourceTab) => void;
  onConfirmSourceCandidate: (candidate: AnimeSourceCandidate) => void;
  onRemoveSourceBinding: (sourceId: string) => void;
  onRefreshSourceBindings: () => void;
  onFansubChange: (fansubGroupId: string) => void;
  onRefreshRss: () => void;
  onRefresh: () => void;
  onForceRefresh: () => void;
  onAddRelease: (release: Release) => void;
  onAddRssSubscription: (subscription: RssSubscriptionDraft) => void;
  onAddSelected: (releases: Release[]) => void;
}) {
  const titleDisplay = resolveAnimeTitleDisplay(target.anime);
  const [groupCollapseOverrides, setGroupCollapseOverrides] = useState<Record<string, boolean>>({});
  const [otherResourcesCollapsed, setOtherResourcesCollapsed] = useState(true);
  const [selectedFamilyKeys, setSelectedFamilyKeys] = useState<Set<string>>(() => new Set());
  const [releaseVersionSelections, setReleaseVersionSelections] = useState<Record<string, string>>({});
  const rssReleases = rssGroups.flatMap((group) => group.releases);
  const tabReleases = activeTab === "rss" ? rssReleases : releases;
  const currentTabReleases = tabReleases.filter((release) => classifyAnimeRelease(release, target.anime) === "current");
  const otherTabReleases = tabReleases.filter((release) => classifyAnimeRelease(release, target.anime) === "other");
  const visibleReleases = filterReleasesByFansub(currentTabReleases, selectedFansubId);
  const visibleOtherReleases = filterReleasesByFansub(otherTabReleases, selectedFansubId);
  const releaseGroups = groupReleasesByFansub(visibleReleases, fansubNames);
  const visibleErrors = activeTab === "rss"
    ? dedupeReleaseErrors(rssGroups.flatMap((group) => group.errors))
    : dedupeReleaseErrors(errors);
  const unknownFansubCount = tabReleases.filter((release) => !release.fansubGroupId).length;
  const activeLoading = activeTab === "rss" ? rssLoading : loading;
  const sourceFailed = currentTabReleases.length === 0 && otherTabReleases.length === 0 && visibleErrors.length > 0;
  const linkedTasks = downloadTasks.filter((task) => task.animeId === target.anime.id);
  const releaseSignature = tabReleases.map(releaseKey).join("|");
  const tabFamilies = groupReleaseVersions(currentTabReleases, target, releaseVersionSelections);
  const visibleFamilies = groupReleaseVersions(visibleReleases, target, releaseVersionSelections);
  const visibleOtherFamilies = groupReleaseVersions(visibleOtherReleases, target, releaseVersionSelections);
  const selectedReleases = visibleFamilies
    .filter((family) => selectedFamilyKeys.has(family.key))
    .map((family) => family.selectedRelease);
  const selectedDownloadableReleases = selectedReleases.filter((release) => isReleaseSelectable(release, linkedTasks, target.anime));
  const selectableVisibleFamilies = visibleFamilies.filter((family) => isReleaseSelectable(family.selectedRelease, linkedTasks, target.anime));
  const allSelectableVisibleSelected = selectableVisibleFamilies.length > 0 &&
    selectableVisibleFamilies.every((family) => selectedFamilyKeys.has(family.key));
  const existingRssUrls = new Set((target.rssSubscriptions ?? []).map((subscription) => subscription.url.trim()).filter(Boolean));

  useEffect(() => {
    setSelectedFamilyKeys(new Set());
    setReleaseVersionSelections({});
  }, [activeTab, releaseSignature]);

  /** 返回分组折叠状态；首次仅展开当前列表第一组。 */
  function isGroupCollapsed(groupKey: string, groupIndex: number): boolean {
    return groupCollapseOverrides[groupKey] ?? groupIndex > 0;
  }

  /** 保存用户对字幕组资源分组的展开或折叠选择。 */
  function toggleGroup(groupKey: string, collapsed: boolean) {
    setGroupCollapseOverrides((current) => ({
      ...current,
      [groupKey]: !collapsed
    }));
  }

  /** 切换某个资源族的批量选择状态。 */
  function toggleFamilySelection(family: ReleaseVersionFamily) {
    setSelectedFamilyKeys((current) => {
      const next = new Set(current);
      if (next.has(family.key)) {
        next.delete(family.key);
      } else {
        next.add(family.key);
      }
      return next;
    });
  }

  /** 变更同一资源族内最终下载的语言版本。 */
  function selectReleaseVersion(familyKey: string, nextReleaseKey: string) {
    setReleaseVersionSelections((current) => ({
      ...current,
      [familyKey]: nextReleaseKey
    }));
  }

  /** 选择或取消当前筛选下所有可下载资源。 */
  function toggleAllVisibleReleases() {
    setSelectedFamilyKeys((current) => {
      const next = new Set(current);
      const selectableKeys = selectableVisibleFamilies.map((family) => family.key);
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

  /** 选择或取消指定分组下所有可下载资源。 */
  function toggleGroupFamilies(families: ReleaseVersionFamily[]) {
    const selectableKeys = families
      .filter((family) => isReleaseSelectable(family.selectedRelease, linkedTasks, target.anime))
      .map((family) => family.key);
    setSelectedFamilyKeys((current) => {
      const next = new Set(current);
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

  /** 统计指定分组的可选和已选资源数量。 */
  function getGroupSelectionState(families: ReleaseVersionFamily[]) {
    const selectable = families.filter((family) => isReleaseSelectable(family.selectedRelease, linkedTasks, target.anime));
    const selectedCount = selectable.filter((family) => selectedFamilyKeys.has(family.key)).length;
    return {
      selectableCount: selectable.length,
      selectedCount,
      allSelected: selectable.length > 0 && selectedCount === selectable.length
    };
  }

  /** 按集数渲染资源族，并保留批量选择能力。 */
  function renderEpisodeGroups(groupReleases: Release[], batchSelectable = true) {
    const families = groupReleaseVersions(groupReleases, target, releaseVersionSelections);
    return groupReleaseFamilyEpisodes(families).map((episodeGroup) => (
      <section key={episodeGroup.key}>
        <div className="flex items-center justify-between bg-muted/30 px-3 py-2 text-xs">
          <span className="font-medium" title={episodeGroup.label}>
            {episodeGroup.label}
          </span>
          <span className="text-muted-foreground">{episodeGroup.families.length} 个资源</span>
        </div>
        <div className="divide-y border-t">
          {episodeGroup.families.map((family) => {
            const linkedTask = findReleaseDownloadTask(linkedTasks, family.selectedRelease);
            return (
              <ReleaseDownloadRow
                key={family.key}
                addingReleaseId={addingReleaseId}
                batchSelectable={batchSelectable}
                fansubNames={fansubNames}
                family={family}
                linkedTask={linkedTask}
                preferences={target}
                selected={selectedFamilyKeys.has(family.key)}
                onAddRelease={onAddRelease}
                onToggleSelected={toggleFamilySelection}
                onVersionChange={selectReleaseVersion}
              />
            );
          })}
        </div>
      </section>
    ));
  }

  return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 [@media(max-height:760px)]:gap-2">
        <div className="grid shrink-0 items-center gap-2 md:grid-cols-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium" title={titleDisplay.title}>
              {titleDisplay.title}
            </div>
            {titleDisplay.subtitle && (
              <div
                className="mt-1 truncate text-xs text-muted-foreground [@media(max-height:760px)]:hidden"
                title={titleDisplay.subtitle}
              >
                {titleDisplay.subtitle}
              </div>
            )}
          </div>
          <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as DownloadResourceTab)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="rss">RSS订阅</TabsTrigger>
              <TabsTrigger value="search">资源搜索</TabsTrigger>
            </TabsList>
          </Tabs>
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

        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-end">
          <Field className="min-w-0 sm:flex-1">
            <FieldLabel className="sr-only" htmlFor="anime-release-fansub-filter">字幕组筛选</FieldLabel>
            <Select
              value={selectedFansubId || emptySelectValue}
              onValueChange={(value) => onFansubChange(value === emptySelectValue ? "" : value)}
            >
              <SelectTrigger id="anime-release-fansub-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={emptySelectValue}>全部字幕组（{tabReleases.length}）</SelectItem>
                  {fansubs.map((group) => {
                    const count = countReleasesByFansub(tabReleases, group.id);
                    return (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}{count > 0 ? `（${count}）` : ""}
                      </SelectItem>
                    );
                  })}
                  {unknownFansubCount > 0 && (
                    <SelectItem value={unknownFansubFilter}>未识别字幕组（{unknownFansubCount}）</SelectItem>
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            {activeTab === "rss" ? (
              <Button
                className="col-span-2 min-h-11 shrink-0 sm:min-h-9"
                variant="outline"
                onClick={onRefreshRss}
                disabled={rssLoading}
              >
                <RefreshCw data-icon="inline-start" />
                {rssLoading ? "读取中" : "刷新RSS"}
              </Button>
            ) : (
              <>
                <Button className="min-h-11 shrink-0 sm:min-h-9" variant="outline" onClick={onRefresh} disabled={loading}>
                  <Search data-icon="inline-start" />
                  {loading ? "查询中" : "刷新"}
                </Button>
                <Button
                  className="min-h-11 shrink-0 px-2 sm:min-h-9 sm:px-3"
                  variant="outline"
                  onClick={onForceRefresh}
                  disabled={loading}
                  aria-label="强制刷新"
                  title="绕过 1 天缓存重新查询下载源"
                >
                  <RefreshCw data-icon="inline-start" />
                  <span className="hidden sm:inline">强制刷新</span>
                </Button>
              </>
            )}
          </div>
        </div>

        <BatchDownloadControls
          allSelected={allSelectableVisibleSelected}
          batchAdding={batchAdding}
          disabled={activeLoading}
          selectedCount={selectedDownloadableReleases.length}
          selectableCount={selectableVisibleFamilies.length}
          totalCount={tabFamilies.length}
          visibleCount={visibleFamilies.length}
          onAddSelected={() => onAddSelected(selectedDownloadableReleases)}
          onToggleAll={toggleAllVisibleReleases}
        />

        {activeTab === "search" && visibleErrors.length > 0 && (
          <div className="flex flex-col gap-2">
            {visibleErrors.slice(0, 3).map((error, index) => (
              <Alert key={`${error.sourceId}-${index}`}>
                <AlertTitle>{error.sourceId}</AlertTitle>
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            ))}
          </div>
        )}

        {activeLoading ? (
          <div className="flex flex-col gap-3 py-2" aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <span className="sr-only">{activeTab === "rss" ? "正在读取 RSS 订阅" : "正在查询发布资源"}</span>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 auto-rows-max content-start gap-3 overflow-y-auto pr-1">
            {activeTab === "rss"
              ? rssGroups.map((group, groupIndex) => {
                  const groupKey = `rss:${group.subscription.id}`;
                  const collapsed = isGroupCollapsed(groupKey, groupIndex);
                  const groupReleases = filterReleasesByFansub(
                    group.releases.filter((release) => classifyAnimeRelease(release, target.anime) === "current"),
                    selectedFansubId
                  );
                  const groupFamilies = groupReleaseVersions(groupReleases, target, releaseVersionSelections);
                  const selection = getGroupSelectionState(groupFamilies);
                  return (
                    <section key={group.subscription.id} className="shrink-0 overflow-hidden rounded-md border bg-background">
                      <ReleaseGroupHeader
                        allSelected={selection.allSelected}
                        badgeText={`${groupFamilies.length} 个资源`}
                        collapsed={collapsed}
                        episodeCount={countReleaseFamilyEpisodes(groupFamilies)}
                        name={group.subscription.name}
                        rssSubscribed={false}
                        selectableCount={selection.selectableCount}
                        selectedCount={selection.selectedCount}
                        title={group.subscription.url}
                        onAddRssSubscription={onAddRssSubscription}
                        onToggleCollapsed={() => toggleGroup(groupKey, collapsed)}
                        onToggleSelected={() => toggleGroupFamilies(groupFamilies)}
                      />
                      {!collapsed && (
                        <div>
                          {group.errors.length > 0 && (
                            <div className="flex flex-col gap-2 border-b p-3">
                              {group.errors.map((error, index) => (
                                <Alert key={`${error.sourceId}-${index}`}>
                                  <AlertTitle>{group.subscription.name}</AlertTitle>
                                  <AlertDescription>{error.message}</AlertDescription>
                                </Alert>
                              ))}
                            </div>
                          )}
                          {groupReleases.length > 0 ? (
                            <div className="divide-y">{renderEpisodeGroups(groupReleases)}</div>
                          ) : (
                            <Empty className="m-3 min-h-36 p-4">
                              <EmptyHeader>
                                <EmptyMedia variant="icon"><Rss /></EmptyMedia>
                                <EmptyTitle>暂无匹配资源</EmptyTitle>
                                <EmptyDescription>当前订阅没有匹配资源。</EmptyDescription>
                              </EmptyHeader>
                            </Empty>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })
              : releaseGroups.map((group, groupIndex) => {
                  const groupFamilies = groupReleaseVersions(group.releases, target, releaseVersionSelections);
                  const selection = getGroupSelectionState(groupFamilies);
                  const rssCandidate = buildMikanGroupRssSubscription(group, target);
                  const rssSubscribed = Boolean(rssCandidate && existingRssUrls.has(rssCandidate.url));
                  const collapsed = isGroupCollapsed(group.key, groupIndex);
                  return (
                    <section key={group.key} className="shrink-0 overflow-hidden rounded-md border bg-background">
                      <ReleaseGroupHeader
                        allSelected={selection.allSelected}
                        badgeText={`${groupFamilies.length} 个资源`}
                        collapsed={collapsed}
                        episodeCount={countReleaseFamilyEpisodes(groupFamilies)}
                        name={group.name}
                        rssCandidate={rssCandidate}
                        rssSubscribed={rssSubscribed}
                        selectableCount={selection.selectableCount}
                        selectedCount={selection.selectedCount}
                        title={group.name}
                        onAddRssSubscription={onAddRssSubscription}
                        onToggleCollapsed={() => toggleGroup(group.key, collapsed)}
                        onToggleSelected={() => toggleGroupFamilies(groupFamilies)}
                      />
                      {!collapsed && <div className="divide-y">{renderEpisodeGroups(group.releases)}</div>}
                    </section>
                  );
                })}

            {visibleReleases.length === 0 && visibleOtherReleases.length === 0 && (
              sourceFailed ? (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertTitle>资源获取失败</AlertTitle>
                  <AlertDescription>
                    {activeTab === "rss"
                      ? "RSS 订阅请求失败，暂时无法获取发布资源。"
                      : "下载源请求失败，暂时无法获取发布资源和字幕组文件信息。"}
                  </AlertDescription>
                </Alert>
              ) : (
                <Empty className="min-h-44 p-4 md:p-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><Search /></EmptyMedia>
                    <EmptyTitle>暂无可下载资源</EmptyTitle>
                    <EmptyDescription>
                      {selectedFansubId
                        ? "当前字幕组没有可下载资源。"
                        : activeTab === "rss"
                          ? "没有找到 RSS 订阅资源，或尚未配置启用的 RSS 订阅。"
                          : "没有找到可下载资源。"}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )
            )}

            {visibleOtherReleases.length > 0 && (
              <section className="shrink-0 overflow-hidden rounded-md border bg-background">
                <Button
                  className="h-auto min-h-11 w-full justify-between rounded-none px-3 py-2 text-left md:min-h-11"
                  type="button"
                  variant="secondary"
                  onClick={() => setOtherResourcesCollapsed((current) => !current)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {otherResourcesCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    <span className="font-medium">其他资源</span>
                    <Badge>{visibleOtherFamilies.length} 个资源</Badge>
                  </span>
                  <span className="text-xs text-muted-foreground">季度待确认</span>
                </Button>
                {!otherResourcesCollapsed && (
                  <div className="divide-y border-t">{renderEpisodeGroups(visibleOtherReleases, false)}</div>
                )}
              </section>
            )}

          </div>
        )}
        </div>
  );
}

/** 渲染资源列表顶部的整体批量选择与下载操作。 */
function BatchDownloadControls({
  visibleCount,
  totalCount,
  selectedCount,
  selectableCount,
  allSelected,
  batchAdding,
  disabled,
  onToggleAll,
  onAddSelected
}: {
  visibleCount: number;
  totalCount: number;
  selectedCount: number;
  selectableCount: number;
  allSelected: boolean;
  batchAdding: boolean;
  disabled: boolean;
  onToggleAll: () => void;
  onAddSelected: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col items-stretch gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>显示 {visibleCount} 组</span>
        <span>共 {totalCount} 组</span>
        <span>已选 {selectedCount} 组</span>
      </div>
      <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
        <Button
          className="min-h-11 px-2 sm:min-h-9 sm:px-3"
          variant="outline"
          onClick={onToggleAll}
          disabled={selectableCount === 0 || disabled}
        >
          {allSelected ? "取消全选" : "全选可下载"}
        </Button>
        <Button className="min-h-11 sm:min-h-9" onClick={onAddSelected} disabled={selectedCount === 0 || batchAdding || disabled}>
          <Download data-icon="inline-start" />
          {batchAdding ? "添加中" : "批量下载"}
        </Button>
      </div>
    </div>
  );
}

/** 渲染资源分组标题，并承载分组全选和可用 RSS 订阅操作。 */
function ReleaseGroupHeader({
  name,
  title,
  badgeText,
  episodeCount,
  selectedCount,
  selectableCount,
  allSelected,
  collapsed,
  rssCandidate,
  rssSubscribed,
  onToggleCollapsed,
  onToggleSelected,
  onAddRssSubscription
}: {
  name: string;
  title: string;
  badgeText: string;
  episodeCount: number;
  selectedCount: number;
  selectableCount: number;
  allSelected: boolean;
  collapsed: boolean;
  rssCandidate?: RssSubscriptionDraft;
  rssSubscribed: boolean;
  onToggleCollapsed: () => void;
  onToggleSelected: () => void;
  onAddRssSubscription: (subscription: RssSubscriptionDraft) => void;
}) {
  return (
    <div className="flex w-full flex-wrap items-center gap-2 border-b bg-muted/70 px-3 py-2">
      <Button
        className="h-auto min-h-11 min-w-0 flex-1 justify-start px-0 py-0 text-left md:min-h-0"
        type="button"
        variant="ghost"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        title={title}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-sm font-semibold">{name}</span>
        <Badge>{badgeText}</Badge>
      </Button>
      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-muted-foreground">已选 {selectedCount}/{selectableCount}</span>
        {rssCandidate && (
          <Button
            className="h-11 px-2 text-xs sm:h-7"
            variant="outline"
            onClick={() => onAddRssSubscription(rssCandidate)}
            disabled={rssSubscribed}
            title={rssSubscribed ? "该字幕组 RSS 已订阅" : rssCandidate.url}
          >
            <Rss data-icon="inline-start" />
            {rssSubscribed ? "已订阅" : "订阅RSS"}
          </Button>
        )}
        <Button
          className="h-11 px-2 text-xs sm:h-7"
          variant="outline"
          onClick={onToggleSelected}
          disabled={selectableCount === 0}
        >
          {allSelected ? "取消全选" : "全选"}
        </Button>
        <span className="min-w-8 text-right text-xs text-muted-foreground">{episodeCount} 集</span>
      </div>
    </div>
  );
}

/** 渲染合并后的资源族行，并提供语言版本选择。 */
function ReleaseDownloadRow({
  family,
  linkedTask,
  batchSelectable,
  fansubNames,
  preferences,
  selected,
  addingReleaseId,
  onToggleSelected,
  onAddRelease,
  onVersionChange
}: {
  family: ReleaseVersionFamily;
  linkedTask?: DownloadTask;
  batchSelectable: boolean;
  fansubNames: Map<string, string>;
  preferences: MyAnime;
  selected: boolean;
  addingReleaseId: string | null;
  onToggleSelected: (family: ReleaseVersionFamily) => void;
  onAddRelease: (release: Release) => void;
  onVersionChange: (familyKey: string, releaseKey: string) => void;
}) {
  const release = family.selectedRelease;
  const canDownload = Boolean(release.magnetUrl ?? release.torrentUrl);
  const selectable = canDownload && !linkedTask && batchSelectable;

  return (
    <div className="p-2 sm:p-3 [@media(max-height:760px)]:p-2">
      <div className="flex items-start justify-between gap-2 sm:gap-3">
        <Checkbox
          className="mt-0.5"
          aria-label={`选择资源 ${release.title}`}
          checked={selected}
          disabled={!selectable}
          onCheckedChange={() => onToggleSelected(family)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium" title={release.title}>
              {release.title}
            </div>
            <div className="mt-1 flex flex-wrap gap-2">
              <Badge tone="blue">{release.sourceName}</Badge>
              <Badge>{getReleaseFansubName(release, fansubNames)}</Badge>
              <Badge>{family.episodeLabel}</Badge>
              {!batchSelectable && <Badge tone="amber">季度待确认</Badge>}
              <ReleaseMetadataBadges metadata={release} />
              {release.size && <Badge>{formatBytes(release.size)}</Badge>}
              {linkedTask && (
                <Badge tone={isCompletedDownload(linkedTask) ? "green" : "amber"}>
                  {downloadStatusText[linkedTask.status]}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex min-w-0 flex-col items-start gap-2 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center">
            <span title={release.publishedAt}>{formatReleaseDate(release.publishedAt)}</span>
            {family.releases.length > 1 && (
              <>
                <span className="hidden sm:inline">·</span>
                <Select
                  value={releaseKey(release)}
                  onValueChange={(value) => onVersionChange(family.key, value)}
                >
                  <SelectTrigger className="h-8 w-full min-w-0 text-xs sm:w-72" aria-label="选择资源版本" title="选择资源版本">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {family.releases.map((item) => {
                        const itemKey = releaseKey(item);
                        return (
                          <SelectItem key={itemKey} value={itemKey}>
                            {getReleaseVersionLabel(item, preferences, releaseKey(item) === releaseKey(release))}
                          </SelectItem>
                        );
                      })}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </>
            )}
          </div>
        </div>
        <Button
          className="min-h-11 shrink-0 px-2 sm:min-h-9 sm:px-3"
          variant="outline"
          onClick={() => onAddRelease(release)}
          disabled={!canDownload || Boolean(linkedTask) || addingReleaseId === release.id || addingReleaseId === batchAddingReleaseId}
          aria-label={linkedTask ? "已加入下载" : "添加下载"}
          title={linkedTask ? "已加入下载" : "添加下载"}
        >
          <Download data-icon="inline-start" />
          <span className="hidden sm:inline">
            {linkedTask ? "已加入" : addingReleaseId === release.id ? "添加中" : "添加下载"}
          </span>
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
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!loading && confirmedBindings.length === 0 && (groupedCandidates.length > 0 || state?.errors.length)) {
      setExpanded(true);
    }
  }, [confirmedBindings.length, groupedCandidates.length, loading, state?.errors.length]);

  return (
    <section className="shrink-0 overflow-hidden rounded-md border bg-background">
      <div className={cn("flex min-h-10 items-center justify-between bg-muted/50 pl-1 pr-2", expanded && "border-b")}>
        <Button
          className="h-auto min-h-10 min-w-0 flex-1 justify-start px-2 py-2 text-left md:min-h-10"
          type="button"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0">来源匹配</span>
          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {confirmedBindings.slice(0, 2).map((binding) => (
              <Badge key={binding.sourceId} className="max-w-32 truncate" tone="green">
                {binding.sourceId} 已绑定
              </Badge>
            ))}
            {confirmedBindings.length > 2 && <Badge tone="green">+{confirmedBindings.length - 2}</Badge>}
            {groupedCandidates.length > 0 && <Badge tone="amber">{groupedCandidates.length} 个待确认</Badge>}
            {!hasContent && !loading && <span className="truncate text-xs font-normal text-muted-foreground">暂无精确匹配</span>}
            {loading && <span className="truncate text-xs font-normal text-muted-foreground">读取中</span>}
          </span>
        </Button>
        <Button variant="ghost" onClick={onRefresh} disabled={loading} title="重新读取来源候选" aria-label="重新读取来源候选">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>
      {expanded && (loading && !hasContent ? (
        <div className="flex flex-col gap-2 px-3 py-4" aria-label="正在匹配来源番剧">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
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
              <div className="flex flex-col gap-2">
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
                    <div className="mt-2 flex flex-col gap-2">
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
            <div key={`${error.sourceId}:${error.message}`} className="px-3 py-2">
              <Alert>
                <AlertTitle>{error.sourceId}</AlertTitle>
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-4 text-sm text-muted-foreground">没有启用支持精确匹配的来源。</div>
      ))}
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
      <Card>
        <CardHeader>
          <CardTitle>单集规则</CardTitle>
        </CardHeader>
        <CardContent>
          <Empty className="min-h-40 p-4 md:p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><SlidersHorizontal /></EmptyMedia>
              <EmptyTitle>未选择追番</EmptyTitle>
              <EmptyDescription>选择一部番剧后可管理每集的字幕组覆盖。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  if (!persisted) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>单集规则</CardTitle>
        </CardHeader>
        <CardContent>
          <Empty className="min-h-40 p-4 md:p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Save /></EmptyMedia>
              <EmptyTitle>请先保存追番</EmptyTitle>
              <EmptyDescription>新追番需要先保存，之后才能添加单集规则。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>单集规则</CardTitle>
          <CardDescription className="mt-1">
            不设置时跟随番剧默认字幕组；设置后这一集会优先使用覆盖字幕组。
          </CardDescription>
        </div>
        <Button className="min-h-11 w-full sm:min-h-9 sm:w-auto" variant="outline" onClick={onAddEpisode}>
          <Plus data-icon="inline-start" />
          添加下一集
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="正在加载单集规则">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
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
                <FieldGroup className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field className="min-w-0">
                    <FieldLabel htmlFor={`episode-status-${episode.id}`}>单集状态</FieldLabel>
                    <Select
                      value={episode.status}
                      onValueChange={(value) => onStatusChange(episode, value as EpisodeStatus)}
                    >
                      <SelectTrigger id={`episode-status-${episode.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {episodeStatusOptions.map(([value, label]) => (
                            <SelectItem key={value} value={value}>{label}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field className="min-w-0">
                    <FieldLabel htmlFor={`episode-fansub-${episode.id}`}>字幕组覆盖</FieldLabel>
                    <Select
                      value={preference?.fansubGroupId ?? emptySelectValue}
                      onValueChange={(value) => onFansubChange(episode, value === emptySelectValue ? "" : value)}
                    >
                      <SelectTrigger id={`episode-fansub-${episode.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={emptySelectValue}>跟随默认：{inheritedFansub}</SelectItem>
                          {fansubs.map((group) => (
                            <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
                <div className="mt-3 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-xs text-muted-foreground">
                    {preview ? `候选 ${preview.candidates.length} 个` : "尚未匹配资源"}
                  </div>
                  <Button
                    className="min-h-11 w-full sm:min-h-9 sm:w-auto"
                    variant="outline"
                    onClick={() => onPreviewReleases(episode)}
                    disabled={previewingEpisodeId === episode.id}
                  >
                    <Search data-icon="inline-start" />
                    {previewingEpisodeId === episode.id ? "查询中" : "查看发布"}
                  </Button>
                </div>
                {preference?.fansubGroupId && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    当前覆盖：{fansubNames.get(preference.fansubGroupId) ?? preference.fansubGroupId}
                  </div>
                )}
                {preview && (
                  <div className="mt-3 flex flex-col gap-2">
                    {preview.candidates.slice(0, 6).map((candidate) => (
                      <div key={candidate.release.id} className="rounded-md bg-muted p-3">
                        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{candidate.release.title}</div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Badge tone="blue">{candidate.score} 分</Badge>
                              <Badge>匹配 {candidate.matchScore}/50</Badge>
                              <Badge>偏好 {candidate.preferenceScore}/40</Badge>
                              <Badge>{candidate.release.sourceName}</Badge>
                              <Badge>第 {candidate.release.episodeNo ?? episode.episodeNo} 集</Badge>
                              <Badge>{getReleaseFansubName(candidate.release, fansubNames)}</Badge>
                              <ReleaseMetadataBadges metadata={candidate.release} />
                              {candidate.release.size && <Badge>{formatBytes(candidate.release.size)}</Badge>}
                              {typeof candidate.release.seeders === "number" && (
                                <Badge tone={candidate.release.seeders > 0 ? "green" : "neutral"}>
                                  {candidate.release.seeders} 做种
                                </Badge>
                              )}
                            </div>
                            <div className="mt-2 text-xs text-muted-foreground">
                              {[...candidate.reasons, ...candidate.warnings.map((warning) => `注意：${warning}`)].join("，") || "规则匹配"}
                            </div>
                          </div>
                          <Button
                            className="min-h-11 w-full shrink-0 sm:min-h-9 sm:w-auto"
                            variant="outline"
                            onClick={() => onAddRelease(episode, candidate.release)}
                            disabled={addingReleaseId === candidate.release.id}
                          >
                            <Download data-icon="inline-start" />
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
              <Empty className="min-h-40 p-4 md:p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Plus /></EmptyMedia>
                  <EmptyTitle>暂无单集规则</EmptyTitle>
                  <EmptyDescription>还没有单集，添加后可为每集设置字幕组。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        )}
      </CardContent>
    </Card>
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
      preferredSubtitleLanguages: resolveSubtitleLanguages(
        subscription.preferredSubtitleLanguages,
        subscription.preferredSubtitle
      ),
      preferredSubtitle: undefined,
      refreshIntervalMinutes: normalizeRssRefreshInterval(subscription.refreshIntervalMinutes),
      lastFetchedAt: subscription.lastFetchedAt,
      createdAt: subscription.createdAt || timestamp,
      updatedAt: timestamp
    }))
    .filter((subscription) => subscription.url);
}

/** 规范化 RSS 自动下载刷新间隔，空值使用默认 20 分钟。 */
function normalizeRssRefreshInterval(value?: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return defaultRssRefreshIntervalMinutes;
  }

  return Math.max(1, Math.round(value));
}

/** 根据番剧的 Mikan 外部 ID 生成蜜柑计划 RSS 地址。 */
function buildMikanRssUrl(item: MyAnime): string | undefined {
  const mikanId = item.anime.externalIds.mikan?.trim();
  return mikanId ? `https://mikanani.me/RSS/Bangumi?bangumiId=${encodeURIComponent(mikanId)}` : undefined;
}

/** 构造追番资源添加下载时需要的关联参数。 */
function buildAnimeReleaseDownloadInput(
  release: Release,
  target: MyAnime
): AddReleaseDownloadInput {
  return {
    release: {
      ...release,
      animeId: target.anime.id
    },
    animeId: target.anime.id,
    episodeNo: release.episodeNo,
    fansubGroupId: release.fansubGroupId,
    savePath: target.downloadDir
  };
}

/** 按稳定 ID 合并全局名称快照和当前番剧字幕组。 */
function mergeFansubGroups(...collections: FansubGroup[][]): FansubGroup[] {
  const groups = new Map<string, FansubGroup>();
  for (const group of collections.flat()) {
    groups.set(group.id, group);
  }
  return [...groups.values()];
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

/** 从 Mikan 资源元信息生成字幕组级 RSS 订阅候选。 */
function buildMikanGroupRssSubscription(group: ReleaseFansubGroup, target: MyAnime): RssSubscriptionDraft | undefined {
  const release = group.releases.find((item) => item.sourceMeta?.mikanSubgroupId);
  const mikanBangumiId = release?.sourceMeta?.mikanBangumiId ?? target.anime.externalIds.mikan?.trim();
  const mikanSubgroupId = release?.sourceMeta?.mikanSubgroupId;
  if (!mikanBangumiId || !mikanSubgroupId) {
    return undefined;
  }

  return {
    name: `蜜柑 · ${release.sourceMeta?.mikanSubgroupName ?? group.name}`,
    url:
      release.sourceMeta?.rssUrl ??
      `https://mikanani.me/RSS/Bangumi?bangumiId=${encodeURIComponent(mikanBangumiId)}&subgroupid=${encodeURIComponent(mikanSubgroupId)}`
  };
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

function getReleaseFansubName(release: Release, fansubNames: Map<string, string>): string {
  if (!release.fansubGroupId) {
    return release.fansubName ?? "未识别字幕组";
  }

  return fansubNames.get(release.fansubGroupId) ?? release.fansubName ?? release.fansubGroupId;
}

function formatReleaseDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

/** 渲染带标签的单行文本字段。 */
function TextField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** 渲染带标签的多行文本字段。 */
function TextareaField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** 渲染带范围约束的数字字段。 */
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
  const id = useId();

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        max={max}
        min={min}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}

/** 渲染带标签的受控选择字段。 */
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
  const id = useId();

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value || emptySelectValue}
        onValueChange={(nextValue) => onChange(nextValue === emptySelectValue ? "" : nextValue)}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value || "empty"} value={option.value || emptySelectValue}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

/** 序列化规则草稿，用于判断侧栏是否存在未保存修改。 */
function serializeMyAnimeDraft(item: MyAnime): string {
  return JSON.stringify(item);
}

/** 使用 shadcn ToggleGroup 编辑可多选的字幕语言偏好。 */
function SubtitleLanguageToggleField({
  label,
  value,
  onChange
}: {
  label: string;
  value: SubtitleLanguage[];
  onChange: (value: SubtitleLanguage[]) => void;
}) {
  const labelId = useId();
  return (
    <Field className="min-w-0">
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <ToggleGroup
        className="flex w-full flex-wrap justify-start"
        type="multiple"
        variant="outline"
        value={value}
        onValueChange={(nextValue) => onChange(nextValue as SubtitleLanguage[])}
        aria-labelledby={labelId}
      >
        {subtitleOptions.map((language) => (
          <ToggleGroupItem key={language} value={language} aria-label={subtitleLanguageText[language]}>
            {subtitleLanguageText[language]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
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
    preferredSubtitleLanguages: ["chs"],
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
