import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const APP_NAME = "Ani Tracker";
const MAC_BUNDLE_SCHEMA_VERSION = 2;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const require = createRequire(import.meta.url);

/** 运行 electron-vite，并在 macOS 开发环境使用带产品名称的 Electron Bundle。 */
async function main() {
  const electronVitePackagePath = require.resolve("electron-vite/package.json");
  const electronViteCliPath = join(dirname(electronVitePackagePath), "bin", "electron-vite.js");
  const environment = { ...process.env };

  if (process.platform === "darwin") {
    environment.ELECTRON_EXEC_PATH = await prepareMacElectronBundle();
  }

  const child = spawn(process.execPath, [electronViteCliPath, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
    detached: process.platform !== "win32"
  });
  let shutdownSignal;
  let shutdownTimer;

  const signalHandlers = new Map([
    ["SIGINT", () => forwardSignal("SIGINT")],
    ["SIGTERM", () => forwardSignal("SIGTERM")]
  ]);

  /** 将退出信号转发给 electron-vite 及其派生进程，并等待它们清理资源。 */
  function forwardSignal(signal) {
    if (shutdownSignal) {
      return;
    }

    shutdownSignal = signal;
    console.info("[electron-dev] 正在停止开发环境", { signal });
    terminateChild(child, signal);
    shutdownTimer = setTimeout(() => {
      console.warn("[electron-dev] 开发环境未及时退出，正在强制停止");
      terminateChild(child, "SIGKILL");
    }, SHUTDOWN_TIMEOUT_MS);
    shutdownTimer.unref();
  }

  /** 清理父进程注册的信号监听和退出定时器。 */
  function cleanup() {
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
    }
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  }

  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }

  child.once("error", (error) => {
    cleanup();
    console.error("[electron-dev] 启动 electron-vite 失败", error);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    process.exitCode = shutdownSignal === "SIGINT"
      ? 130
      : shutdownSignal === "SIGTERM"
        ? 143
        : code ?? (signal ? 1 : 0);
  });
}

/** 结束 electron-vite；POSIX 下同时结束同一进程组内的 Electron 等子进程。 */
function terminateChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      console.error("[electron-dev] 停止开发环境失败", error);
    }
  }
}

/** 准备不修改原始依赖的 macOS 开发 Bundle，并返回 Electron 可执行文件路径。 */
async function prepareMacElectronBundle() {
  const electronExecutablePath = require("electron");
  const electronPackage = require("electron/package.json");
  const sourceBundlePath = resolve(dirname(electronExecutablePath), "../..");
  const sourceInfoPath = join(sourceBundlePath, "Contents", "Info.plist");
  const sourceInfo = await stat(sourceInfoPath);
  const cacheDirectory = resolve("node_modules", ".cache", "ani-tracker-electron");
  const targetBundlePath = join(cacheDirectory, `${APP_NAME}.app`);
  const targetExecutablePath = join(targetBundlePath, "Contents", "MacOS", "Electron");
  const markerPath = join(cacheDirectory, "bundle-version.json");
  const expectedMarker = {
    schemaVersion: MAC_BUNDLE_SCHEMA_VERSION,
    electronVersion: electronPackage.version,
    sourceInfoMtimeMs: sourceInfo.mtimeMs,
    appName: APP_NAME
  };

  if (existsSync(targetExecutablePath) && await markerMatches(markerPath, expectedMarker)) {
    console.info("[electron-dev] 复用 macOS 开发 Bundle", { appName: APP_NAME });
    return targetExecutablePath;
  }

  await mkdir(cacheDirectory, { recursive: true });
  const temporaryBundlePath = join(cacheDirectory, `${APP_NAME}.app.tmp`);
  await rm(temporaryBundlePath, { recursive: true, force: true });
  await rm(targetBundlePath, { recursive: true, force: true });

  const copyResult = spawnSync("cp", ["-cR", sourceBundlePath, temporaryBundlePath], {
    encoding: "utf8"
  });
  if (copyResult.status !== 0) {
    throw new Error(`复制 macOS Electron Bundle 失败：${copyResult.stderr || copyResult.stdout}`);
  }

  const targetInfoPath = join(temporaryBundlePath, "Contents", "Info.plist");
  updatePlistValue(targetInfoPath, "CFBundleDisplayName", APP_NAME);
  await rename(temporaryBundlePath, targetBundlePath);
  await writeFile(markerPath, `${JSON.stringify(expectedMarker, null, 2)}\n`, "utf8");
  console.info("[electron-dev] 已准备 macOS 开发 Bundle", {
    appName: APP_NAME,
    electronVersion: electronPackage.version
  });
  return targetExecutablePath;
}

/** 判断缓存 Bundle 是否对应当前 Electron 版本和应用标识。 */
async function markerMatches(markerPath, expectedMarker) {
  try {
    const actualMarker = JSON.parse(await readFile(markerPath, "utf8"));
    return JSON.stringify(actualMarker) === JSON.stringify(expectedMarker);
  } catch {
    return false;
  }
}

/** 更新 macOS Info.plist 中指定的字符串字段。 */
function updatePlistValue(plistPath, key, value) {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`更新 macOS Bundle 字段 ${key} 失败：${result.stderr || result.stdout}`);
  }
}

await main();
