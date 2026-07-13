import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import {
  buildQbittorrentLaunchEnvironment,
  QbittorrentManagedService,
  resolveBundledQbittorrentBinary
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
