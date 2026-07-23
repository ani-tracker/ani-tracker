import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import { EmbeddedTorrentEngine, mapCoreTask } from "../embedded-torrent-engine";
import {
  buildCoreConfiguration,
  EmbeddedTorrentCoreService,
  resolveBundledTorrentCoreBinary,
  type EmbeddedTorrentCoreClient
} from "../embedded-torrent-core-service";

const settings = new GenericDefaultSettingsProvider({
  downloads: "/test/Downloads",
  userData: "/test/UserData",
  cache: "/test/Cache",
  logs: "/test/Logs"
}).getSettings();

test("resolveBundledTorrentCoreBinary 按平台和架构查找核心", async () => {
  const root = await mkdtemp(join(tmpdir(), "ani-torrent-core-resolver-"));
  const binaryDir = join(root, "win32-x64");
  const binaryPath = join(binaryDir, "torrent-core.exe");
  await mkdir(binaryDir, { recursive: true });
  await writeFile(binaryPath, "", "utf8");

  assert.equal(resolveBundledTorrentCoreBinary({
    platform: "win32",
    arch: "x64",
    resourceRoots: [root]
  }), binaryPath);
});

test("buildCoreConfiguration 生成完整且有边界的核心参数", () => {
  assert.deepEqual(buildCoreConfiguration(settings), {
    listenPort: 51413,
    dhtEnabled: true,
    upnpEnabled: true,
    maxActiveDownloads: 3,
    maxDownloadSpeed: 0,
    maxUploadSpeed: 0,
    seedingLimits: {
      enabled: false,
      ratioEnabled: false,
      ratioLimit: 1,
      timeEnabled: false,
      timeLimitMinutes: 120
    }
  });
});

test("mapCoreTask 兼容 Boost property_tree 的字符串标量", () => {
  const task = mapCoreTask({
    id: "abc123",
    torrentHash: "abc123",
    name: "测试任务",
    status: "downloading",
    progress: "0.25",
    downloadSpeed: "1024",
    uploadSpeed: "128",
    etaSeconds: "60",
    savePath: "/downloads",
    createdAt: "2026-07-23T00:00:00Z",
    completedAt: "",
    files: [{
      index: "0",
      name: "episode.mkv",
      size: "2048",
      progress: "0.5",
      priority: "4",
      selected: "true"
    }]
  });

  assert.equal(task.engine, "embedded");
  assert.equal(task.progress, 0.25);
  assert.equal(task.downloadSpeed, 1024);
  assert.equal(task.completedAt, undefined);
  assert.deepEqual(task.files[0], {
    id: "abc123:0",
    index: 0,
    name: "episode.mkv",
    size: 2048,
    progress: 0.5,
    priority: 4,
    selected: true
  });
});

test("EmbeddedTorrentEngine 将任务控制命令转发给 sidecar", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client: EmbeddedTorrentCoreClient = {
    async execute<T>(
      method: Parameters<EmbeddedTorrentCoreClient["execute"]>[0],
      params: Record<string, unknown>
    ) {
      calls.push({ method, params });
      return { removed: "true" } as T;
    }
  };
  const engine = new EmbeddedTorrentEngine({ settings, client });

  await engine.remove("task-hash", true);
  assert.deepEqual(calls, [{
    method: "remove",
    params: { taskId: "task-hash", deleteFiles: true }
  }]);
});

const builtCorePath = join(process.cwd(), "native", "torrent-core", "build", "release", "torrent-core");
test("EmbeddedTorrentCoreService 与真实核心完成状态握手和优雅退出", {
  skip: !existsSync(builtCorePath)
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ani-torrent-core-smoke-"));
  const smokeSettings = {
    ...settings,
    storage: { ...settings.storage, userDataDir: dataDir }
  };
  const service = new EmbeddedTorrentCoreService({
    resolveBinary: () => builtCorePath,
    requestTimeoutMs: 5_000,
    stopTimeoutMs: 5_000
  });

  const started = await service.start(smokeSettings);
  assert.equal(started.running, true);
  assert.equal(started.version, "0.1.0");
  assert.equal(started.taskCount, 0);

  const stopped = await service.stop();
  assert.equal(stopped.running, false);
});
