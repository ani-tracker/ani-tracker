import type { ReleaseSourceConfig } from "@shared/domain";

/** 提供首次启动和版本升级需要补齐的下载源配置。 */
export const defaultSourceConfigs: ReleaseSourceConfig[] = [
  {
    id: "mikan",
    name: "蜜柑计划 RSS",
    kind: "rss",
    enabled: false,
    rssUrl: "https://mikanani.me/RSS/Bangumi",
    tags: ["anime", "rss"]
  },
  {
    id: "dmhy",
    name: "动漫花园",
    kind: "site_adapter",
    enabled: false,
    baseUrl: "https://share.dmhy.org/",
    tags: ["anime", "bt"]
  },
  {
    id: "mikan-site",
    name: "蜜柑计划站点",
    kind: "site_adapter",
    enabled: false,
    baseUrl: "https://mikanani.me/",
    tags: ["anime", "bt", "mikan"]
  },
  {
    id: "anibt",
    name: "AniBT",
    kind: "site_adapter",
    enabled: true,
    baseUrl: "https://anibt.net/",
    tags: ["anime", "bt", "anibt", "rss"]
  },
  {
    id: "acgnx",
    name: "末日动漫资源库 ACGNX",
    kind: "site_adapter",
    enabled: false,
    baseUrl: "https://share.acgnx.se/",
    tags: ["anime", "bt", "acgnx"]
  },
  {
    id: "prowlarr",
    name: "Prowlarr Torznab",
    kind: "torznab",
    enabled: false,
    baseUrl: "http://127.0.0.1:9696",
    tags: ["torznab"]
  }
];
