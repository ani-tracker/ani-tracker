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

await downloadArchive(asset, archivePath, options.offline);
await stageRuntime(asset, archivePath, options.targetRoot);
verifyRuntime(options.targetRoot, options.arch);
smokeTestTauriRuntime();

console.log(`[libvlc] Windows development runtime ready: ${targetDirectory}`);

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

/** 通过 Rust 动态 FFI 创建并释放 libVLC 实例和媒体播放器。 */
function smokeTestTauriRuntime() {
  runCommand("cargo.exe", [
    "test",
    "-p", "tauri-plugin-ani-player",
    "loads_prepared_libvlc_runtime_when_available",
    "--", "--nocapture"
  ]);
}

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
