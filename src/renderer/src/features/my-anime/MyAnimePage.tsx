import { Download, Plus, Save, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appApi } from "@/lib/api";
import { formatBytes, formatMonth, formatPercent } from "@/lib/format";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
import type { EpisodeReleasePreview, ReleaseSearchResult } from "@shared/contracts";
import type {
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

export function MyAnimePage() {
  const [items, setItems] = useState<MyAnime[]>([]);
  const [fansubs, setFansubs] = useState<FansubGroup[]>([]);
  const [draft, setDraft] = useState<MyAnime | null>(null);
  const [downloadTarget, setDownloadTarget] = useState<MyAnime | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodePreferences, setEpisodePreferences] = useState<EpisodePreference[]>([]);
  const [downloadTasks, setDownloadTasks] = useState<DownloadTask[]>([]);
  const [releasePreviews, setReleasePreviews] = useState<Record<string, EpisodeReleasePreview>>({});
  const [animeReleases, setAnimeReleases] = useState<Release[]>([]);
  const [animeReleaseErrors, setAnimeReleaseErrors] = useState<ReleaseSearchResult["errors"]>([]);
  const [animeReleaseFansubId, setAnimeReleaseFansubId] = useState("");
  const [animeReleaseLoading, setAnimeReleaseLoading] = useState(false);
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
    setDraft(null);
    setDownloadTarget(target);
    setAnimeReleaseFansubId(target.defaultFansubGroupId ?? "");
    await searchAnimeReleases(target);
  }

  function closeAnimeDownloads() {
    setDownloadTarget(null);
    setAnimeReleases([]);
    setAnimeReleaseErrors([]);
    setAnimeReleaseFansubId("");
  }

  async function searchAnimeReleases(target = downloadTarget) {
    if (!target) {
      return;
    }

    const terms = buildSearchTerms(target);
    if (terms.length === 0) {
      setAnimeReleases([]);
      setAnimeReleaseErrors([]);
      return;
    }

    setAnimeReleaseLoading(true);
    try {
      const results = await Promise.all(
        terms.map((keyword) =>
          appApi.searchReleases({
            keyword,
            animeId: target.anime.id,
            preferredResolution: target.preferredResolution,
            limit: 80
          })
        )
      );
      const releases = sortReleases(
        dedupeReleases(results.flatMap((result) => result.releases)).map((release) => ({
          ...release,
          animeId: target.anime.id
        }))
      );
      const errors = dedupeReleaseErrors(results.flatMap((result) => result.errors));
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
      const updatedDownloads = await appApi.addReleaseDownload({
        release: {
          ...release,
          animeId: downloadTarget.anime.id
        },
        animeId: downloadTarget.anime.id,
        episodeNo: release.episodeNo,
        fansubGroupId:
          release.fansubGroupId ??
          (animeReleaseFansubId && animeReleaseFansubId !== unknownFansubFilter ? animeReleaseFansubId : undefined) ??
          downloadTarget.defaultFansubGroupId,
        savePath: downloadTarget.downloadDir
      });
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

      <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)] items-start gap-5">
        <Panel>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-muted text-left text-xs uppercase tracking-normal text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">番剧</th>
                  <th className="px-4 py-3 font-medium">首播年月</th>
                  <th className="px-4 py-3 font-medium">默认字幕组</th>
                  <th className="px-4 py-3 font-medium">自动下载</th>
                  <th className="px-4 py-3 font-medium">偏好</th>
                  <th className="px-4 py-3 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const titleDisplay = resolveAnimeTitleDisplay(item.anime);

                  return (
                    <tr key={item.id} className="border-t">
                      <td className="px-4 py-4">
                        <div className="font-medium">{titleDisplay.title}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{titleDisplay.subtitle ?? "无原名"}</div>
                      </td>
                      <td className="px-4 py-4">{formatMonth(item.anime.premiereYear, item.anime.premiereMonth)}</td>
                      <td className="px-4 py-4">{fansubNames.get(item.defaultFansubGroupId ?? "") ?? "未设置"}</td>
                      <td className="px-4 py-4">
                        <Badge tone={item.autoDownload ? "green" : "neutral"}>
                          {item.autoDownload ? "已开启" : "未开启"}
                        </Badge>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex flex-wrap gap-2">
                            {item.status && <Badge>{statusText[item.status]}</Badge>}
                            {item.preferredResolution && <Badge>{item.preferredResolution}</Badge>}
                            {item.preferredCodec && <Badge tone="blue">{item.preferredCodec}</Badge>}
                          </div>
                          <Button className="shrink-0" variant="outline" onClick={() => void openAnimeDownloads(item)}>
                            <Download className="h-4 w-4" />
                            下载
                          </Button>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            onClick={() => {
                              closeAnimeDownloads();
                              setDraft(cloneMyAnime(item));
                            }}
                          >
                            <SlidersHorizontal className="h-4 w-4" />
                            规则
                          </Button>
                          <Button variant="outline" onClick={() => void removeItem(item)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {items.length === 0 && (
            <div className="mt-4 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              当前还没有追番。
            </div>
          )}
        </Panel>

        <div className="space-y-5">
          {downloadTarget ? (
            <AnimeDownloadPanel
              addingReleaseId={addingReleaseId}
              errors={animeReleaseErrors}
              fansubNames={fansubNames}
              fansubs={fansubs}
              loading={animeReleaseLoading}
              releases={animeReleases}
              selectedFansubId={animeReleaseFansubId}
              target={downloadTarget}
              onAddRelease={(release) => void addAnimeReleaseDownload(release)}
              onClose={closeAnimeDownloads}
              onFansubChange={setAnimeReleaseFansubId}
              onRefresh={() => void searchAnimeReleases()}
            />
          ) : (
            <>
              <RulesPanel
                draft={draft}
                fansubs={fansubs}
                saving={saving}
                onChange={setDraft}
                onCancel={() => setDraft(null)}
                onSave={() => void saveDraft()}
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
                onAddEpisode={() => void addNextEpisode()}
                onStatusChange={(episode, status) => void updateEpisodeStatus(episode, status)}
                onFansubChange={(episode, fansubGroupId) => void updateEpisodeFansub(episode, fansubGroupId)}
                onPreviewReleases={(episode) => void previewEpisodeReleases(episode)}
                onAddRelease={(episode, release) => void addEpisodeReleaseDownload(episode, release)}
              />
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {statusOptions.map(([status, label]) => {
          const count = items.filter((item) => item.status === status).length;
          return (
            <Panel key={status} className="p-4">
              <div className="text-2xl font-semibold">{count}</div>
              <div className="mt-1 text-sm text-muted-foreground">{label}</div>
            </Panel>
          );
        })}
      </div>
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
        <Button className="w-full" onClick={onSave} disabled={saving}>
          <Save className="h-4 w-4" />
          {saving ? "保存中" : "保存规则"}
        </Button>
      </div>
    </Panel>
  );
}

function AnimeDownloadPanel({
  target,
  releases,
  errors,
  fansubs,
  fansubNames,
  selectedFansubId,
  loading,
  addingReleaseId,
  onFansubChange,
  onRefresh,
  onAddRelease,
  onClose
}: {
  target: MyAnime;
  releases: Release[];
  errors: ReleaseSearchResult["errors"];
  fansubs: FansubGroup[];
  fansubNames: Map<string, string>;
  selectedFansubId: string;
  loading: boolean;
  addingReleaseId: string | null;
  onFansubChange: (fansubGroupId: string) => void;
  onRefresh: () => void;
  onAddRelease: (release: Release) => void;
  onClose: () => void;
}) {
  const titleDisplay = resolveAnimeTitleDisplay(target.anime);
  const visibleReleases = filterReleasesByFansub(releases, selectedFansubId);
  const visibleErrors = dedupeReleaseErrors(errors);
  const unknownFansubCount = releases.filter((release) => !release.fansubGroupId).length;
  const sourceFailed = releases.length === 0 && visibleErrors.length > 0;

  return (
    <Panel
      title="资源下载"
      action={
        <Button variant="ghost" onClick={onClose} aria-label="关闭下载" title="关闭下载">
          <X className="h-4 w-4" />
        </Button>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="truncate text-sm font-medium">{titleDisplay.title}</div>
          {titleDisplay.subtitle && <div className="mt-1 truncate text-xs text-muted-foreground">{titleDisplay.subtitle}</div>}
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
          <select
            className="h-9 min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            value={selectedFansubId}
            onChange={(event) => onFansubChange(event.target.value)}
          >
            <option value="">全部字幕组（{releases.length}）</option>
            {fansubs.map((group) => {
              const count = countReleasesByFansub(releases, group.id);
              return (
                <option key={group.id} value={group.id}>
                  {group.name}
                  {count > 0 ? `（${count}）` : ""}
                </option>
              );
            })}
            {unknownFansubCount > 0 && <option value={unknownFansubFilter}>未识别字幕组（{unknownFansubCount}）</option>}
          </select>
          <Button variant="outline" onClick={onRefresh} disabled={loading}>
            <Search className="h-4 w-4" />
            {loading ? "查询中" : "刷新"}
          </Button>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>显示 {visibleReleases.length} 条</span>
          <span>共 {releases.length} 条</span>
        </div>

        {visibleErrors.length > 0 && (
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

        {loading ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">正在查询发布资源...</div>
        ) : (
          <div className="space-y-2">
            {visibleReleases.map((release) => {
              const canDownload = Boolean(release.magnetUrl ?? release.torrentUrl);
              return (
                <div key={releaseKey(release)} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{release.title}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge tone="blue">{release.sourceName}</Badge>
                        <Badge>{getReleaseFansubName(release, fansubNames)}</Badge>
                        {release.episodeNo && <Badge>第 {release.episodeNo} 集</Badge>}
                        {release.resolution && <Badge>{release.resolution}</Badge>}
                        {release.normalizedVideoCodec && <Badge tone="green">{release.normalizedVideoCodec}</Badge>}
                        {release.subtitle && <Badge>{subtitleText[release.subtitle]}</Badge>}
                        {release.size && <Badge>{formatBytes(release.size)}</Badge>}
                        {typeof release.seeders === "number" && (
                          <Badge tone={release.seeders > 0 ? "green" : "neutral"}>{release.seeders} 做种</Badge>
                        )}
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">{formatReleaseDate(release.publishedAt)}</div>
                    </div>
                    <Button
                      className="shrink-0"
                      variant="outline"
                      onClick={() => onAddRelease(release)}
                      disabled={!canDownload || addingReleaseId === release.id}
                    >
                      <Download className="h-4 w-4" />
                      {addingReleaseId === release.id ? "添加中" : "添加下载"}
                    </Button>
                  </div>
                </div>
              );
            })}

            {visibleReleases.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                {sourceFailed
                  ? "下载源请求失败，暂时无法获取发布资源和字幕组文件信息。"
                  : selectedFansubId
                    ? "当前字幕组没有可下载资源。"
                    : "没有找到可下载资源。"}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
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

function buildSearchTerms(item: MyAnime): string[] {
  return unique(
    [
      item.anime.title,
      item.anime.originalTitle ?? "",
      ...item.anime.aliases.map((alias) => alias.alias)
    ]
      .map((term) => term.trim())
      .filter(Boolean)
  ).slice(0, 8);
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

function getReleaseFansubName(release: Release, fansubNames: Map<string, string>): string {
  if (!release.fansubGroupId) {
    return "未识别字幕组";
  }

  return fansubNames.get(release.fansubGroupId) ?? release.fansubGroupId;
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
