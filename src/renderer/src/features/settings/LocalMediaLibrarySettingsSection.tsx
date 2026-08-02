import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, FolderSearch, RefreshCw, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { appApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import type {
  LocalMediaImportCandidate,
  LocalMediaImportJobStatus,
  LocalMediaImportPhase,
  LocalMediaImportSelection,
  LocalMediaSourceSummary
} from "@shared/contracts";

const CREATE_LOCAL_VALUE = "__create_local__";

interface CandidateChoice {
  included: boolean;
  value: string;
}

const phasePresentation: Record<
  LocalMediaImportPhase,
  { label: string; tone: "neutral" | "primary-soft" | "green" | "amber" | "red" | "blue" }
> = {
  idle: { label: "空闲", tone: "neutral" },
  scanning: { label: "扫描中", tone: "blue" },
  matching: { label: "匹配中", tone: "blue" },
  importing: { label: "导入中", tone: "primary-soft" },
  awaiting_review: { label: "待确认", tone: "amber" },
  verifying: { label: "校验中", tone: "blue" },
  completed: { label: "已完成", tone: "green" },
  cancelled: { label: "已取消", tone: "neutral" },
  failed: { label: "失败", tone: "red" }
};

const runningPhases = new Set<LocalMediaImportPhase>([
  "scanning",
  "matching",
  "importing",
  "verifying"
]);

/** 管理桌面本地媒体的后台扫描、审核和可用性校验。 */
export function LocalMediaLibrarySettingsSection() {
  const [status, setStatus] = useState<LocalMediaImportJobStatus | null>(null);
  const [sources, setSources] = useState<LocalMediaSourceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewJobId = useRef<string | undefined>();
  const [choices, setChoices] = useState<Record<string, CandidateChoice>>({});
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      appApi.getLocalMediaImportStatus(),
      appApi.listLocalMediaSources()
    ])
      .then(([nextStatus, nextSources]) => {
        if (!active) return;
        applyStatus(nextStatus);
        setSources(nextSources);
      })
      .catch((error) => {
        if (active) toast.error(error instanceof Error ? error.message : "本地媒体状态读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const unsubscribe = appApi.onLocalMediaImportStatusChanged((nextStatus) => {
      if (!active) return;
      applyStatus(nextStatus);
      if (["completed", "awaiting_review"].includes(nextStatus.phase)) {
        void refreshSources();
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const progress = useMemo(() => {
    if (!status?.totalFiles) return 0;
    return status.processedFiles / status.totalFiles;
  }, [status?.processedFiles, status?.totalFiles]);
  const running = status ? runningPhases.has(status.phase) : false;
  const awaitingReview = status?.phase === "awaiting_review";
  const taskBlocked = running || awaitingReview;
  const selectedCount = status?.candidates.filter((candidate) => choices[candidate.id]?.included).length ?? 0;

  /** 应用任务状态，并为新的待确认任务建立默认选择。 */
  function applyStatus(nextStatus: LocalMediaImportJobStatus) {
    setStatus(nextStatus);
    if (nextStatus.phase !== "awaiting_review" || nextStatus.jobId === reviewJobId.current) return;
    reviewJobId.current = nextStatus.jobId;
    setChoices(createCandidateChoices(nextStatus.candidates));
    setReviewOpen(true);
  }

  /** 刷新原地导入目录汇总。 */
  async function refreshSources() {
    try {
      setSources(await appApi.listLocalMediaSources());
    } catch (error) {
      console.warn("[local-media] 本地媒体目录汇总刷新失败", error);
    }
  }

  /** 打开目录选择器并启动后台扫描。 */
  async function startImport() {
    try {
      const nextStatus = await appApi.startLocalMediaImport();
      if (!nextStatus) return;
      applyStatus(nextStatus);
      toast.success("本地媒体扫描已转入后台");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "启动本地媒体扫描失败");
    }
  }

  /** 启动已登记媒体的后台可用性校验。 */
  async function verifyMedia() {
    try {
      applyStatus(await appApi.startMediaAvailabilityCheck());
      toast.success("媒体可用性校验已转入后台");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "启动媒体校验失败");
    }
  }

  /** 请求取消当前后台任务。 */
  async function cancelTask() {
    try {
      applyStatus(await appApi.cancelLocalMediaImport());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "取消后台任务失败");
    }
  }

  /** 提交低置信度候选的用户匹配结果。 */
  async function confirmCandidates() {
    if (!status?.jobId) return;
    const selections = status.candidates.flatMap<LocalMediaImportSelection>((candidate) => {
      const choice = choices[candidate.id];
      if (!choice?.included) return [];
      return [{
        candidateId: candidate.id,
        animeId: choice.value === CREATE_LOCAL_VALUE ? undefined : choice.value,
        createLocal: choice.value === CREATE_LOCAL_VALUE
      }];
    });
    if (selections.length === 0) {
      toast.warning("至少选择一组本地媒体");
      return;
    }
    setConfirming(true);
    try {
      applyStatus(await appApi.confirmLocalMediaImport(status.jobId, selections));
      setReviewOpen(false);
      toast.success("确认结果已转入后台导入");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认本地媒体匹配失败");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">媒体索引</span>
              {status && <Badge tone={phasePresentation[status.phase].tone}>{phasePresentation[status.phase].label}</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {status?.message ?? "尚未执行本地媒体扫描"}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button disabled={loading || taskBlocked} onClick={() => void startImport()} type="button">
              <FolderSearch data-icon="inline-start" />
              扫描本地媒体
            </Button>
            <Button disabled={loading || taskBlocked} onClick={() => void verifyMedia()} type="button" variant="outline">
              <RefreshCw data-icon="inline-start" />
              校验媒体
            </Button>
          </div>
        </div>

        {running && status && (
          <div className="border-y py-3">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{status.phase === "scanning" ? `已发现 ${status.discoveredFiles} 个文件` : `${status.processedFiles} / ${status.totalFiles}`}</span>
              <Button onClick={() => void cancelTask()} size="compact" type="button" variant="ghost">
                <X data-icon="inline-start" />
                取消
              </Button>
            </div>
            <Progress value={progress} />
          </div>
        )}

        {status?.phase === "awaiting_review" && (
          <Alert>
            <CircleAlert />
            <AlertTitle>{status.candidates.length} 组媒体等待确认</AlertTitle>
            <AlertDescription className="mt-2 flex flex-wrap gap-2">
              <Button onClick={() => setReviewOpen(true)} size="compact" type="button" variant="outline">
                查看匹配结果
              </Button>
              <Button onClick={() => void cancelTask()} size="compact" type="button" variant="ghost">
                <X data-icon="inline-start" />
                放弃结果
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {status?.error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>本地媒体任务失败</AlertTitle>
            <AlertDescription>{status.error}</AlertDescription>
          </Alert>
        )}

        <div className="overflow-hidden border-y">
          {sources.length > 0 ? sources.map((source) => (
            <div className="grid min-w-0 gap-2 border-b px-1 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={source.rootPath}>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" title={source.rootPath}>{source.rootPath}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {source.mediaCount} 个文件 · {formatVerifiedAt(source.lastScannedAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge tone="green">可用 {source.availableCount}</Badge>
                {source.problemCount > 0 && <Badge tone="red">问题 {source.problemCount}</Badge>}
              </div>
            </div>
          )) : (
            <div className="px-1 py-4 text-sm text-muted-foreground">暂无已导入的本地媒体目录</div>
          )}
        </div>
      </div>

      <Sheet open={reviewOpen && status?.phase === "awaiting_review"} onOpenChange={setReviewOpen}>
        <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:max-w-3xl lg:max-w-5xl">
          <SheetHeader className="border-b px-5 py-4 pr-14">
            <SheetTitle>确认番剧匹配</SheetTitle>
            <SheetDescription>选择媒体所属番剧；已有索引的关联变化将在此确认。</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5">
            <Table className="min-w-[54rem] table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14 whitespace-nowrap">导入</TableHead>
                  <TableHead>扫描目录</TableHead>
                  <TableHead className="w-24">文件</TableHead>
                  <TableHead className="w-52">当前关联</TableHead>
                  <TableHead className="w-60">匹配番剧</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status?.candidates.map((candidate) => {
                  const choice = choices[candidate.id] ?? defaultCandidateChoice(candidate);
                  const migrationFileCount = countMigrationFiles(candidate, choice);
                  return (
                    <TableRow data-state={choice.included ? "selected" : undefined} key={candidate.id}>
                      <TableCell>
                        <Checkbox
                          aria-label={`导入 ${candidate.titleHint}`}
                          checked={choice.included}
                          onCheckedChange={(checked) => setChoices((current) => ({
                            ...current,
                            [candidate.id]: { ...choice, included: checked === true }
                          }))}
                        />
                      </TableCell>
                      <TableCell>
                        <p className="max-w-72 truncate font-medium" title={candidate.titleHint}>{candidate.titleHint}</p>
                        <p className="mt-1 max-w-72 truncate text-xs text-muted-foreground" title={candidate.relativeDirectory}>
                          {candidate.relativeDirectory || "."} · 置信度 {candidate.confidence}%
                          {candidate.fileTitleConsensus < 100 && ` · 文件一致率 ${candidate.fileTitleConsensus}%`}
                        </p>
                      </TableCell>
                      <TableCell>
                        <span>{candidate.fileCount} 个</span>
                        {candidate.episodeNumbers.length > 0 && (
                          <p className="mt-1 max-w-32 truncate text-xs text-muted-foreground" title={candidate.episodeNumbers.join(", ")}>
                            {formatEpisodeNumbers(candidate.episodeNumbers)}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {candidate.currentAssociations.length > 0 ? (
                          <div className="flex flex-col items-start gap-1">
                            {candidate.currentAssociations.map((association) => (
                              <Badge key={association.animeId} title={association.animeTitle}>
                                <span className="max-w-36 truncate">{association.animeTitle}</span>
                                {association.fileCount}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">未建立索引</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-2">
                          <Select
                            disabled={!choice.included}
                            onValueChange={(value) => setChoices((current) => ({
                              ...current,
                              [candidate.id]: { ...choice, value }
                            }))}
                            value={choice.value}
                          >
                            <SelectTrigger aria-label={`${candidate.titleHint} 匹配番剧`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {candidate.alternatives.map((anime) => (
                                  <SelectItem key={anime.id} value={anime.id}>{anime.title}</SelectItem>
                                ))}
                                <SelectItem value={CREATE_LOCAL_VALUE}>建立本地番剧记录</SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          {migrationFileCount > 0 && (
                            <Badge tone="amber">迁移 {migrationFileCount} 个文件</Badge>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <SheetFooter className="border-t px-5 py-4">
            <Button onClick={() => setReviewOpen(false)} type="button" variant="outline">稍后处理</Button>
            <Button disabled={confirming || selectedCount === 0} onClick={() => void confirmCandidates()} type="button">
              <Check data-icon="inline-start" />
              {confirming ? "提交中" : `确认导入 ${selectedCount} 组`}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** 为待确认候选创建默认的启用和匹配选择。 */
function createCandidateChoices(candidates: LocalMediaImportCandidate[]): Record<string, CandidateChoice> {
  return Object.fromEntries(candidates.map((candidate) => [candidate.id, defaultCandidateChoice(candidate)]));
}

/** 返回单个候选的默认审核选择。 */
function defaultCandidateChoice(candidate: LocalMediaImportCandidate): CandidateChoice {
  return {
    included: false,
    value: candidate.suggestedAnimeId ?? CREATE_LOCAL_VALUE
  };
}

/** 计算当前选择会改绑的已有媒体数量。 */
function countMigrationFiles(candidate: LocalMediaImportCandidate, choice: CandidateChoice): number {
  if (!choice.included) return 0;
  if (choice.value === CREATE_LOCAL_VALUE) {
    return candidate.currentAssociations.reduce((total, association) => total + association.fileCount, 0);
  }
  return candidate.currentAssociations
    .filter((association) => association.animeId !== choice.value)
    .reduce((total, association) => total + association.fileCount, 0);
}

/** 将识别集数压缩为适合表格展示的文本。 */
function formatEpisodeNumbers(episodeNumbers: number[]): string {
  const visible = episodeNumbers.slice(0, 5).map((episode) => `E${episode}`).join("、");
  return episodeNumbers.length > 5 ? `${visible} 等` : visible;
}

/** 格式化媒体目录最近一次校验时间。 */
function formatVerifiedAt(value?: string): string {
  if (!value) return "尚未校验";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `校验于 ${new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date)}`;
}
