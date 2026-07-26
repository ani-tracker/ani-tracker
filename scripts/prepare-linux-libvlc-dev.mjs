#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { findDesktopLibVlcAsset } from "./libvlc-resource-manifest.mjs";

const options = parseArgs(process.argv.slice(2));
if (process.platform !== "linux") {
  throw new Error(`[libvlc] Linux development preparation requires linux, received: ${process.platform}`);
}

const asset = findDesktopLibVlcAsset("linux", options.arch);
if (!asset) throw new Error(`[libvlc] unsupported Linux architecture: ${options.arch}`);
for (const directory of [options.sourceRoot, options.sharedDataRoot, options.licenseRoot]) {
  if (!(await isDirectory(directory))) throw new Error(`[libvlc] required Linux directory is missing: ${directory}`);
}

const rawVersion = captureCommand("dpkg-query", ["-W", "-f=${Version}", "vlc"]);
const version = rawVersion.replace(/^\d+:/, "");
if (!/^3\.0(?:\.|$)/.test(version)) {
  throw new Error(`[libvlc] VLC 3.0.x is required, received: ${version}`);
}
const sourceCodeUrl = `https://launchpad.net/ubuntu/+source/vlc/${encodeURIComponent(rawVersion)}`;

runCommand(process.execPath, [
  resolve("scripts/prepare-libvlc-resources.mjs"),
  "--platform", "linux",
  "--arch", options.arch,
  "--version", version,
  "--source", options.sourceRoot,
  "--shared-data", options.sharedDataRoot,
  "--license-root", options.licenseRoot,
  "--source-url", "https://packages.ubuntu.com/jammy/vlc",
  "--source-code-url", sourceCodeUrl,
  "--target", options.targetRoot,
  "--required"
]);
runCommand(process.execPath, [
  resolve("scripts/prepare-libvlc-resources.mjs"),
  "--platform", "linux",
  "--arch", options.arch,
  "--target", options.targetRoot,
  "--required",
  "--verify-only"
]);
diagnoseRuntime(resolve(options.targetRoot, asset.targetKey));
runCommand("cargo", [
  "test",
  "-p", "tauri-plugin-ani-player",
  "loads_prepared_libvlc_runtime_when_available",
  "--", "--nocapture"
], {
  ...process.env,
  ANI_LIBVLC_TARGET: asset.targetKey,
  ANI_REQUIRE_PREPARED_LIBVLC: "1"
});

console.log(`[libvlc] Linux Tauri runtime ready: ${resolve(options.targetRoot, asset.targetKey)}`);

/** 执行子命令并保留原始日志，任何非零退出码都会终止准备流程。 */
function runCommand(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[libvlc] command failed (${result.status ?? "unknown"}): ${command}`);
  }
}

/** 输出 Linux 核心动态库依赖，并在存在未解析依赖时立即失败。 */
function diagnoseRuntime(targetDirectory) {
  const library = resolve(targetDirectory, "libvlc.so.5");
  const result = spawnSync("ldd", [library], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0 || /\bnot found\b/.test(result.stdout ?? "")) {
    throw new Error(`[libvlc] unresolved Linux runtime dependency: ${library}`);
  }
}

/** 执行只返回单行文本的系统探测命令。 */
function captureCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  const output = result.stdout?.trim();
  if (result.status !== 0 || !output) {
    throw new Error(`[libvlc] command failed (${result.status ?? "unknown"}): ${command}`);
  }
  return output;
}

/** 判断路径是否为目录。 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 解析 Linux 架构、系统运行库目录和输出目录。 */
function parseArgs(args) {
  const parsed = {
    arch: process.arch,
    sourceRoot: "/usr/lib/x86_64-linux-gnu",
    sharedDataRoot: "/usr/share/vlc",
    licenseRoot: "/usr/share/common-licenses",
    targetRoot: resolve("out", "libvlc")
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (["--arch", "--source", "--shared-data", "--license-root", "--target"].includes(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--arch") parsed.arch = value;
      if (arg === "--source") parsed.sourceRoot = resolve(value);
      if (arg === "--shared-data") parsed.sharedDataRoot = resolve(value);
      if (arg === "--license-root") parsed.licenseRoot = resolve(value);
      if (arg === "--target") parsed.targetRoot = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
