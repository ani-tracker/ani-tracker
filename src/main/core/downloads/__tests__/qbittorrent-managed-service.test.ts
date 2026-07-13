import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import { QbittorrentManagedService, resolveBundledQbittorrentBinary } from "../qbittorrent-managed-service";

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
          enabled: true
        }
      }
    }
  });

  assert.equal(status.running, false);
  assert.ok(Number(new URL(status.webUiUrl).port) >= 10_000);
  assert.match(status.lastError ?? "", /未找到项目内置/);
});
