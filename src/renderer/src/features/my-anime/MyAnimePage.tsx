import { Download, Plus, Save, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appApi } from "@/lib/api";
import { formatBytes, formatMonth } from "@/lib/format";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
import type { EpisodeReleasePreview } from "@shared/contracts";
import type {
  AnimeStatus,
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

const episodeStatusOptions = Object.entries(episodeStatusText) as Array<[EpisodeStatus, string]>;
const resolutionOptions = ["", "720p", "1080p", "2160p"];
const codecOptions: Array<"" | NormalizedVideoCodec> = ["", "H.264/AVC", "H.265/HEVC", "AV1", "VP9", "Unknown"];
const subtitleOptions: Array<"" | SubtitlePreference> = ["", "chs", "cht", "multi", "jpn", "eng"];

export function MyAnimePage() {
  const [items, setItems] = useState<MyAnime[]>([]);
  const [fansubs, setFansubs] = useState<FansubGroup[]>([]);
  const [draft, setDraft] = useState<MyAnime | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodePreferences, setEpisodePreferences] = useState<EpisodePreference[]>([]);
  const [releasePreviews, setReleasePreviews] = useState<Record<string, EpisodeReleasePreview>>({});
  const [loading, setLoading] = useState(true);
  const [episodeLoading, setEpisodeLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewingEpisodeId, setPreviewingEpisodeId] = useState<string | null>(null);
  const [addingReleaseId, setAddingReleaseId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let active = true;

    Promise.all([appApi.listMyAnime(), appApi.listFansubs()])
      .then(([animeItems, groups]) => {
        if (!active) {
          return;
        }

        setItems(animeItems);
        setFansubs(groups);
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
    Promise.all([appApi.listEpisodes(draft.anime.id), appApi.listEpisodePreferences(draft.anime.id)])
      .then(([loadedEpisodes, loadedPreferences]) => {
        if (!active) {
          return;
        }

        setEpisodes(loadedEpisodes);
        setEpisodePreferences(loadedPreferences);
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

  async function addEpisodeReleaseDownload(episode: Episode, release: Release) {
    setAddingReleaseId(release.id);
    try {
      await appApi.addReleaseDownload({
        ...release,
        animeId: episode.animeId,
        episodeNo: episode.episodeNo
      });
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
        <Button onClick={() => setDraft(createEmptyDraft())}>
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
                        <div className="flex flex-wrap gap-2">
                          {item.status && <Badge>{statusText[item.status]}</Badge>}
                          {item.preferredResolution && <Badge>{item.preferredResolution}</Badge>}
                          {item.preferredCodec && <Badge tone="blue">{item.preferredCodec}</Badge>}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" onClick={() => setDraft(cloneMyAnime(item))}>
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

function EpisodeRulesPanel({
  draft,
  persisted,
  episodes,
  episodePreferences,
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
            const inheritedFansub = draft.defaultFansubGroupId
              ? (fansubNames.get(draft.defaultFansubGroupId) ?? "默认字幕组")
              : "未设置默认字幕组";

            return (
              <div key={episode.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">第 {episode.episodeNo} 集</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{episode.title ?? "未命名单集"}</div>
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
                    {previewingEpisodeId === episode.id ? "匹配中" : "匹配资源"}
                  </Button>
                </div>
                {preference?.fansubGroupId && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    当前覆盖：{fansubNames.get(preference.fansubGroupId) ?? preference.fansubGroupId}
                  </div>
                )}
                {preview && (
                  <div className="mt-3 space-y-2">
                    {preview.candidates.slice(0, 3).map((candidate) => (
                      <div key={candidate.release.id} className="rounded-md bg-muted p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{candidate.release.title}</div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Badge tone="blue">{candidate.score} 分</Badge>
                              {candidate.release.resolution && <Badge>{candidate.release.resolution}</Badge>}
                              {candidate.release.normalizedVideoCodec && (
                                <Badge tone="green">{candidate.release.normalizedVideoCodec}</Badge>
                              )}
                              {candidate.release.size && <Badge>{formatBytes(candidate.release.size)}</Badge>}
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
