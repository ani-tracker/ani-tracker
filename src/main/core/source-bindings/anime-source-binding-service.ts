import type {
  AnimeSourceBindingState,
  AnimeSourceCandidate,
  ConfirmAnimeSourceBindingInput
} from "@shared/contracts";
import type { Anime, AnimeSourceBinding, ReleaseSourceConfig } from "@shared/domain";
import type { AppRepository } from "../repositories/app-repository";
import { logger } from "../logger";
import { MikanReleaseSource, type ReleaseHttpClient } from "../sources/mikan-source";
import { AniBtReleaseSource } from "../sources/anibt-source";
import { isAniBtConfig, isMikanRssConfig, isMikanSiteConfig } from "../sources/release-source-service";
import { scoreAnimeSourceCandidate } from "./anime-source-matcher";

const MAX_CANDIDATES_PER_SOURCE = 6;

export class AnimeSourceBindingService {
  constructor(
    private readonly repository: AppRepository,
    private readonly httpClient?: ReleaseHttpClient
  ) {}

  /** 读取来源绑定，并按需发现尚未绑定的来源候选。 */
  async getState(animeId: string, discoverCandidates = true): Promise<AnimeSourceBindingState> {
    const [anime, sources, episodes] = await Promise.all([
      this.findAnime(animeId),
      this.repository.listSources(),
      this.repository.listEpisodes(animeId)
    ]);
    if (!anime) {
      throw new Error("追番不存在");
    }

    let bindings = await this.syncExternalIdBindings(anime, sources);
    if (!discoverCandidates) {
      return { animeId, bindings, candidates: [], errors: [] };
    }

    const errors: AnimeSourceBindingState["errors"] = [];
    const boundSourceIds = new Set(bindings.filter((binding) => binding.confirmed).map((binding) => binding.sourceId));
    const candidateGroups = await Promise.all(
      sources
        .filter((source) => source.enabled && isBindableSource(source) && !boundSourceIds.has(source.id))
        .map(async (source) => {
          try {
            return await this.discoverSourceCandidates(anime, source, sources, episodes.length);
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
    localEpisodeCount: number
  ): Promise<AnimeSourceCandidate[]> {
    const mikanSiteSource = sources.find((item) => item.enabled && isMikanSiteConfig(item));
    if (isMikanRssConfig(source) && !mikanSiteSource) {
      throw new Error("请先在下载源设置中启用蜜柑计划站点以发现候选");
    }

    const candidates = isMikanRssConfig(source)
      ? (await new MikanReleaseSource(mikanSiteSource!, this.httpClient).searchAnimeCandidates(anime)).map(
          (candidate) => ({ ...candidate, sourceId: source.id, sourceName: source.name })
        )
      : await new AniBtReleaseSource(source).searchAnimeCandidates(anime);

    return candidates
      .map((candidate) => scoreAnimeSourceCandidate(anime, candidate, localEpisodeCount))
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
