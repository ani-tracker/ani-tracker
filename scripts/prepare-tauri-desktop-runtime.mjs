#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const platformScript = {
  win32: "prepare:tauri:win-libvlc",
  darwin: "prepare:tauri:mac-libvlc",
  linux: "prepare:tauri:linux-libvlc"
}[process.platform];

if (!platformScript) {
  throw new Error(`[tauri-runtime] 不支持的桌面平台：${process.platform}`);
}

runPnpm("build:tauri:remote-renderer");
runPnpm(platformScript);
console.log(`[tauri-runtime] 桌面运行资源已准备：${process.platform}-${process.arch}`);

/** 执行项目脚本并透传日志，失败时返回稳定错误。 */
function runPnpm(script) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, ["run", script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[tauri-runtime] 脚本执行失败：${script}`);
  }
}
