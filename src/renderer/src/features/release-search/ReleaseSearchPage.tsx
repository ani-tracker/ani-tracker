import { AlertCircle, CheckCircle2, Download, PackageSearch, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@/components/ui/command";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { ReleaseMetadataBadges } from "@/components/release-metadata-badges";
import { appApi } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { isAnimeSearchTerm, matchesAnimeSearchKeyword } from "@shared/anime-release-search";
import { resolveAnimeTitleDisplay } from "@shared/anime-title";
import { parseReleaseSearchInput } from "@shared/release-search-input";
import type { ReleaseSearchResult } from "@shared/contracts";
import type { MyAnime, Release } from "@shared/domain";

interface SearchedContext {
  mode: "anime" | "keyword";
  keyword: string;
  episodeNo?: number;
  myAnime?: MyAnime;
}

export function ReleaseSearchPage() {
  const [keyword, setKeyword] = useState("");
  const [myAnime, setMyAnime] = useState<MyAnime[]>([]);
  const [selectedAnimeId, setSelectedAnimeId] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReleaseSearchResult | null>(null);
  const [searchedContext, setSearchedContext] = useState<SearchedContext | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const selectedAnime = useMemo(
    () => myAnime.find((item) => item.id === selectedAnimeId) ?? null,
    [myAnime, selectedAnimeId]
  );
  const parsedInput = useMemo(() => parseReleaseSearchInput(keyword), [keyword]);
  const suggestions = useMemo(
    () => parsedInput.keyword
      ? myAnime.filter((item) => matchesAnimeSearchKeyword(item.anime, parsedInput.keyword)).slice(0, 8)
      : [],
    [myAnime, parsedInput.keyword]
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

  /** 更新关键词，并在输入不再对应原番剧时取消关联。 */
  function updateKeyword(value: string) {
    const nextInput = parseReleaseSearchInput(value);
    setKeyword(value);
    if (selectedAnime && !isAnimeSearchTerm(selectedAnime.anime, nextInput.keyword)) {
      setSelectedAnimeId("");
    }
    setSuggestionsOpen(Boolean(nextInput.keyword));
  }

  /** 选择联想番剧，并保留输入中已识别的集数。 */
  function selectAnime(item: MyAnime) {
    const title = resolveAnimeTitleDisplay(item.anime).title;
    setSelectedAnimeId(item.id);
    setKeyword(parsedInput.episodeNo === undefined ? title : `${title} 第 ${parsedInput.episodeNo} 集`);
    setSuggestionsOpen(false);
  }

  /** 根据是否关联追番选择番剧级搜索或普通关键词搜索。 */
  async function search() {
    const input = parseReleaseSearchInput(keyword);
    if (!input.keyword) {
      setMessage({ tone: "error", text: "请输入搜索关键词" });
      return;
    }

    setLoading(true);
    setMessage(null);
    setSuggestionsOpen(false);

    try {
      const searchResult = selectedAnime
        ? await appApi.searchAnimeReleases({
            animeId: selectedAnime.anime.id,
            episodeNo: input.episodeNo,
            fansubGroupId: selectedAnime.defaultFansubGroupId,
            preferredResolution: selectedAnime.preferredResolution,
            limit: 80
          })
        : await appApi.searchReleases({
            keyword: input.keyword,
            episodeNo: input.episodeNo,
            limit: 80
          });

      setResult({ ...searchResult, releases: sortReleases(searchResult.releases) });
      setSearchedContext({
        mode: selectedAnime ? "anime" : "keyword",
        keyword: input.keyword,
        episodeNo: input.episodeNo,
        myAnime: selectedAnime ?? undefined
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "资源搜索失败"
      });
    } finally {
      setLoading(false);
    }
  }

  /** 将当前搜索结果加入下载队列，并沿用执行搜索时的番剧和集数关联。 */
  async function addDownload(releaseId: string) {
    const release = result?.releases.find((item) => item.id === releaseId);
    if (!release) {
      return;
    }

    const searchedAnime = searchedContext?.myAnime;
    const releaseForDownload: Release = {
      ...release,
      animeId: searchedAnime?.anime.id ?? release.animeId,
      episodeNo: searchedContext?.episodeNo ?? release.episodeNo,
      fansubGroupId: release.fansubGroupId ?? searchedAnime?.defaultFansubGroupId
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
        <p className="mt-1 text-sm text-muted-foreground">统一搜索已启用的 RSS、Torznab 和站点适配器，结果会自动解析字幕语言、编码、位深和清晰度。</p>
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
          <CardTitle>搜索资源</CardTitle>
          <CardDescription>搜索已启用的 RSS、Torznab 和站点来源。</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-3">
            <Field className="min-w-0">
              <FieldLabel htmlFor="release-keyword">关键词</FieldLabel>
              <Command className="overflow-visible bg-transparent" shouldFilter={false}>
                <Popover
                  open={suggestionsOpen && !selectedAnime && Boolean(parsedInput.keyword)}
                  onOpenChange={setSuggestionsOpen}
                >
                  <PopoverAnchor asChild>
                    <InputGroup>
                      <CommandInput
                        id="release-keyword"
                        aria-label="资源搜索关键词"
                        autoComplete="off"
                        placeholder="输入番剧名、关键词或集数，如：芙莉莲 EP12"
                        value={keyword}
                        onValueChange={updateKeyword}
                        onFocus={() => setSuggestionsOpen(Boolean(parsedInput.keyword))}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setSuggestionsOpen(false);
                          }
                          if (event.key === "Enter" && (!suggestionsOpen || suggestions.length === 0)) {
                            void search();
                          }
                        }}
                      />
                      <InputGroupAddon>
                        <InputGroupButton
                          variant="primary"
                          onClick={() => void search()}
                          disabled={loading || !keyword.trim()}
                        >
                          <Search data-icon="inline-start" />
                          {loading ? "搜索中" : "搜索"}
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </PopoverAnchor>
                  <PopoverContent
                    className="w-[min(32rem,calc(100vw-2rem))] p-0"
                    align="start"
                    onOpenAutoFocus={(event) => event.preventDefault()}
                  >
                    <CommandList>
                      <CommandEmpty>未匹配到追番，将按关键词搜索</CommandEmpty>
                      <CommandGroup heading="我的追番">
                        {suggestions.map((item) => {
                          const titleDisplay = resolveAnimeTitleDisplay(item.anime);
                          return (
                            <CommandItem
                              key={item.id}
                              value={item.id}
                              onSelect={() => selectAnime(item)}
                            >
                              <div className="min-w-0">
                                <div className="truncate font-medium">{titleDisplay.title}</div>
                                {titleDisplay.subtitle && (
                                  <div className="truncate text-xs text-muted-foreground">{titleDisplay.subtitle}</div>
                                )}
                              </div>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </PopoverContent>
                </Popover>
              </Command>
            </Field>

            {(selectedAnime || parsedInput.episodeNo !== undefined) && (
              <div className="flex flex-wrap gap-2">
                {selectedAnime && (
                  <Badge tone="blue">已关联：{resolveAnimeTitleDisplay(selectedAnime.anime).title}</Badge>
                )}
                {parsedInput.episodeNo !== undefined && <Badge>第 {parsedInput.episodeNo} 集</Badge>}
              </div>
            )}
          </FieldGroup>
        </CardContent>
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
            <div className="min-w-0">
              {searchedContext && (
                <div className="truncate text-sm font-medium">
                  {searchedContext.mode === "anime"
                    ? `按《${resolveAnimeTitleDisplay(searchedContext.myAnime!.anime).title}》搜索`
                    : `关键词搜索：${searchedContext.keyword}`}
                  {searchedContext.episodeNo !== undefined ? ` · 第 ${searchedContext.episodeNo} 集` : ""}
                </div>
              )}
              <div className="text-sm text-muted-foreground">
                已搜索 {result.searchedSourceIds.length} 个下载源，找到 {result.releases.length} 条资源
              </div>
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
                      {release.episodeNo !== undefined && <Badge>第 {release.episodeNo} 集</Badge>}
                      <ReleaseMetadataBadges metadata={release} />
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
