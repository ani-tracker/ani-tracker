import type { ReleaseSourceConfig } from "@shared/domain";

/** 提供首次启动和版本升级需要补齐的下载源配置。 */
export const defaultSourceConfigs: ReleaseSourceConfig[] = [
  {
    id: "mikan",
    name: "蜜柑计划 RSS",
    kind: "rss",
    enabled: false,
    useProxy: true,
    requestIntervalMs: 1_500,
    rssUrl: "https://mikanani.me/RSS/Bangumi",
    tags: ["anime", "rss"]
  },
  {
    id: "dmhy",
    name: "动漫花园",
    kind: "site_adapter",
    enabled: false,
    useProxy: true,
    requestIntervalMs: 1_500,
    baseUrl: "https://share.dmhy.org/",
    tags: ["anime", "bt"]
  },
  {
    id: "mikan-site",
    name: "蜜柑计划站点",
    kind: "site_adapter",
    enabled: false,
    useProxy: true,
    requestIntervalMs: 1_500,
    baseUrl: "https://mikanani.me/",
    tags: ["anime", "bt", "mikan"]
  },
  {
    id: "anibt",
    name: "AniBT",
    kind: "site_adapter",
    enabled: true,
    useProxy: false,
    requestIntervalMs: 3_000,
    baseUrl: "https://anibt.net/",
    tags: ["anime", "bt", "anibt", "rss"]
  },
  {
    id: "acgnx",
    name: "末日动漫资源库 ACGNX",
    kind: "site_adapter",
    enabled: false,
    useProxy: true,
    requestIntervalMs: 1_500,
    baseUrl: "https://share.acgnx.se/",
    tags: ["anime", "bt", "acgnx"]
  },
  {
    id: "nyaa",
    name: "Nyaa",
    kind: "site_adapter",
    enabled: false,
    useProxy: true,
    requestIntervalMs: 3_000,
    baseUrl: "https://nyaa.si/",
    tags: ["anime", "bt", "nyaa", "rss"]
  },
  {
    id: "acg-rip",
    name: "ACG.RIP",
    kind: "site_adapter",
    enabled: false,
    useProxy: true,
    requestIntervalMs: 3_000,
    baseUrl: "https://acg.rip/",
    tags: ["anime", "bt", "acg-rip", "rss"]
  }
];
