import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import { QbittorrentClient } from "../qbittorrent-client";
import { QbittorrentEngine } from "../qbittorrent-engine";
import {
  buildQbittorrentLaunchEnvironment,
  extractManagedTemporaryPassword,
  QbittorrentManagedService,
  resolveBundledQbittorrentBinary,
  toQbittorrentSeedingLimits,
  toQbittorrentSpeedLimitBytes
} from "../qbittorrent-managed-service";

const defaultSettings = new GenericDefaultSettingsProvider({
  downloads: "/test/Downloads",
  userData: "/test/UserData",
  cache: "/test/Cache",
  logs: "/test/Logs"
}).getSettings();

test("resolveBundledQbittorrentBinary 按平台和架构查找项目内置二进制", async () => {
  const root = await mkdtemp(join(tmpdir(), "ani-qbittorrent-"));
  const binaryDir = join(root, "win32-x64");
  const binaryPath = join(binaryDir, "qbittorrent-nox.exe");
  await mkdir(binaryDir, { recursive: true });
  await writeFile(binaryPath, "", "utf8");

  assert.equal(
    resolveBundledQbittorrentBinary({
      platform: "win32",
      arch: "x64",
      resourceRoots: [root]
    }),
    binaryPath
  );
});

test("resolveBundledQbittorrentBinary 不把 GUI 版 qBittorrent 当成托管核心", async () => {
  const root = await mkdtemp(join(tmpdir(), "ani-qbittorrent-gui-"));
  const binaryDir = join(root, "win32-x64");
  await mkdir(binaryDir, { recursive: true });
  await writeFile(join(binaryDir, "qbittorrent.exe"), "", "utf8");

  assert.equal(
    resolveBundledQbittorrentBinary({
      platform: "win32",
      arch: "x64",
      resourceRoots: [root]
    }),
    undefined
  );
});

test("buildQbittorrentLaunchEnvironment 为 macOS app bundle 注入插件和 OpenSSL 模块路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "ani-qbittorrent-macos-env-"));
  const contentsDir = join(root, "qbittorrent-nox.app", "Contents");
  const binaryDir = join(contentsDir, "MacOS");
  const pluginPath = join(contentsDir, "PlugIns");
  const opensslModulesPath = join(contentsDir, "Frameworks", "ossl-modules");
  const binaryPath = join(binaryDir, "qbittorrent-nox");
  await mkdir(binaryDir, { recursive: true });
  await mkdir(pluginPath, { recursive: true });
  await mkdir(opensslModulesPath, { recursive: true });
  await writeFile(binaryPath, "", "utf8");

  const env = buildQbittorrentLaunchEnvironment(binaryPath, {
    QT_PLUGIN_PATH: "/existing/plugins",
    OPENSSL_MODULES: "/existing/openssl-modules"
  });

  assert.equal(env.QT_PLUGIN_PATH, `${pluginPath}${delimiter}/existing/plugins`);
  assert.equal(env.OPENSSL_MODULES, opensslModulesPath);
});

test("buildQbittorrentLaunchEnvironment injects sibling plugin paths for Windows bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "ani-qbittorrent-win-env-"));
  const binaryDir = join(root, "win32-x64");
  const opensslModulesPath = join(binaryDir, "ossl-modules");
  const binaryPath = join(binaryDir, "qbittorrent-nox.exe");
  await mkdir(join(binaryDir, "sqldrivers"), { recursive: true });
  await mkdir(opensslModulesPath, { recursive: true });
  await writeFile(binaryPath, "", "utf8");

  const env = buildQbittorrentLaunchEnvironment(binaryPath, {
    QT_PLUGIN_PATH: "/existing/plugins",
    OPENSSL_MODULES: "/existing/openssl-modules"
  });

  assert.equal(env.QT_PLUGIN_PATH, `${binaryDir}${delimiter}/existing/plugins`);
  assert.equal(env.OPENSSL_MODULES, opensslModulesPath);
});

test("extractManagedTemporaryPassword parses localized and fallback startup output", () => {
  assert.equal(extractManagedTemporaryPassword("临时密码：HzjbaPR58\n你应该在程序首选项中设置密码"), "HzjbaPR58");
  assert.equal(
    extractManagedTemporaryPassword("WebUI http://localhost:18185 admin 未设置 WebUI 管理员密码 XyZ123abc"),
    "XyZ123abc"
  );
});

test("QbittorrentClient accepts qBittorrent 5 no-content login success", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": "SID=test-session; HttpOnly"
      }
    });
  });

  const client = new QbittorrentClient({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    password: "ani-tracker"
  });

  await client.login();
});

test("QbittorrentClient adds the Ani Tracker correlation tag", async (t) => {
  let addedBody: URLSearchParams | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/api/v2/auth/login")) {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }

    addedBody = init?.body as URLSearchParams;
    return new Response("Ok", { status: 200 });
  });

  const client = new QbittorrentClient({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    password: "ani-tracker"
  });
  await client.login();
  await client.addUrl("magnet:?xt=urn:btih:TEST", "/downloads", false, "ani-tracker-test");

  assert.equal(addedBody?.get("tags"), "ani-tracker-test");
});

test("QbittorrentClient 将添加接口的 Fails 响应视为失败", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }
    return new Response("Fails.", { status: 200 });
  });

  const client = new QbittorrentClient({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin"
  });
  await client.login();

  await assert.rejects(
    client.addUrl("magnet:?xt=urn:btih:TEST", "/downloads"),
    /qBittorrent add torrent failed: Fails\./
  );
});

test("QbittorrentClient 接受 Enhanced JSON 添加成功响应", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }
    return Response.json({
      added_torrent_ids: ["1e84ac58f835e635e98330dbbf2c77ae95abe6f4"],
      failure_count: 0,
      pending_count: 0,
      success_count: 1
    });
  });

  const client = new QbittorrentClient({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin"
  });
  await client.login();
  const result = await client.addUrl("magnet:?xt=urn:btih:TEST", "/downloads");

  assert.deepEqual(result, {
    torrentIds: ["1e84ac58f835e635e98330dbbf2c77ae95abe6f4"],
    successCount: 1,
    pendingCount: 0,
    failureCount: 0
  });
});

test("QbittorrentEngine 使用 Enhanced 返回的 hash 确认无标签任务", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }
    if (path === "/api/v2/torrents/add") {
      return Response.json({
        added_torrent_ids: ["confirmed-hash"],
        failure_count: 0,
        pending_count: 0,
        success_count: 1
      });
    }
    if (path === "/api/v2/torrents/info") {
      return Response.json([createQbittorrentTorrentInfo("")]);
    }
    if (path === "/api/v2/torrents/files") {
      return Response.json([]);
    }
    return new Response("Not Found", { status: 404 });
  });

  const engine = new QbittorrentEngine({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    addConfirmationTimeoutMs: 20,
    addConfirmationPollIntervalMs: 1
  });
  const task = await engine.addMagnet("magnet:?xt=urn:btih:ABC123", { savePath: "/downloads" });

  assert.equal(task.id, "confirmed-hash");
  assert.equal(task.torrentHash, "confirmed-hash");
});

test("QbittorrentClient 为 multipart 请求补齐结尾 CRLF", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ani-qbittorrent-multipart-"));
  const torrentPath = join(root, "test.torrent");
  await writeFile(torrentPath, "d4:infod4:name4:testee", "utf8");
  let submittedBody: Uint8Array | undefined;
  let contentType = "";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }
    submittedBody = init?.body as Uint8Array;
    contentType = new Headers(init?.headers).get("content-type") ?? "";
    return new Response("Ok.", { status: 200 });
  });

  const client = new QbittorrentClient({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin"
  });
  await client.login();
  await client.addTorrentFile(torrentPath, "/downloads", false, "ani-tracker-test");

  assert.match(contentType, /^multipart\/form-data; boundary=/);
  assert.equal(submittedBody?.at(-2), 0x0d);
  assert.equal(submittedBody?.at(-1), 0x0a);
  assert.match(Buffer.from(submittedBody ?? []).toString("utf8"), /ani-tracker-test/);
});

test("QbittorrentEngine 规范化污染标签并返回真实任务", async (t) => {
  let correlationTag = "";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }
    if (path === "/api/v2/torrents/add") {
      correlationTag = (init?.body as URLSearchParams).get("tags") ?? "";
      return new Response("Ok.", { status: 200 });
    }
    if (path === "/api/v2/torrents/info") {
      return Response.json([createQbittorrentTorrentInfo(`${correlationTag}\r\n------formdata-undici-boundary--`)]);
    }
    if (path === "/api/v2/torrents/files") {
      return Response.json([]);
    }
    return new Response("Not Found", { status: 404 });
  });

  const engine = new QbittorrentEngine({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    addConfirmationTimeoutMs: 20,
    addConfirmationPollIntervalMs: 1
  });
  const task = await engine.addMagnet("magnet:?xt=urn:btih:ABC123", { savePath: "/downloads" });

  assert.equal(task.id, "confirmed-hash");
  assert.equal(task.torrentHash, "confirmed-hash");
  assert.equal(task.correlationTag, correlationTag);
});

test("QbittorrentEngine 未确认真实任务时不返回占位任务", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }
    if (path === "/api/v2/torrents/info") {
      return Response.json([]);
    }
    return new Response("Ok.", { status: 200 });
  });

  const engine = new QbittorrentEngine({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    addConfirmationTimeoutMs: 5,
    addConfirmationPollIntervalMs: 1
  });

  await assert.rejects(
    engine.addMagnet("magnet:?xt=urn:btih:NOTCONFIRMED", { savePath: "/downloads" }),
    /未在 5ms 内确认新增任务/
  );
});

test("QbittorrentClient uses qBittorrent 5 start and stop action endpoints", async (t) => {
  const requestedPaths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }

    requestedPaths.push(path);
    return new Response("Ok", { status: 200 });
  });

  const client = new QbittorrentClient({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    password: "ani-tracker"
  });
  await client.login();
  await client.pause("test-hash");
  await client.resume("test-hash");

  assert.deepEqual(requestedPaths, ["/api/v2/torrents/stop", "/api/v2/torrents/start"]);
});

test("QbittorrentClient falls back to qBittorrent 4 pause and resume endpoints", async (t) => {
  const requestedPaths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }

    requestedPaths.push(path);
    return new Response(path === "/api/v2/torrents/stop" || path === "/api/v2/torrents/start" ? "Not Found" : "Ok", {
      status: path === "/api/v2/torrents/stop" || path === "/api/v2/torrents/start" ? 404 : 200
    });
  });

  const client = new QbittorrentClient({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    password: "ani-tracker"
  });
  await client.login();
  await client.pause("test-hash");
  await client.resume("test-hash");

  assert.deepEqual(requestedPaths, [
    "/api/v2/torrents/stop",
    "/api/v2/torrents/pause",
    "/api/v2/torrents/start",
    "/api/v2/torrents/resume"
  ]);
});

test("QbittorrentClient applies global transfer speed limits", async (t) => {
  const requestBodies = new Map<string, URLSearchParams>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }

    requestBodies.set(url.pathname, init?.body as URLSearchParams);
    return new Response("Ok", { status: 200 });
  });

  const client = new QbittorrentClient({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    password: "ani-tracker"
  });
  await client.login();
  await client.setGlobalSpeedLimits(toQbittorrentSpeedLimitBytes(1024), toQbittorrentSpeedLimitBytes(256));

  assert.equal(requestBodies.get("/api/v2/transfer/setDownloadLimit")?.get("limit"), "1048576");
  assert.equal(requestBodies.get("/api/v2/transfer/setUploadLimit")?.get("limit"), "262144");
});

test("QbittorrentClient applies seeding targets and pauses torrents after either limit", async (t) => {
  let preferences: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }

    const body = init?.body as URLSearchParams;
    preferences = JSON.parse(body.get("json") ?? "{}") as Record<string, unknown>;
    return new Response("Ok", { status: 200 });
  });

  const client = new QbittorrentClient({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    password: "ani-tracker"
  });
  await client.login();
  await client.setGlobalSeedingLimits({ ratioLimit: 1.5, timeLimitMinutes: 90 });

  assert.deepEqual(preferences, {
    max_ratio_enabled: true,
    max_ratio: 1.5,
    max_seeding_time_enabled: true,
    max_seeding_time: 90,
    max_ratio_act: 0
  });
});

test("toQbittorrentSeedingLimits honors the master switch and per-target switches", () => {
  assert.deepEqual(toQbittorrentSeedingLimits(defaultSettings.download.qbittorrent.seedingLimits), {
    ratioLimit: 0,
    timeLimitMinutes: -1
  });
  assert.deepEqual(
    toQbittorrentSeedingLimits({
      enabled: true,
      ratioEnabled: false,
      ratioLimit: 1.25,
      timeEnabled: false,
      timeLimitMinutes: 45
    }),
    {
      ratioLimit: -1,
      timeLimitMinutes: -1
    }
  );
  assert.deepEqual(
    toQbittorrentSeedingLimits({
      enabled: true,
      ratioEnabled: true,
      ratioLimit: 1.25,
      timeEnabled: true,
      timeLimitMinutes: 45
    }),
    {
      ratioLimit: 1.25,
      timeLimitMinutes: 45
    }
  );
});

/** 创建用于 qBittorrent Engine 确认流程的任务响应。 */
function createQbittorrentTorrentInfo(tags: string) {
  return {
    hash: "confirmed-hash",
    name: "confirmed torrent",
    state: "downloading",
    progress: 0,
    dlspeed: 0,
    upspeed: 0,
    eta: 60,
    save_path: "/downloads",
    tags
  };
}

test("QbittorrentManagedService 对托管启动避开 10000 以下 WebUI 端口", async () => {
  const service = new QbittorrentManagedService();
  const status = await service.start({
    ...defaultSettings,
    download: {
      ...defaultSettings.download,
      qbittorrent: {
        ...defaultSettings.download.qbittorrent,
        baseUrl: "http://127.0.0.1:8080",
        managed: {
          ...defaultSettings.download.qbittorrent.managed,
          enabled: true,
          binaryPath: join(tmpdir(), "ani-missing-qbittorrent-nox")
        }
      }
    }
  });

  assert.equal(status.running, false);
  assert.ok(Number(new URL(status.webUiUrl).port) >= 10_000);
  assert.match(status.lastError ?? "", /未找到项目内置/);
});
