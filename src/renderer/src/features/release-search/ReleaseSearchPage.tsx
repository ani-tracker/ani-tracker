import { Download, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appApi } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import type { ReleaseSearchResult } from "@shared/contracts";
import type { MyAnime, Release } from "@shared/domain";

export function ReleaseSearchPage() {
  const [keyword, setKeyword] = useState("");
  const [episodeNo, setEpisodeNo] = useState("");
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [selectedAnimeId, setSelectedAnimeId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReleaseSearchResult | null>(null);
  const [searchedTerms, setSearchedTerms] = useState<string[]>([]);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const selectedAnime = useMemo(
    () => myAnime.find((item) => item.id === selectedAnimeId) ?? null,
    [myAnime, selectedAnimeId]
  );

  useEffect(() => {
    let active = true;

    appApi
      .listMyAnime()
      .then((items) => {
        if (active) {
          setMyAnime(items);
        }
      })
      .catch((error) => {
        if (active) {
          setMessage({
            tone: "error",
            text: error instanceof Error ? error.message : "加载追番列表失败"
          });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  async function search() {
    const terms = buildSearchTerms(selectedAnime, keyword);
    if (!terms.length) {
      setMessage({ tone: "error", text: "请输入关键词或选择一部追番" });
      return;
    }

    const parsedEpisodeNo = parseEpisodeNo(episodeNo);
    setLoading(true);
    setMessage(null);
    setSearchedTerms(terms);

    try {
      const results = await Promise.all(
        terms.map((term) =>
          appApi.searchReleases({
            keyword: term,
            animeId: selectedAnime?.anime.id,
            episodeNo: parsedEpisodeNo,
            fansubGroupId: selectedAnime?.defaultFansubGroupId,
            preferredResolution: selectedAnime?.preferredResolution,
            limit: 80
          })
        )
      );

      setResult(mergeResults(results, terms, selectedAnime?.anime.id, parsedEpisodeNo));
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "资源搜索失败"
      });
    } finally {
      setLoading(false);
    }
  }

  async function addDownload(releaseId: string) {
    const release = result?.releases.find((item) => item.id === releaseId);
    if (!release) {
      return;
    }

    const parsedEpisodeNo = parseEpisodeNo(episodeNo);
    const releaseForDownload: Release = {
      ...release,
      animeId: selectedAnime?.anime.id ?? release.animeId,
      episodeNo: parsedEpisodeNo ?? release.episodeNo,
      fansubGroupId: release.fansubGroupId ?? selectedAnime?.defaultFansubGroupId
    };

    setAddingId(releaseId);
    setMessage(null);
    try {
      await appApi.addReleaseDownload(releaseForDownload);
      setMessage({ tone: "success", text: "已添加到下载队列" });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "添加下载失败"
      });
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">资源搜索</h1>
        <p className="mt-1 text-sm text-muted-foreground">统一搜索已启用的 RSS / Torznab 下载源，结果会自动解析字幕组、集数、编码和清晰度。</p>
      </div>

      <Panel>
        <div className="grid grid-cols-[240px_120px_minmax(0,1fr)_auto] gap-3">
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            value={selectedAnimeId}
            onChange={(event) => setSelectedAnimeId(event.target.value)}
          >
            <option value="">手动关键词</option>
            {myAnime.map((item) => (
              <option key={item.id} value={item.id}>
                {item.anime.title}
              </option>
            ))}
          </select>
          <input
            className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            placeholder="集数"
            value={episodeNo}
            onChange={(event) => setEpisodeNo(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void search();
              }
            }}
          />
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
              placeholder={selectedAnime ? "追加关键词，可留空使用番剧别名" : "输入中文名、日文名、罗马音、英文名或字幕组关键词"}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void search();
                }
              }}
            />
          </div>
          <Button onClick={search} disabled={loading}>
            <Search className="h-4 w-4" />
            {loading ? "搜索中" : "搜索"}
          </Button>
        </div>

        {searchedTerms.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {searchedTerms.map((term) => (
              <Badge key={term} tone="blue">
                {term}
              </Badge>
            ))}
          </div>
        )}
      </Panel>

      {result && (
        <div className="space-y-4">
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

          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              已搜索 {result.searchedSourceIds.length} 个下载源，找到 {result.releases.length} 条资源
            </div>
            {result.errors.length > 0 && <Badge tone="amber">{result.errors.length} 个源异常</Badge>}
          </div>

          {result.errors.length > 0 && (
            <Panel>
              <div className="space-y-2">
                {result.errors.map((error, index) => (
                  <div
                    key={`${error.sourceId}-${index}`}
                    className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                  >
                    {error.sourceId}: {error.message}
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel>
            <div className="space-y-3">
              {result.releases.map((release) => (
                <div key={release.id} className="rounded-md border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{release.title}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge tone="blue">{release.sourceName}</Badge>
                        {release.episodeNo && <Badge>第 {release.episodeNo} 集</Badge>}
                        {release.resolution && <Badge>{release.resolution}</Badge>}
                        {release.normalizedVideoCodec && <Badge tone="green">{release.normalizedVideoCodec}</Badge>}
                        {release.subtitle && <Badge>{release.subtitle}</Badge>}
                        {release.size && <Badge>{formatBytes(release.size)}</Badge>}
                        {typeof release.seeders === "number" && (
                          <Badge tone={release.seeders > 0 ? "green" : "neutral"}>{release.seeders} 做种</Badge>
                        )}
                      </div>
                    </div>
                    <Button variant="outline" onClick={() => void addDownload(release.id)} disabled={addingId === release.id}>
                      <Download className="h-4 w-4" />
                      {addingId === release.id ? "添加中" : "添加下载"}
                    </Button>
                  </div>
                </div>
              ))}

              {result.releases.length === 0 && (
                <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                  没有找到资源。检查下载源是否启用，或换用日文名 / 罗马音搜索。
                </div>
              )}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

function buildSearchTerms(selectedAnime: MyAnime | null, keyword: string): string[] {
  const terms = [keyword.trim()];

  if (selectedAnime) {
    terms.push(
      selectedAnime.anime.title,
      selectedAnime.anime.originalTitle ?? "",
      ...selectedAnime.anime.aliases.map((alias) => alias.alias)
    );
  }

  return unique(terms.map((term) => term.trim()).filter(Boolean)).slice(0, 8);
}

function mergeResults(
  results: ReleaseSearchResult[],
  terms: string[],
  animeId?: string,
  episodeNo?: number
): ReleaseSearchResult {
  const releases = dedupeReleases(results.flatMap((result) => result.releases));
  const searchedSourceIds = unique(results.flatMap((result) => result.searchedSourceIds));
  const errors = results.flatMap((result) => result.errors);

  return {
    query: {
      keyword: terms.join(" / "),
      animeId,
      episodeNo,
      limit: 80
    },
    releases,
    searchedSourceIds,
    errors
  };
}

function dedupeReleases(releases: Release[]): Release[] {
  const seen = new Set<string>();

  return releases.filter((release) => {
    const key = release.infoHash ?? release.magnetUrl ?? release.torrentUrl ?? release.title;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function parseEpisodeNo(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
