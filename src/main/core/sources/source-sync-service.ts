import type { SourceSyncRunResult } from "@shared/contracts";
import type {
  AppSettings,
  NotificationRecord,
  ReleaseSourceConfig,
  ReleaseSourceSyncState,
  RequestCircuitState
} from "@shared/domain";
import { logger } from "../logger";
import { MetadataHttpClient } from "../metadata/metadata-http-client";
import type { AppRepository } from "../repositories/app-repository";
import { createReleaseSource, isMikanSiteConfig } from "./release-source-service";
import { createSourceHttpClient, getReleaseSourceCircuitState } from "./source-http-client";
import type { ReleaseHttpClient } from "./mikan-source";

const SYNC_RELEASE_LIMIT = 200;
const CACHE_RETENTION_DAYS = 90;

export interface SourceSyncRunOptions {
  force?: boolean;
  now?: Date;
}

/** 按来源执行每日增量采集，并保存可跨重启复用的资源缓存。 */
export class SourceSyncService {
  constructor(
    private readonly repository: AppRepository,
    private readonly createHttpClient: (settings: AppSettings) => ReleaseHttpClient = (settings) =>
      new MetadataHttpClient(settings.network.metadataProxy)
  ) {}

  async run(options: SourceSyncRunOptions = {}): Promise<SourceSyncRunResult> {
    const now = options.now ?? new Date();
    const startedAt = now.toISOString();
    const result: SourceSyncRunResult = {
      startedAt,
      finishedAt: startedAt,
      syncedSourceIds: [],
      skippedSourceIds: [],
      addedReleaseCount: 0,
      errors: []
    };
    const [settings, sources, states] = await Promise.all([
      this.repository.getSettings(),
      this.repository.listSources(),
      this.repository.listSourceSyncStates()
    ]);
    const stateBySourceId = new Map(states.map((state) => [state.sourceId, state]));
    const proxyHttpClient = this.createHttpClient(settings);
    const candidates = sources.filter(canSynchronizeSource);

    await Promise.all(candidates.map(async (source) => {
      const state = stateBySourceId.get(source.id) ?? createEmptyState(source.id);
      if (!options.force && isSameLocalDay(state.lastSuccessfulSyncAt, now)) {
        result.skippedSourceIds.push(source.id);
        return;
      }
      await this.syncSource(source, state, proxyHttpClient, now, result);
    }));

    const retentionDate = new Date(now.getTime() - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const pruned = await this.repository.pruneCachedReleases(retentionDate);
    result.finishedAt = new Date().toISOString();
    await this.addSummaryNotification(result, sources);
    logger.info("每日下载源增量同步完成", {
      sourceCount: result.syncedSourceIds.length,
      skippedCount: result.skippedSourceIds.length,
      addedReleaseCount: result.addedReleaseCount,
      errorCount: result.errors.length,
      prunedReleaseCount: pruned
    });
    return result;
  }

  private async syncSource(
    source: ReleaseSourceConfig,
    previousState: ReleaseSourceSyncState,
    proxyHttpClient: ReleaseHttpClient,
    now: Date,
    result: SourceSyncRunResult
  ): Promise<void> {
    const attemptAt = now.toISOString();
    await this.repository.upsertSourceSyncState({
      ...previousState,
      lastSyncAttemptAt: attemptAt
    });

    try {
      const sourceHttpClient = createSourceHttpClient(source, proxyHttpClient, this.repository);
      const conditionalClient = createConditionalSyncClient(source, previousState, sourceHttpClient);
      const releaseSource = createReleaseSource(source, conditionalClient, this.repository, false);
      if (!releaseSource) {
        result.skippedSourceIds.push(source.id);
        return;
      }
      const releases = await releaseSource.searchReleases({ keyword: "", limit: SYNC_RELEASE_LIMIT });
      const addedCount = await this.repository.upsertCachedReleases(releases);
      const latestState = await this.getState(source.id);
      await this.repository.upsertSourceSyncState({
        ...latestState,
        lastSyncAttemptAt: attemptAt,
        lastSuccessfulSyncAt: attemptAt,
        lastSyncError: undefined,
        etag: conditionalClient.etag ?? latestState.etag,
        lastModified: conditionalClient.lastModified ?? latestState.lastModified
      });
      result.syncedSourceIds.push(source.id);
      result.addedReleaseCount += addedCount;
    } catch (error) {
      const currentMessage = formatSourceSyncError(error);
      const latestState = await this.getState(source.id);
      const circuitState = await getReleaseSourceCircuitState(source.id, source.name, this.repository);
      const message = preserveSourceSyncRootCause(currentMessage, latestState.lastSyncError);
      await this.repository.upsertSourceSyncState({
        ...latestState,
        lastSyncAttemptAt: attemptAt,
        lastSyncError: message
      });
      result.errors.push({ sourceId: source.id, message });
      logger.warn("下载源增量同步失败", {
        sourceId: source.id,
        message,
        circuitMessage: currentMessage === message ? undefined : currentMessage,
        requestFailureCount: circuitState.failureCount,
        backoffUntil: circuitState.backoffUntil
      });
    }
  }

  private async getState(sourceId: string): Promise<ReleaseSourceSyncState> {
    return (await this.repository.listSourceSyncStates()).find((state) => state.sourceId === sourceId)
      ?? createEmptyState(sourceId);
  }

  /** 将失败来源、根因和熔断状态写入提醒中心。 */
  private async addSummaryNotification(
    result: SourceSyncRunResult,
    sources: ReleaseSourceConfig[]
  ): Promise<void> {
    if (!result.errors.length) {
      return;
    }
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const failedSources = await Promise.all(result.errors.map(async (error) => {
      const source = sourceById.get(error.sourceId);
      return {
        error,
        source,
        state: await getReleaseSourceCircuitState(error.sourceId, source?.name ?? error.sourceId, this.repository)
      };
    }));
    const title = failedSources.length === 1
      ? `${failedSources[0].source?.name ?? failedSources[0].error.sourceId} 同步失败`
      : `${failedSources.length} 个下载源同步失败`;
    const record: NotificationRecord = {
      id: `source-sync-${result.finishedAt}`,
      kind: "system",
      title,
      body: failedSources
        .map(({ error, source, state }) => formatSourceSyncFailure(error, source, state))
        .join("\n"),
      severity: "warning",
      createdAt: result.finishedAt
    };
    await this.repository.addNotifications([record]);
  }
}

interface ConditionalSyncClient extends ReleaseHttpClient {
  etag?: string;
  lastModified?: string;
}

function createConditionalSyncClient(
  source: ReleaseSourceConfig,
  state: ReleaseSourceSyncState,
  httpClient: ReleaseHttpClient
): ConditionalSyncClient {
  const client: ConditionalSyncClient = {
    fetch: async (input, options = {}) => {
      const headers = new Headers(options.headers);
      if (source.kind === "rss") {
        if (state.etag) headers.set("If-None-Match", state.etag);
        if (state.lastModified) headers.set("If-Modified-Since", state.lastModified);
      }
      const response = await httpClient.fetch(input, { ...options, headers });
      client.etag = response.headers.get("etag") ?? undefined;
      client.lastModified = response.headers.get("last-modified") ?? undefined;
      return response;
    }
  };
  return client;
}

function canSynchronizeSource(source: ReleaseSourceConfig): boolean {
  return source.enabled && source.kind !== "manual" && !isMikanSiteConfig(source);
}

function createEmptyState(sourceId: string): ReleaseSourceSyncState {
  return { sourceId, requestFailureCount: 0 };
}

/** 保留异常链中的底层网络原因，避免只显示 fetch failed。 */
function formatSourceSyncError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "下载源同步失败";
  }
  const cause = error.cause instanceof Error ? error.cause.message.trim() : "";
  if (!cause || error.message.includes(cause)) {
    return error.message;
  }
  return `${error.message}：${cause}`;
}

/** 熔断拦截请求时沿用上次真实失败原因。 */
function preserveSourceSyncRootCause(currentMessage: string, previousMessage?: string): string {
  if (!currentMessage.includes("正在熔断保护中") || !previousMessage) {
    return currentMessage;
  }
  return previousMessage.includes("正在熔断保护中") ? currentMessage : previousMessage;
}

/** 组装单个失败来源的完整通知正文。 */
function formatSourceSyncFailure(
  error: SourceSyncRunResult["errors"][number],
  source?: ReleaseSourceConfig,
  state?: RequestCircuitState
): string {
  const parts = [
    `失败来源：${source?.name ?? error.sourceId}（${error.sourceId}）`,
    `原因：${trimTerminalPunctuation(error.message)}`
  ];
  if (state && state.failureCount > 0) {
    parts.push(`连续失败 ${state.failureCount} 次`);
  }
  const retryAt = formatRetryAt(state?.backoffUntil);
  if (retryAt) {
    parts.push(`熔断至 ${retryAt}`);
  }
  parts.push("将在下次计划同步时自动重试");
  return `${parts.join("。")}。`;
}

/** 将熔断截止时间格式化为本地日期时间。 */
function formatRetryAt(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function trimTerminalPunctuation(value: string): string {
  return value.trim().replace(/[。；;，,\s]+$/u, "");
}

/** 按本机日期判断来源当天是否已成功同步。 */
export function isSameLocalDay(value: string | undefined, now: Date): boolean {
  if (!value) {
    return false;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}
