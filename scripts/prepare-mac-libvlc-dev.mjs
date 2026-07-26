#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import {
  DESKTOP_LIBVLC_SOURCE,
  DESKTOP_LIBVLC_VERSION,
  findDesktopLibVlcAsset
} from "./libvlc-resource-manifest.mjs";

const options = parseArgs(process.argv.slice(2));
if (process.platform !== "darwin") {
  throw new Error(`[libvlc] macOS development preparation requires darwin, received: ${process.platform}`);
}

const asset = findDesktopLibVlcAsset("darwin", options.arch);
if (!asset?.archiveName) throw new Error(`[libvlc] unsupported macOS architecture: ${options.arch}`);

const archivePath = resolve(options.cacheRoot, DESKTOP_LIBVLC_VERSION, asset.archiveName);
const sourceArchivePath = resolve(
  options.cacheRoot,
  DESKTOP_LIBVLC_VERSION,
  DESKTOP_LIBVLC_SOURCE.archiveName
);
const targetDirectory = resolve(options.targetRoot, asset.targetKey);

await downloadArchive(asset, archivePath, options.offline);
await downloadSourceArchive(sourceArchivePath, options.offline);
await stageRuntime(asset, archivePath, sourceArchivePath, options.targetRoot);
verifyRuntime(options.targetRoot, options.arch);
diagnoseRuntime(targetDirectory);
smokeTestTauriRuntime(asset.targetKey);

console.log(`[libvlc] macOS development runtime ready: ${targetDirectory}`);

/** 下载并校验当前架构的官方 VLC DMG。 */
async function downloadArchive(currentAsset, destination, offline) {
  const args = [
    resolve("scripts/download-libvlc-archive.mjs"),
    "--platform", "darwin",
    "--arch", currentAsset.arch,
    "--output", destination
  ];
  if (offline) args.push("--offline");
  runCommand(process.execPath, args);
}

/** 下载并校验包含完整上游许可证的 VLC 源码归档。 */
async function downloadSourceArchive(destination, offline) {
  const args = [
    resolve("scripts/download-libvlc-archive.mjs"),
    "--source-code",
    "--output", destination
  ];
  if (offline) args.push("--offline");
  runCommand(process.execPath, args);
}

/** 挂载 DMG，并将 libVLC 核心库、插件和许可证整理到 out。 */
async function stageRuntime(currentAsset, archive, sourceArchive, targetRoot) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ani-libvlc-"));
  const mountPoint = join(temporaryRoot, "mount");
  await mkdir(mountPoint);
  let attached = false;
  let failure;

  try {
    runCommand("hdiutil", ["attach", archive, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    attached = true;
    const sourceRoot = join(mountPoint, "VLC.app", "Contents", "MacOS");
    if (!(await isDirectory(sourceRoot))) {
      throw new Error(`[libvlc] VLC.app runtime missing in mounted image: ${sourceRoot}`);
    }
    const licenseRoot = await extractSourceLicenses(sourceArchive, temporaryRoot);

    runCommand(process.execPath, [
      resolve("scripts/prepare-libvlc-resources.mjs"),
      "--platform", "darwin",
      "--arch", currentAsset.arch,
      "--source", sourceRoot,
      "--license-root", licenseRoot,
      "--target", resolve(targetRoot),
      "--required"
    ]);
  } catch (error) {
    failure = error;
  } finally {
    if (attached) {
      try {
        detachImage(mountPoint);
      } catch (error) {
        if (!failure) failure = error;
        else console.warn(`[libvlc] failed to detach temporary image: ${errorMessage(error)}`);
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  if (failure) throw failure;
}

/** 从固定摘要的源码包中仅提取 GPL 与 LGPL 许可证文本。 */
async function extractSourceLicenses(sourceArchive, temporaryRoot) {
  const licenseRoot = join(temporaryRoot, "licenses");
  await mkdir(licenseRoot);
  const sourceDirectory = `vlc-${DESKTOP_LIBVLC_VERSION}`;
  runCommand("tar", [
    "-xf", sourceArchive,
    "-C", licenseRoot,
    "--strip-components=1",
    `${sourceDirectory}/COPYING`,
    `${sourceDirectory}/COPYING.LIB`
  ]);
  for (const name of ["COPYING", "COPYING.LIB"]) {
    const path = join(licenseRoot, name);
    if (!(await isFile(path))) throw new Error(`[libvlc] source license missing after extraction: ${path}`);
  }
  return licenseRoot;
}

/** 复用正式打包校验，确认整理后的运行时结构完整。 */
function verifyRuntime(targetRoot, arch) {
  runCommand(process.execPath, [
    resolve("scripts/prepare-libvlc-resources.mjs"),
    "--platform", "darwin",
    "--arch", arch,
    "--target", resolve(targetRoot),
    "--required",
    "--verify-only"
  ]);
}

/** 通过 Rust 动态 FFI 创建并释放 libVLC 实例和媒体播放器。 */
function smokeTestTauriRuntime(targetKey) {
  runCommand("cargo", [
    "test",
    "-p", "tauri-plugin-ani-player",
    "loads_prepared_libvlc_runtime_when_available",
    "--", "--nocapture"
  ], {
    ...process.env,
    ANI_LIBVLC_TARGET: targetKey,
    ANI_REQUIRE_PREPARED_LIBVLC: "1"
  });
}

/** 输出 macOS 核心 dylib 的架构和依赖，便于定位 CI 动态加载失败。 */
function diagnoseRuntime(targetDirectory) {
  const library = join(targetDirectory, "lib", "libvlc.dylib");
  runCommand("file", [library]);
  runCommand("otool", ["-L", library]);
}

/** 卸载本次创建的临时 DMG 挂载点，普通卸载失败时执行强制卸载。 */
function detachImage(mountPoint) {
  const result = spawnSync("hdiutil", ["detach", mountPoint], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === 0) return;
  runCommand("hdiutil", ["detach", "-force", mountPoint]);
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

/** 返回适合构建日志的错误说明。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
