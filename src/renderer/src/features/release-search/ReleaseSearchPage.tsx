import { AlertCircle, CheckCircle2, Download, PackageSearch, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
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
import { appApi } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { buildAnimeReleaseSearchTerms } from "@shared/anime-release-search";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
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
      await appApi.addReleaseDownload({
        release: releaseForDownload,
        animeId: releaseForDownload.animeId,
        episodeNo: releaseForDownload.episodeNo,
        fansubGroupId: releaseForDownload.fansubGroupId
      });
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
    <div className="flex min-w-0 flex-col gap-5">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-normal">资源搜索</h1>
        <p className="mt-1 text-sm text-muted-foreground">统一搜索已启用的 RSS、Torznab 和站点适配器，结果会自动解析字幕组、集数、编码和清晰度。</p>
      </div>

      {message && (
        <Alert variant={message.tone === "error" ? "destructive" : "default"}>
          {message.tone === "error" ? <AlertCircle /> : <CheckCircle2 />}
          <AlertTitle>{message.tone === "error" ? "操作未完成" : "操作完成"}</AlertTitle>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>搜索条件</CardTitle>
          <CardDescription>可从追番列表带入别名，也可以直接输入关键词进行搜索。</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-3 lg:grid lg:grid-cols-[minmax(12rem,1fr)_7rem_minmax(0,2fr)_auto] lg:items-end">
            <Field className="min-w-0">
              <FieldLabel htmlFor="release-anime">番剧范围</FieldLabel>
              <Select
                value={selectedAnimeId || "__manual__"}
                onValueChange={(value) => setSelectedAnimeId(value === "__manual__" ? "" : value)}
              >
                <SelectTrigger id="release-anime">
                  <SelectValue placeholder="选择追番" />
                </SelectTrigger>
                <SelectContent className="max-w-[calc(100vw-2rem)]">
                  <SelectGroup>
                    <SelectItem value="__manual__">手动关键词</SelectItem>
                    {myAnime.map((item) => {
                      const titleDisplay = resolveAnimeTitleDisplay(item.anime);
                      const optionLabel = titleDisplay.subtitle
                        ? `${titleDisplay.title} / ${titleDisplay.subtitle}`
                        : titleDisplay.title;

                      return (
                        <SelectItem key={item.id} value={item.id}>
                          {optionLabel}
                        </SelectItem>
                      );
                    })}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field className="min-w-0">
              <FieldLabel htmlFor="release-episode">集数</FieldLabel>
              <Input
                id="release-episode"
                inputMode="decimal"
                placeholder="如 12"
                value={episodeNo}
                onChange={(event) => setEpisodeNo(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void search();
                  }
                }}
              />
            </Field>

            <Field className="min-w-0">
              <FieldLabel htmlFor="release-keyword">关键词</FieldLabel>
              <Input
                id="release-keyword"
                placeholder={selectedAnime ? "追加关键词，可留空使用番剧别名" : "输入番剧名或字幕组关键词"}
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void search();
                  }
                }}
              />
            </Field>

            <Button className="w-full lg:w-auto" onClick={() => void search()} disabled={loading}>
              <Search data-icon="inline-start" />
              {loading ? "搜索中" : "搜索"}
            </Button>
          </FieldGroup>
        </CardContent>

        {searchedTerms.length > 0 && (
          <CardFooter className="flex-wrap gap-2 border-t pt-4 sm:pt-5">
            <span className="text-sm text-muted-foreground">已使用关键词</span>
            {searchedTerms.map((term) => (
              <Badge className="max-w-full truncate" key={term} tone="blue">{term}</Badge>
            ))}
          </CardFooter>
        )}
      </Card>

      {loading && !result && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label="正在搜索资源">
          {Array.from({ length: 4 }, (_, index) => (
            <Card key={index}>
              <CardHeader>
                <Skeleton className="h-5 w-4/5" />
                <Skeleton className="h-4 w-1/3" />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!loading && !result && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><PackageSearch /></EmptyMedia>
            <EmptyTitle>等待搜索资源</EmptyTitle>
            <EmptyDescription>选择追番或输入关键词后，即可搜索已启用的下载源。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {result && (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              已搜索 {result.searchedSourceIds.length} 个下载源，找到 {result.releases.length} 条资源
            </div>
            {result.errors.length > 0 && <Badge tone="amber">{result.errors.length} 个源异常</Badge>}
          </div>

          {result.errors.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>下载源异常</CardTitle>
                <CardDescription>其余下载源的搜索结果仍然可用。</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {result.errors.map((error, index) => (
                  <Alert key={`${error.sourceId}-${index}`}>
                    <AlertCircle />
                    <AlertTitle>{error.sourceId}</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                  </Alert>
                ))}
              </CardContent>
            </Card>
          )}

          {result.releases.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {result.releases.map((release) => (
                <Card key={release.id} className="min-w-0">
                  <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <CardTitle className="break-words leading-snug" title={release.title}>{release.title}</CardTitle>
                      <CardDescription className="mt-2" title={release.publishedAt}>
                        发布时间：{formatDateTime(release.publishedAt)}
                      </CardDescription>
                    </div>
                    <Button
                      className="w-full flex-none sm:w-auto"
                      variant="outline"
                      onClick={() => void addDownload(release.id)}
                      disabled={addingId === release.id}
                    >
                      <Download data-icon="inline-start" />
                      {addingId === release.id ? "添加中" : "添加下载"}
                    </Button>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-2">
                      <Badge className="max-w-full truncate" tone="blue">{release.sourceName}</Badge>
                      {(release.fansubName ?? release.fansubGroupId) && (
                        <Badge className="max-w-full truncate">{release.fansubName ?? release.fansubGroupId}</Badge>
                      )}
                      {release.episodeNo && <Badge>第 {release.episodeNo} 集</Badge>}
                      {release.resolution && <Badge>{release.resolution}</Badge>}
                      {release.normalizedVideoCodec && <Badge tone="green">{release.normalizedVideoCodec}</Badge>}
                      {release.subtitle && <Badge>{release.subtitle}</Badge>}
                      {release.size && <Badge>{formatBytes(release.size)}</Badge>}
                      {typeof release.seeders === "number" && (
                        <Badge tone={release.seeders > 0 ? "green" : "neutral"}>{release.seeders} 做种</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {release.infoHash && <span title={release.infoHash}>Hash：{release.infoHash.slice(0, 12)}</span>}
                      {(release.magnetUrl || release.torrentUrl) && (
                        <span>{release.magnetUrl ? "磁力链接" : "Torrent 文件"}</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><PackageSearch /></EmptyMedia>
                <EmptyTitle>没有找到资源</EmptyTitle>
                <EmptyDescription>请检查下载源是否启用，或换用日文名、罗马音再次搜索。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      )}
    </div>
  );
}

function buildSearchTerms(selectedAnime: MyAnime | null, keyword: string): string[] {
  if (selectedAnime) {
    return buildAnimeReleaseSearchTerms(selectedAnime.anime, keyword ? [keyword] : []);
  }

  return keyword.trim() ? [keyword.trim()] : [];
}

function mergeResults(
  results: ReleaseSearchResult[],
  terms: string[],
  animeId?: string,
  episodeNo?: number
): ReleaseSearchResult {
  const releases = sortReleases(dedupeReleases(results.flatMap((result) => result.releases)));
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

/** 按发布时间倒序排列资源，便于优先查看最新结果。 */
function sortReleases(releases: Release[]): Release[] {
  return [...releases].sort((left, right) => {
    const leftTime = new Date(left.publishedAt).getTime();
    const rightTime = new Date(right.publishedAt).getTime();
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
      return right.publishedAt.localeCompare(left.publishedAt);
    }
    if (Number.isNaN(leftTime)) {
      return 1;
    }
    if (Number.isNaN(rightTime)) {
      return -1;
    }

    return rightTime - leftTime;
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
