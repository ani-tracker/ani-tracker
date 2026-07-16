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

test("QbittorrentEngine 使用代理客户端下载 torrent 并以 multipart 上传", async (t) => {
  const torrentData = Buffer.from("d4:infod4:name4:testee");
  let requestedTorrentUrl = "";
  let requestedSource = "";
  let uploadedBody: FormData | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }
    if (path === "/api/v2/torrents/info") {
      return Response.json([createQbittorrentTorrentInfo(url.searchParams.get("tag") ?? "")]);
    }
    if (path === "/api/v2/torrents/files") {
      return Response.json([]);
    }

    uploadedBody = init?.body as FormData;
    return new Response("Ok.", { status: 200 });
  });

  const engine = new QbittorrentEngine({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    password: "ani-tracker",
    torrentHttpClient: {
      async fetch(input, options) {
        requestedTorrentUrl = input.toString();
        requestedSource = options?.source ?? "";
        return new Response(torrentData, {
          status: 200,
          headers: {
            "content-type": "application/x-bittorrent",
            "content-length": String(torrentData.byteLength)
          }
        });
      }
    }
  });

  const task = await engine.addMagnet("https://mikanani.me/Download/test-file.torrent", {
    savePath: "/downloads"
  });

  const torrentPart = uploadedBody?.get("torrents");
  assert.equal(requestedTorrentUrl, "https://mikanani.me/Download/test-file.torrent");
  assert.equal(requestedSource, "torrent-download");
  assert.ok(torrentPart instanceof Blob);
  assert.deepEqual(Buffer.from(await torrentPart.arrayBuffer()), torrentData);
  assert.equal(uploadedBody?.get("savepath"), "/downloads");
  assert.match(String(uploadedBody?.get("tags")), /^ani-tracker-/);
  assert.equal(task.id, "confirmed-hash");
  assert.equal(task.torrentHash, "confirmed-hash");
});

test("QbittorrentEngine 拒绝把 torrent 错误页上传到 qBittorrent", async (t) => {
  let addRequestCount = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }

    addRequestCount += 1;
    return new Response("Ok.", { status: 200 });
  });

  const engine = new QbittorrentEngine({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    torrentHttpClient: {
      async fetch() {
        return new Response("<html>proxy error</html>", { status: 200 });
      }
    }
  });

  await assert.rejects(
    engine.addMagnet("https://mikanani.me/Download/error.torrent", { savePath: "/downloads" }),
    /not valid bencode metadata/
  );
  assert.equal(addRequestCount, 0);
});

test("QbittorrentEngine 保持 magnet URL 直传且不请求 torrent 文件", async (t) => {
  let addedBody: URLSearchParams | undefined;
  let torrentFetchCount = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }
    if (path === "/api/v2/torrents/info") {
      return Response.json([createQbittorrentTorrentInfo(url.searchParams.get("tag") ?? "")]);
    }
    if (path === "/api/v2/torrents/files") {
      return Response.json([]);
    }

    addedBody = init?.body as URLSearchParams;
    return new Response("Ok.", { status: 200 });
  });

  const engine = new QbittorrentEngine({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    torrentHttpClient: {
      async fetch() {
        torrentFetchCount += 1;
        return new Response(null, { status: 500 });
      }
    }
  });

  const task = await engine.addMagnet("magnet:?xt=urn:btih:ABC123", { savePath: "/downloads" });

  assert.equal(torrentFetchCount, 0);
  assert.equal(addedBody?.get("urls"), "magnet:?xt=urn:btih:ABC123");
  assert.equal(task.id, "confirmed-hash");
});

test("QbittorrentEngine 未查询到真实任务时不返回占位下载", async (t) => {
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

test("QbittorrentEngine 已确认任务时不因文件元数据尚未就绪而失败", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v2/auth/login") {
      return new Response(null, { status: 204, headers: { "set-cookie": "SID=test-session" } });
    }
    if (url.pathname === "/api/v2/torrents/info") {
      return Response.json([createQbittorrentTorrentInfo(url.searchParams.get("tag") ?? "")]);
    }
    if (url.pathname === "/api/v2/torrents/files") {
      return new Response("Metadata not ready", { status: 409 });
    }

    return new Response("Ok.", { status: 200 });
  });

  const engine = new QbittorrentEngine({
    baseUrl: "http://127.0.0.1:18080",
    username: "admin"
  });

  const task = await engine.addMagnet("magnet:?xt=urn:btih:METADATAPENDING", { savePath: "/downloads" });
  assert.equal(task.id, "confirmed-hash");
  assert.deepEqual(task.files, []);
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

function createQbittorrentTorrentInfo(tag: string) {
  return {
    hash: "confirmed-hash",
    name: "confirmed torrent",
    state: "downloading",
    progress: 0,
    dlspeed: 0,
    upspeed: 0,
    eta: 60,
    save_path: "/downloads",
    tags: tag
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
