#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  DESKTOP_LIBVLC_VERSION,
  findDesktopLibVlcAsset
} from "./libvlc-resource-manifest.mjs";

const options = parseArgs(process.argv.slice(2));
if (process.platform !== "win32") {
  throw new Error(`[libvlc] Windows development preparation requires win32, received: ${process.platform}`);
}

const asset = findDesktopLibVlcAsset("win32", options.arch);
if (!asset?.archiveName) throw new Error(`[libvlc] unsupported Windows architecture: ${options.arch}`);

const archivePath = resolve(options.cacheRoot, DESKTOP_LIBVLC_VERSION, asset.archiveName);
const targetDirectory = resolve(options.targetRoot, asset.targetKey);

await ensureWindowsBuildTools();
await downloadArchive(asset, archivePath, options.offline);
await stageRuntime(asset, archivePath, options.targetRoot);
rebuildNativeModules(options.arch);
await verifyNativeBinding();
verifyRuntime(options.targetRoot, options.arch);
smokeTestRuntime(targetDirectory);

console.log(`[libvlc] Windows development runtime ready: ${targetDirectory}`);

/** 在下载运行时前确认原生模块所需的 VS C++ 工具链存在。 */
async function ensureWindowsBuildTools() {
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!(await isFile(vswhere))) {
    throw new Error(
      "[libvlc] Visual Studio 2022 Build Tools is required with Desktop development with C++"
    );
  }
  const result = spawnSync(vswhere, [
    "-latest", "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath"
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error("[libvlc] Visual Studio 2022 C++ Build Tools installation was not found");
  }
}

/** 下载并校验当前架构的官方 VLC ZIP。 */
async function downloadArchive(currentAsset, destination, offline) {
  const args = [
    resolve("scripts/download-libvlc-archive.mjs"),
    "--platform", "win32",
    "--arch", currentAsset.arch,
    "--output", destination
  ];
  if (offline) args.push("--offline");
  runCommand(process.execPath, args);
}

/** 解压官方 ZIP，并整理为应用使用的 Windows libVLC 目录。 */
async function stageRuntime(currentAsset, archive, targetRoot) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ani-libvlc-win-"));
  const extractRoot = join(temporaryRoot, "runtime");
  await mkdir(extractRoot);
  try {
    runCommand(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        "Expand-Archive -LiteralPath $env:ANI_LIBVLC_ARCHIVE -DestinationPath $env:ANI_LIBVLC_EXTRACT -Force"
      ],
      {
        ...process.env,
        ANI_LIBVLC_ARCHIVE: archive,
        ANI_LIBVLC_EXTRACT: extractRoot
      }
    );
    const sourceRoot = join(extractRoot, `vlc-${DESKTOP_LIBVLC_VERSION}`);
    if (!(await isDirectory(sourceRoot))) {
      throw new Error(`[libvlc] VLC runtime missing after ZIP extraction: ${sourceRoot}`);
    }
    runCommand(process.execPath, [
      resolve("scripts/prepare-libvlc-resources.mjs"),
      "--platform", "win32",
      "--arch", currentAsset.arch,
      "--source", sourceRoot,
      "--target", resolve(targetRoot),
      "--required"
    ]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** 使用当前 Electron ABI 和目标架构重编译桌面原生模块。 */
function rebuildNativeModules(arch) {
  runPnpm(["exec", "electron-rebuild", "-f", "--only", "better-sqlite3", "-a", arch]);
  runPnpm([
    "exec", "electron-rebuild", "-f",
    "--module-dir", "node_modules/electron-vlc-player",
    "-a", arch
  ]);
}

/** 确认 electron-vlc-player 原生绑定已真实生成。 */
async function verifyNativeBinding() {
  const binding = resolve("node_modules/electron-vlc-player/build/Release/vlc_binding.node");
  const bindingStat = await stat(binding);
  if (!bindingStat.isFile() || bindingStat.size === 0) {
    throw new Error(`[libvlc] electron-vlc-player binding is missing or empty: ${binding}`);
  }
}

/** 复用正式打包校验，确认整理后的运行时结构完整。 */
function verifyRuntime(targetRoot, arch) {
  runCommand(process.execPath, [
    resolve("scripts/prepare-libvlc-resources.mjs"),
    "--platform", "win32",
    "--arch", arch,
    "--target", resolve(targetRoot),
    "--required",
    "--verify-only"
  ]);
}

/** 通过 Electron 加载原生模块和 libVLC，拦截 ABI 或 DLL 错误。 */
function smokeTestRuntime(runtimeDirectory) {
  runPnpm([
    "exec", "electron",
    resolve("scripts/smoke-libvlc-runtime.cjs"),
    runtimeDirectory
  ], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    ANI_LIBVLC_DIR: runtimeDirectory
  });
}

/** 通过当前 pnpm 入口执行命令，避免 Windows 无法直接启动 CMD shim。 */
function runPnpm(args, environment = process.env) {
  if (process.env.npm_execpath) {
    runCommand(process.execPath, [process.env.npm_execpath, ...args], environment);
    return;
  }
  runCommand("pnpm.cmd", args, environment, true);
}

/** 执行子命令并保留原始日志，任何非零退出码都会终止准备流程。 */
function runCommand(command, args, environment = process.env, shell = false) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    shell,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[libvlc] command failed (${result.status ?? "unknown"}): ${command}`);
  }
}

/** 判断路径是否为目录。 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 判断路径是否为普通文件。 */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 解析架构、缓存目录、输出目录和离线模式。 */
function parseArgs(args) {
  const parsed = {
    arch: process.arch,
    cacheRoot: resolve(".cache", "libvlc"),
    targetRoot: resolve("out", "libvlc"),
    offline: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--offline") {
      parsed.offline = true;
      continue;
    }
    if (["--arch", "--cache", "--target"].includes(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--arch") parsed.arch = value;
      if (arg === "--cache") parsed.cacheRoot = resolve(value);
      if (arg === "--target") parsed.targetRoot = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
