#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { findDesktopLibVlcAsset } from "./libvlc-resource-manifest.mjs";

const options = parseArgs(process.argv.slice(2));
const asset = findDesktopLibVlcAsset(options.platform, options.arch);
if (!asset) throw new Error(`[libvlc] unsupported target: ${options.platform}-${options.arch}`);
if (!(await isDirectory(options.root))) throw new Error(`[libvlc] package root missing: ${options.root}`);

const directories = await listDirectories(options.root);
const runtimeDirectories = directories.filter((path) =>
  basename(path) === asset.targetKey && basename(dirname(path)) === "libvlc"
);
if (runtimeDirectories.length === 0) {
  throw new Error(`[libvlc] packaged runtime not found: libvlc/${asset.targetKey}`);
}

let totalPlugins = 0;
for (const runtimeDirectory of runtimeDirectories) {
  totalPlugins += await verifyRuntime(runtimeDirectory, asset, options.checkDynamic);
}

if (!options.skipBinding) {
  const files = await listFiles(options.root);
  const bindings = files.filter((path) =>
    basename(path) === "vlc_binding.node"
    && path.replaceAll("\\", "/").includes("electron-vlc-player")
    && path.replaceAll("\\", "/").includes("app.asar.unpacked")
  );
  if (bindings.length === 0) {
    throw new Error("[libvlc] unpacked electron-vlc-player native binding was not found");
  }
  for (const binding of bindings) {
    if ((await stat(binding)).size === 0) throw new Error(`[libvlc] native binding is empty: ${binding}`);
  }
  console.log(`[libvlc] verified native bindings: ${bindings.length}`);
}

console.log(`[libvlc] packaged runtime verified: ${runtimeDirectories.length} copies, ${totalPlugins} plugins`);

/** 校验安装目录中的核心库、插件、许可证和来源元数据。 */
async function verifyRuntime(directory, currentAsset, checkDynamic) {
  const files = await listFiles(directory);
  const normalizedFiles = files.map((path) => ({ path, name: basename(path) }));
  const corePatterns = currentAsset.platform === "win32"
    ? [/^libvlc\.dll$/i, /^libvlccore\.dll$/i]
    : currentAsset.platform === "darwin"
      ? [/^libvlc(?:\.\d+)?\.dylib$/, /^libvlccore(?:\.\d+)?\.dylib$/]
      : [/^libvlc\.so(?:\..+)?$/, /^libvlccore\.so(?:\..+)?$/];
  const coreLibraries = corePatterns.map((pattern) => normalizedFiles.find((file) => pattern.test(file.name))?.path);
  if (coreLibraries.some((path) => !path)) {
    throw new Error(`[libvlc] packaged core libraries incomplete: ${directory}`);
  }

  const pluginMarker = `${join(directory, "plugins").replaceAll("\\", "/")}/`;
  const pluginFiles = normalizedFiles.filter((file) => {
    const normalized = file.path.replaceAll("\\", "/");
    if (!normalized.startsWith(pluginMarker)) return false;
    if (currentAsset.platform === "win32") return file.name.endsWith(".dll");
    if (currentAsset.platform === "darwin") return file.name.endsWith(".dylib");
    return /\.so(?:\.|$)/.test(file.name);
  });
  if (pluginFiles.length < 10) throw new Error(`[libvlc] packaged plugin set incomplete: ${directory}`);

  const requiredFiles = [
    join(directory, "SOURCE.json"),
    join(directory, "LICENSES", "README.md"),
    join(directory, "LICENSES", "SOURCE.md"),
    join(directory, "LICENSES", "LGPL-2.1-only.json"),
    join(directory, "LICENSES", "VLC-COPYING-GPL-2.0.txt"),
    join(directory, "LICENSES", "VLC-COPYING-LGPL-2.1.txt"),
    join(directory, "LICENSES", "electron-vlc-player-MIT.txt")
  ];
  for (const path of requiredFiles) {
    if (!(await isFile(path))) throw new Error(`[libvlc] packaged notice missing: ${path}`);
  }
  const source = JSON.parse(await readFile(join(directory, "SOURCE.json"), "utf8"));
  if (
    source.target !== currentAsset.targetKey
    || !/^3\.0(?:\.|$)/.test(String(source.version))
    || typeof source.sourceCodeUrl !== "string"
    || source.sourceCodeUrl.length === 0
  ) {
    throw new Error(`[libvlc] packaged source metadata invalid: ${directory}`);
  }

  if (checkDynamic && currentAsset.platform === "linux") {
    for (const sharedLibrary of [...new Set([...coreLibraries, ...pluginFiles.map((file) => file.path)])]) {
      const result = spawnSync("ldd", [sharedLibrary], { encoding: "utf8" });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (result.status !== 0 || /not found/i.test(output)) {
        throw new Error(`[libvlc] unresolved Linux dependency for ${sharedLibrary}: ${output.trim()}`);
      }
    }
  }
  return pluginFiles.length;
}

/** 递归列出目录下全部目录。 */
async function listDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = join(root, entry.name);
    return [path, ...(await listDirectories(path))];
  }));
  return nested.flat();
}

/** 递归列出目录下全部普通文件和符号链接。 */
async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

/** 判断路径是否为目录。 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 判断路径是否为文件或指向文件的符号链接。 */
async function isFile(path) {
  try {
    const value = await lstat(path);
    return value.isFile() || value.isSymbolicLink();
  } catch {
    return false;
  }
}

/** 解析安装包根目录、目标平台和动态依赖检查开关。 */
function parseArgs(args) {
  const parsed = {
    root: resolve("release"),
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
    checkDynamic: false,
    skipBinding: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--check-dynamic") {
      parsed.checkDynamic = true;
      continue;
    }
    if (arg === "--skip-binding") {
      parsed.skipBinding = true;
      continue;
    }
    if (["--root", "--platform", "--arch"].includes(arg)) {
      const value = readValue(args, index, arg);
      index += 1;
      if (arg === "--root") parsed.root = resolve(value);
      if (arg === "--platform") parsed.platform = value;
      if (arg === "--arch") parsed.arch = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

/** 读取命令行参数后的必填值。 */
function readValue(args, index, arg) {
  const value = args[index + 1];
  if (!value) throw new Error(`${arg} requires a value`);
  return value;
}
