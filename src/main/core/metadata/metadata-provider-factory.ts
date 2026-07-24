import type { AppSettings, MetadataProxySettings } from "@shared/domain";
import {
  buildHttpRequestKey,
  defaultRequestCircuitBreaker,
  type RequestCircuitBreaker,
  supportsRequestCircuitStateStore
} from "../network/request-circuit-breaker";
import type { AppRepository } from "../repositories/app-repository";
import { AniListMetadataProvider } from "./anilist-metadata-provider";
import { BangumiMetadataProvider } from "./bangumi-metadata-provider";
import { MikanMetadataProvider } from "./mikan-metadata-provider";
import {
  MetadataHttpClient,
  type MetadataHttpTransport
} from "./metadata-http-client";
import type {
  AnimeDetailMetadataProvider,
  MonthlyAnimeMetadataProvider,
  SearchableAnimeMetadataProvider
} from "./metadata-provider";

const METADATA_CIRCUIT_GROUP = "metadata";

type AnimeMetadataProvider = MonthlyAnimeMetadataProvider & AnimeDetailMetadataProvider & SearchableAnimeMetadataProvider;
type MetadataProviderId = "bangumi" | "anilist" | "mikan";

export interface MetadataProviderFactoryOptions {
  circuitBreaker?: RequestCircuitBreaker;
  createHttpClient?: (settings: MetadataProxySettings) => MetadataHttpTransport;
}

/** 按来源网络策略创建同时支持月度采集和详情刷新的元数据 Provider。 */
export function createAnimeMetadataProviders(
  settings: AppSettings,
  repository?: AppRepository,
  options: MetadataProviderFactoryOptions = {}
): AnimeMetadataProvider[] {
  const createHttpClient = options.createHttpClient ?? ((proxySettings) => new MetadataHttpClient(proxySettings));
  const configuredClient = createHttpClient(settings.network.metadataProxy);
  const directClient = createHttpClient(resolveMetadataProviderProxySettings("anilist", settings.network.metadataProxy));
  const circuitBreaker = options.circuitBreaker ?? defaultRequestCircuitBreaker;

  return [
    new BangumiMetadataProvider(
      undefined,
      protectMetadataHttpClient("bangumi", "Bangumi", configuredClient, repository, circuitBreaker)
    ),
    new AniListMetadataProvider(
      protectMetadataHttpClient("anilist", "AniList", directClient, repository, circuitBreaker)
    ),
    new MikanMetadataProvider(
      undefined,
      protectMetadataHttpClient("mikan", "Mikan", configuredClient, repository, circuitBreaker)
    )
  ];
}

/** AniList 固定直连，其他元数据来源沿用用户配置。 */
export function resolveMetadataProviderProxySettings(
  providerId: MetadataProviderId,
  configured: MetadataProxySettings
): MetadataProxySettings {
  return providerId === "anilist"
    ? { mode: "off", timeoutMs: configured.timeoutMs }
    : { ...configured };
}

/** 为单个元数据来源组合通用熔断保护。 */
export function protectMetadataHttpClient(
  providerId: MetadataProviderId,
  providerName: string,
  transport: MetadataHttpTransport,
  repository?: AppRepository,
  circuitBreaker = defaultRequestCircuitBreaker
): MetadataHttpTransport {
  const stateStore = supportsRequestCircuitStateStore(repository) ? repository : undefined;
  const target = {
    key: `${METADATA_CIRCUIT_GROUP}:${providerId}`,
    group: METADATA_CIRCUIT_GROUP,
    name: providerName,
    shareByHost: true
  };
  return {
    fetch: (input, requestOptions = {}) => circuitBreaker.execute(
      target,
      input,
      () => transport.fetch(input, requestOptions),
      {
        requestKey: buildHttpRequestKey(input, requestOptions),
        stateStore
      }
    )
  };
}
