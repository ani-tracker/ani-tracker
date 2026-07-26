import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import { DownloadServiceStatusService } from "../download-service-status-service";

const defaultSettings = new GenericDefaultSettingsProvider({
  downloads: "/test/Downloads",
  userData: "/test/UserData",
  cache: "/test/Cache",
  logs: "/test/Logs"
}).getSettings();

test("默认内置模式读取 libtorrent 核心状态", async () => {
  const calls: string[] = [];
  const service = new DownloadServiceStatusService({
    getEmbeddedStatus: () => {
      calls.push("embedded");
      return {
        enabled: true,
        running: true,
        platform: "darwin",
        arch: "x64",
        taskCount: 2
      };
    },
    getManagedStatus: () => {
      calls.push("managed");
      throw new Error("不应查询托管核心");
    },
    testExternalConnection: () => {
      calls.push("external");
      throw new Error("不应查询外部核心");
    }
  });

  assert.deepEqual(await service.getStatus(defaultSettings), {
    mode: "embedded",
    state: "online",
    message: "内置下载核心运行中",
    taskCount: 2
  });
  assert.deepEqual(calls, ["embedded"]);
});

test("托管模式只读取 qBittorrent-nox 进程状态", async () => {
  const settings = structuredClone(defaultSettings);
  settings.download.defaultTorrentEngine = "qbittorrent";
  settings.download.qbittorrent.managed.enabled = true;
  const service = new DownloadServiceStatusService({
    getEmbeddedStatus: () => Promise.reject(new Error("不应查询内置核心")),
    getManagedStatus: () => ({
      enabled: true,
      autoStart: true,
      running: false,
      webUiUrl: "http://127.0.0.1:18080/",
      platform: "linux",
      arch: "x64"
    }),
    testExternalConnection: () => Promise.reject(new Error("不应查询外部核心"))
  });

  assert.deepEqual(await service.getStatus(settings), {
    mode: "managed",
    state: "idle",
    message: "qBittorrent-nox 未运行"
  });
});

test("外部模式验证 WebUI 并返回任务数量", async () => {
  const settings = structuredClone(defaultSettings);
  settings.download.defaultTorrentEngine = "qbittorrent";
  settings.download.qbittorrent.managed.enabled = false;
  const service = new DownloadServiceStatusService({
    getEmbeddedStatus: () => Promise.reject(new Error("不应查询内置核心")),
    getManagedStatus: () => Promise.reject(new Error("不应查询托管核心")),
    testExternalConnection: () => ({ ok: true, message: "连接正常", taskCount: 3 })
  });

  assert.deepEqual(await service.getStatus(settings), {
    mode: "external",
    state: "online",
    message: "外部 qBittorrent 已连接",
    taskCount: 3
  });
});

test("状态查询异常转换为错误状态", async () => {
  const service = new DownloadServiceStatusService({
    getEmbeddedStatus: () => Promise.reject(new Error("核心握手失败")),
    getManagedStatus: () => Promise.reject(new Error("不应查询托管核心")),
    testExternalConnection: () => Promise.reject(new Error("不应查询外部核心"))
  });

  assert.deepEqual(await service.getStatus(defaultSettings), {
    mode: "embedded",
    state: "error",
    message: "核心握手失败"
  });
});

test("核心进程存在但状态包含错误时优先显示异常", async () => {
  const service = new DownloadServiceStatusService({
    getEmbeddedStatus: () => ({
      enabled: true,
      running: true,
      platform: "darwin",
      arch: "arm64",
      lastError: "核心状态请求超时"
    }),
    getManagedStatus: () => Promise.reject(new Error("不应查询托管核心")),
    testExternalConnection: () => Promise.reject(new Error("不应查询外部核心"))
  });

  assert.deepEqual(await service.getStatus(defaultSettings), {
    mode: "embedded",
    state: "error",
    message: "核心状态请求超时"
  });
});
