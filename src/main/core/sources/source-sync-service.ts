import type { SourceSyncRunResult } from "@shared/contracts";
import type { AppSettings, NotificationRecord, ReleaseSourceConfig, ReleaseSourceSyncState } from "@shared/domain";
import { logger } from "../logger";
import { MetadataHttpClient } from "../metadata/metadata-http-client";
import type { AppRepository } from "../repositories/app-repository";
import { createReleaseSource, isMikanSiteConfig } from "./release-source-service";
import { createSourceHttpClient } from "./source-http-client";
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
    await this.addSummaryNotification(result);
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
      lastSyncAttemptAt: attemptAt,
      lastSyncError: undefined
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
      const message = error instanceof Error ? error.message : "下载源同步失败";
      const latestState = await this.getState(source.id);
      await this.repository.upsertSourceSyncState({
        ...latestState,
        lastSyncAttemptAt: attemptAt,
        lastSyncError: message
      });
      result.errors.push({ sourceId: source.id, message });
      logger.warn("下载源增量同步失败", { sourceId: source.id, message });
    }
  }

  private async getState(sourceId: string): Promise<ReleaseSourceSyncState> {
    return (await this.repository.listSourceSyncStates()).find((state) => state.sourceId === sourceId)
      ?? createEmptyState(sourceId);
  }

  private async addSummaryNotification(result: SourceSyncRunResult): Promise<void> {
    if (!result.errors.length) {
      return;
    }
    const record: NotificationRecord = {
      id: `source-sync-${result.finishedAt}`,
      kind: "system",
      title: "部分下载源同步失败",
      body: `${result.errors.length} 个来源未完成同步，已按退避策略等待下次重试。`,
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
