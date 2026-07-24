import type {
  AnimeSourceBindingState,
  AnimeSourceCandidate,
  ConfirmAnimeSourceBindingInput,
  RemoveAnimeSourceCandidateMismatchInput,
  ReportAnimeSourceCandidateMismatchInput,
  SetAnimeSourceExclusionInput
} from "@shared/contracts";
import type { Anime, AnimeSourceBinding, ReleaseSourceConfig } from "@shared/domain";
import type { AppRepository } from "../repositories/app-repository";
import { logger } from "../logger";
import { MikanReleaseSource, type ReleaseHttpClient } from "../sources/mikan-source";
import { AniBtReleaseSource } from "../sources/anibt-source";
import { isAniBtConfig, isMikanRssConfig, isMikanSiteConfig } from "../sources/release-source-service";
import { scoreAnimeSourceCandidate } from "./anime-source-matcher";
import { defaultMetadataHttpClient } from "../metadata/metadata-http-client";
import { createSourceHttpClient } from "../sources/source-http-client";

const MAX_CANDIDATES_PER_SOURCE = 6;

export class AnimeSourceBindingService {
  constructor(
    private readonly repository: AppRepository,
    private readonly httpClient: ReleaseHttpClient = defaultMetadataHttpClient
  ) {}

  /** 读取来源绑定，并按需发现尚未绑定的来源候选。 */
  async getState(animeId: string, discoverCandidates = true): Promise<AnimeSourceBindingState> {
    const [anime, sources, episodes, exclusions] = await Promise.all([
      this.findAnime(animeId),
      this.repository.listSources(),
      this.repository.listEpisodes(animeId),
      this.repository.listAnimeSourceExclusions(animeId)
    ]);
    if (!anime) {
      throw new Error("追番不存在");
    }

    let bindings = await this.syncExternalIdBindings(anime, sources);
    const excludedSourceIds = new Set(
      exclusions.filter((item) => item.scope === "source").map((item) => item.sourceId)
    );
    const excludedCandidateKeys = new Set(
      exclusions
        .filter((item) => item.scope === "candidate" && item.sourceAnimeId)
        .map((item) => buildCandidateKey(item.sourceId, item.sourceAnimeId!))
    );
    const excludedSources = sources
      .filter((source) => source.enabled && isBindableSource(source) && excludedSourceIds.has(source.id))
      .map((source) => ({ sourceId: source.id, sourceName: source.name }));
    if (!discoverCandidates) {
      return { animeId, bindings, candidates: [], excludedSources, errors: [] };
    }

    const errors: AnimeSourceBindingState["errors"] = [];
    const boundSourceIds = new Set(bindings.filter((binding) => binding.confirmed).map((binding) => binding.sourceId));
    const candidateGroups = await Promise.all(
      sources
        .filter((source) => (
          source.enabled
          && isBindableSource(source)
          && !boundSourceIds.has(source.id)
          && !excludedSourceIds.has(source.id)
        ))
        .map(async (source) => {
          try {
            return await this.discoverSourceCandidates(
              anime,
              source,
              sources,
              episodes.length,
              excludedCandidateKeys
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : "来源番剧匹配失败";
            errors.push({ sourceId: source.id, message });
            logger.warn("Anime source candidate discovery failed", { animeId, sourceId: source.id, message });
            return [];
          }
        })
    );

    bindings = await this.repository.listAnimeSourceBindings(animeId);
    return {
      animeId,
      bindings,
      candidates: candidateGroups.flat().sort((left, right) => right.score - left.score),
      excludedSources,
      errors
    };
  }

  /** 将用户确认的候选保存为稳定来源绑定。 */
  async confirm(input: ConfirmAnimeSourceBindingInput): Promise<AnimeSourceBindingState> {
    const [anime, sources, current] = await Promise.all([
      this.findAnime(input.animeId),
      this.repository.listSources(),
      this.repository.listAnimeSourceBindings(input.animeId)
    ]);
    if (!anime) {
      throw new Error("追番不存在");
    }
    if (!sources.some((source) => source.id === input.sourceId && isBindableSource(source))) {
      throw new Error("来源不存在或不支持番剧绑定");
    }

    const sourceAnimeId = input.sourceAnimeId.trim();
    if (!sourceAnimeId) {
      throw new Error("来源番剧 ID 不能为空");
    }
    validateOptionalHttpUrl(input.sourceUrl);

    const existing = current.find((binding) => binding.sourceId === input.sourceId);
    const timestamp = new Date().toISOString();
    await this.repository.upsertAnimeSourceBinding({
      id: existing?.id ?? buildBindingId(input.animeId, input.sourceId),
      animeId: input.animeId,
      sourceId: input.sourceId,
      sourceAnimeId,
      sourceAnimeTitle: input.sourceAnimeTitle?.trim() || undefined,
      sourceUrl: input.sourceUrl?.trim() || undefined,
      matchMethod: "manual",
      confidence: clampConfidence(input.confidence ?? 1),
      confirmed: true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    });
    logger.info("Anime source binding confirmed", {
      animeId: input.animeId,
      sourceId: input.sourceId,
      sourceAnimeId
    });
    return this.getState(input.animeId, true);
  }

  /** 持久化记录人工确认的不匹配候选，后续发现时自动排除。 */
  async reportMismatch(input: ReportAnimeSourceCandidateMismatchInput): Promise<void> {
    const [anime, sources] = await Promise.all([
      this.findAnime(input.animeId),
      this.repository.listSources()
    ]);
    if (!anime) {
      throw new Error("追番不存在");
    }

    const source = sources.find((item) => item.id === input.sourceId && isBindableSource(item));
    if (!source) {
      throw new Error("来源不存在或不支持番剧绑定");
    }

    const sourceAnimeId = input.sourceAnimeId.trim();
    if (!sourceAnimeId) {
      throw new Error("来源番剧 ID 不能为空");
    }

    const timestamp = new Date().toISOString();
    await this.repository.upsertAnimeSourceExclusion({
      id: buildExclusionId(anime.id, source.id, sourceAnimeId),
      animeId: anime.id,
      sourceId: source.id,
      scope: "candidate",
      sourceAnimeId,
      sourceAnimeTitle: input.sourceAnimeTitle.trim() || undefined,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    logger.info("来源番剧候选已确认不匹配", {
      animeId: anime.id,
      animeTitle: anime.title,
      sourceId: source.id,
      sourceName: source.name,
      sourceAnimeId,
      sourceAnimeTitle: input.sourceAnimeTitle.trim(),
      candidateScore: Math.max(0, Math.min(100, Math.round(input.score))),
      reasons: input.reasons.slice(0, 6)
    });
  }

  /** 撤销单个候选的不匹配决定并重新发现来源候选。 */
  async removeCandidateMismatch(input: RemoveAnimeSourceCandidateMismatchInput): Promise<AnimeSourceBindingState> {
    const sourceAnimeId = input.sourceAnimeId.trim();
    if (!sourceAnimeId) throw new Error("来源番剧 ID 不能为空");
    await this.validateAnimeAndSource(input.animeId, input.sourceId);
    await this.repository.removeAnimeSourceExclusion(input.animeId, input.sourceId, sourceAnimeId);
    logger.info("来源番剧候选不匹配已撤销", {
      animeId: input.animeId,
      sourceId: input.sourceId,
      sourceAnimeId
    });
    return this.getState(input.animeId, true);
  }

  /** 设置或取消当前番剧对整个下载源的候选排除。 */
  async setSourceExcluded(input: SetAnimeSourceExclusionInput): Promise<AnimeSourceBindingState> {
    const { anime, source } = await this.validateAnimeAndSource(input.animeId, input.sourceId);
    if (input.excluded) {
      const existing = (await this.repository.listAnimeSourceExclusions(anime.id)).find(
        (item) => item.sourceId === source.id && item.scope === "source"
      );
      const timestamp = new Date().toISOString();
      await this.repository.upsertAnimeSourceExclusion({
        id: existing?.id ?? buildExclusionId(anime.id, source.id),
        animeId: anime.id,
        sourceId: source.id,
        scope: "source",
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
    } else {
      await this.repository.removeAnimeSourceExclusion(anime.id, source.id);
    }
    logger.info("番剧来源候选排除状态已更新", {
      animeId: anime.id,
      sourceId: source.id,
      excluded: input.excluded
    });
    return this.getState(anime.id, true);
  }

  /** 删除绑定，允许用户重新发现并确认候选。 */
  async remove(animeId: string, sourceId: string): Promise<AnimeSourceBindingState> {
    const existing = (await this.repository.listAnimeSourceBindings(animeId)).find(
      (binding) => binding.sourceId === sourceId
    );
    if (existing) {
      await this.repository.upsertAnimeSourceBinding({
        ...existing,
        confidence: 0,
        confirmed: false,
        updatedAt: new Date().toISOString()
      });
    }
    return this.getState(animeId, true);
  }

  private async findAnime(animeId: string): Promise<Anime | undefined> {
    return (await this.repository.listMyAnime()).find((item) => item.anime.id === animeId)?.anime;
  }

  /** 校验追番和可绑定下载源，并返回后续操作所需实体。 */
  private async validateAnimeAndSource(
    animeId: string,
    sourceId: string
  ): Promise<{ anime: Anime; source: ReleaseSourceConfig }> {
    const [anime, sources] = await Promise.all([
      this.findAnime(animeId),
      this.repository.listSources()
    ]);
    if (!anime) throw new Error("追番不存在");
    const source = sources.find((item) => item.id === sourceId && isBindableSource(item));
    if (!source) throw new Error("来源不存在或不支持番剧绑定");
    return { anime, source };
  }

  private async syncExternalIdBindings(
    anime: Anime,
    sources: ReleaseSourceConfig[]
  ): Promise<AnimeSourceBinding[]> {
    let bindings = await this.repository.listAnimeSourceBindings(anime.id);
    for (const source of sources.filter((item) => item.enabled && isBindableSource(item))) {
      if (bindings.some((binding) => binding.sourceId === source.id)) {
        continue;
      }

      const externalId = isMikanRssConfig(source) ? anime.externalIds.mikan : anime.externalIds.bangumi;
      if (!externalId?.trim()) {
        continue;
      }

      const existing = bindings.find((binding) => binding.sourceId === source.id);
      const timestamp = new Date().toISOString();
      bindings = await this.repository.upsertAnimeSourceBinding({
        id: existing?.id ?? buildBindingId(anime.id, source.id),
        animeId: anime.id,
        sourceId: source.id,
        sourceAnimeId: externalId.trim(),
        sourceAnimeTitle: anime.title,
        sourceUrl: buildSourceAnimeUrl(source, externalId.trim()),
        matchMethod: "external_id",
        confidence: 1,
        confirmed: true,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
      logger.info("Anime source binding created from external ID", {
        animeId: anime.id,
        sourceId: source.id,
        sourceAnimeId: externalId.trim()
      });
    }
    return bindings;
  }

  private async discoverSourceCandidates(
    anime: Anime,
    source: ReleaseSourceConfig,
    sources: ReleaseSourceConfig[],
    localEpisodeCount: number,
    excludedCandidateKeys: Set<string>
  ): Promise<AnimeSourceCandidate[]> {
    const mikanSiteSource = sources.find((item) => item.enabled && isMikanSiteConfig(item));
    if (isMikanRssConfig(source) && !mikanSiteSource) {
      throw new Error("请先在下载源设置中启用蜜柑计划站点以发现候选");
    }

    const candidates = isMikanRssConfig(source)
      ? (await new MikanReleaseSource(
          mikanSiteSource!,
          createSourceHttpClient(mikanSiteSource!, this.httpClient, this.repository)
        ).searchAnimeCandidates(anime)).map(
          (candidate) => ({ ...candidate, sourceId: source.id, sourceName: source.name })
        )
      : await new AniBtReleaseSource(
          source,
          createSourceHttpClient(source, this.httpClient, this.repository)
        ).searchAnimeCandidates(anime);

    return candidates
      .map((candidate) => scoreAnimeSourceCandidate(anime, candidate, localEpisodeCount))
      .filter((candidate) => !excludedCandidateKeys.has(buildCandidateKey(candidate.sourceId, candidate.sourceAnimeId)))
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_CANDIDATES_PER_SOURCE);
  }
}

function isBindableSource(source: ReleaseSourceConfig): boolean {
  return isMikanRssConfig(source) || isAniBtConfig(source);
}

function buildBindingId(animeId: string, sourceId: string): string {
  return `source-binding:${animeId}:${sourceId}`;
}

function buildCandidateKey(sourceId: string, sourceAnimeId: string): string {
  return `${sourceId}:${sourceAnimeId}`;
}

function buildExclusionId(animeId: string, sourceId: string, sourceAnimeId?: string): string {
  return ["source-exclusion", animeId, sourceId, sourceAnimeId ?? "*"]
    .map((value) => encodeURIComponent(value))
    .join(":");
}

function buildSourceAnimeUrl(source: ReleaseSourceConfig, sourceAnimeId: string): string {
  if (isMikanRssConfig(source)) {
    return new URL(`/Home/Bangumi/${encodeURIComponent(sourceAnimeId)}`, source.baseUrl ?? source.rssUrl ?? "https://mikanani.me/").toString();
  }
  return `https://bgm.tv/subject/${encodeURIComponent(sourceAnimeId)}`;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function validateOptionalHttpUrl(value?: string): void {
  if (!value?.trim()) {
    return;
  }
  const protocol = new URL(value).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("来源地址仅支持 HTTP 或 HTTPS");
  }
}
