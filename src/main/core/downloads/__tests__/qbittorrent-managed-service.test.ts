import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import { QbittorrentClient } from "../qbittorrent-client";
import {
  buildQbittorrentLaunchEnvironment,
  extractManagedTemporaryPassword,
  QbittorrentManagedService,
  resolveBundledQbittorrentBinary,
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
