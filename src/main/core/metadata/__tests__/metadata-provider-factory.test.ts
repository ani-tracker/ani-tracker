import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { MetadataProxySettings } from "@shared/domain";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import {
  createAnimeMetadataProviders,
  resolveMetadataProviderProxySettings
} from "../metadata-provider-factory";

const paths = {
  downloads: "/tmp/ani-downloads",
  userData: "/tmp/ani-user-data",
  cache: "/tmp/ani-cache",
  logs: "/tmp/ani-logs"
};

test("元数据 Provider 工厂为 AniList 固定直连并让其他来源沿用配置", () => {
  const settings = new GenericDefaultSettingsProvider(paths).getSettings();
  const createdModes: MetadataProxySettings[] = [];
  const providers = createAnimeMetadataProviders(settings, undefined, {
    createHttpClient: (proxySettings) => {
      createdModes.push({ ...proxySettings });
      return { fetch: async () => new Response("ok") };
    }
  });

  assert.deepEqual(providers.map((provider) => provider.id), ["bangumi", "anilist", "mikan"]);
  assert.equal(createdModes[0].mode, "system");
  assert.equal(createdModes[1].mode, "off");
});

test("元数据来源代理策略仅覆盖 AniList", () => {
  const configured: MetadataProxySettings = {
    mode: "manual",
    url: "http://127.0.0.1:7890",
    timeoutMs: 20_000
  };

  assert.deepEqual(resolveMetadataProviderProxySettings("anilist", configured), {
    mode: "off",
    timeoutMs: 20_000
  });
  assert.deepEqual(resolveMetadataProviderProxySettings("bangumi", configured), configured);
  assert.deepEqual(resolveMetadataProviderProxySettings("mikan", configured), configured);
});
