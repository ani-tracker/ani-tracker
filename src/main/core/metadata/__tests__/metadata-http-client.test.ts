import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Session } from "electron";
import type { MetadataProxySettings } from "@shared/domain";
import {
  MetadataHttpClient,
  resolveMetadataSessionProfile,
  type MetadataHttpRuntime
} from "../metadata-http-client";

const directSettings: MetadataProxySettings = {
  mode: "off",
  timeoutMs: 15_000
};

test("MetadataHttpClient 直连模式优先使用 Electron Session", async () => {
  let sessionFetchCount = 0;
  let fallbackFetchCount = 0;
  const session = {
    fetch: async () => {
      sessionFetchCount += 1;
      return new Response("chromium", { status: 200 });
    }
  } as unknown as Session;
  const runtime: MetadataHttpRuntime = {
    getSession: async (settings) => {
      assert.equal(settings.mode, "off");
      return session;
    },
    fallbackFetch: async () => {
      fallbackFetchCount += 1;
      return new Response("node", { status: 200 });
    }
  };

  const response = await new MetadataHttpClient(directSettings, runtime).fetch("https://anibt.net/rss/magnets.xml");

  assert.equal(await response.text(), "chromium");
  assert.equal(sessionFetchCount, 1);
  assert.equal(fallbackFetchCount, 0);
});

test("MetadataHttpClient 在 Electron Session 不可用时回退 Node fetch", async () => {
  let fallbackFetchCount = 0;
  const runtime: MetadataHttpRuntime = {
    getSession: async () => null,
    fallbackFetch: async () => {
      fallbackFetchCount += 1;
      return new Response("fallback", { status: 200 });
    }
  };

  const response = await new MetadataHttpClient(directSettings, runtime).fetch("https://example.test/feed.xml");

  assert.equal(await response.text(), "fallback");
  assert.equal(fallbackFetchCount, 1);
});

test("MetadataHttpClient 将直连与代理模式映射到独立 Session", () => {
  assert.deepEqual(resolveMetadataSessionProfile(directSettings), {
    partition: "metadata-direct",
    proxyConfig: { mode: "direct" }
  });
  assert.deepEqual(resolveMetadataSessionProfile({ mode: "system", timeoutMs: 15_000 }), {
    partition: "metadata-proxy",
    proxyConfig: { mode: "system" }
  });
  assert.deepEqual(resolveMetadataSessionProfile({
    mode: "manual",
    url: "http://127.0.0.1:7890",
    timeoutMs: 15_000
  }), {
    partition: "metadata-proxy",
    proxyConfig: {
      mode: "fixed_servers",
      proxyRules: "http://127.0.0.1:7890",
      proxyBypassRules: "127.0.0.1,localhost,<local>"
    }
  });
});
