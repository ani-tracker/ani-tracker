#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import {
  DESKTOP_LIBVLC_SOURCE,
  DESKTOP_LIBVLC_VERSION,
  findDesktopLibVlcAsset
} from "./libvlc-resource-manifest.mjs";

const options = parseArgs(process.argv.slice(2));
const asset = findDesktopLibVlcAsset(options.platform, options.arch);
if (!asset) throw new Error(`[libvlc] unsupported target: ${options.platform}-${options.arch}`);

const targetDirectory = join(options.targetRoot, asset.targetKey);
if (options.verifyOnly) {
  await verifyNormalizedRuntime(targetDirectory, asset, true);
  console.log(`[libvlc] verified staged runtime: ${targetDirectory}`);
  process.exit(0);
}

const sourceDirectory = options.sourceRoot ?? await resolveDefaultSource(asset);
if (!sourceDirectory || !(await isDirectory(sourceDirectory))) {
  await rm(targetDirectory, { recursive: true, force: true });
  if (options.required) {
    throw new Error(`[libvlc] runtime source is required for ${asset.targetKey}`);
  }
  console.warn(`[libvlc] runtime source unavailable for ${asset.targetKey}; desktop package will be rejected`);
  process.exit(0);
}
if (!/^3\.0(?:\.|$)/.test(options.version)) {
  throw new Error(`[libvlc] VLC 3.0.x is required, received: ${options.version}`);
}

await rm(targetDirectory, { recursive: true, force: true });
await mkdir(targetDirectory, { recursive: true });
if (asset.platform === "win32") await stageWindowsRuntime(sourceDirectory, targetDirectory);
if (asset.platform === "darwin") await stageMacRuntime(sourceDirectory, targetDirectory);
if (asset.platform === "linux") await stageLinuxRuntime(sourceDirectory, targetDirectory, options.sharedDataRoot);

const runtimePatches = asset.platform === "linux"
  ? await patchLinuxRpaths(targetDirectory, options.required)
  : [];
await stageLicenses(sourceDirectory, targetDirectory, options.licenseRoot, options.required);
const sourceCodeUrl = options.sourceCodeUrl
  ?? (asset.platform === "linux"
    ? "https://packages.ubuntu.com/source/jammy/vlc"
    : DESKTOP_LIBVLC_SOURCE.url);
const sourceCodeSha256 = options.sourceCodeSha256
  ?? (asset.platform === "linux" ? null : DESKTOP_LIBVLC_SOURCE.archiveSha256);
await writeFile(join(targetDirectory, "SOURCE.json"), `${JSON.stringify({
  project: "VLC media player / libVLC",
  version: options.version,
  target: asset.targetKey,
  runtimeSourceUrl: options.sourceUrl ?? asset.url ?? "https://packages.ubuntu.com/jammy/vlc",
  sourceCodeUrl,
  sourceCodeSha256,
  sourceCodeModified: false,
  runtimePatches
}, null, 2)}\n`, "utf8");

const summary = await verifyNormalizedRuntime(targetDirectory, asset, options.required);
console.log(`[libvlc] staged ${asset.targetKey}: ${summary.pluginCount} plugins, ${targetDirectory}`);

/** 整理 Windows 官方 VLC 目录中的核心 DLL、插件和脚本。 */
async function stageWindowsRuntime(source, destination) {
  await Promise.all([
    copyRequired(join(source, "libvlc.dll"), join(destination, "libvlc.dll")),
    copyRequired(join(source, "libvlccore.dll"), join(destination, "libvlccore.dll")),
    copyRequired(join(source, "plugins"), join(destination, "plugins"))
  ]);
  await copyOptionalDirectories(source, destination, ["hrtfs", "locale", "lua"]);
}

/** 整理 VLC.app 中可重定位的 dylib、插件和共享数据。 */
async function stageMacRuntime(source, destination) {
  await Promise.all([
    copyRequired(join(source, "lib"), join(destination, "lib")),
    copyRequired(join(source, "plugins"), join(destination, "plugins"))
  ]);
  await copyOptionalDirectories(source, destination, ["share", "lua"]);
}

/** 整理 Linux 发行版提供的 libVLC 核心库和插件目录。 */
async function stageLinuxRuntime(source, destination, sharedDataRoot) {
  const entries = await readdir(source, { withFileTypes: true });
  const coreNames = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => /^libvlc(?:core)?\.so(?:\..+)?$/.test(name));
  if (coreNames.length === 0) throw new Error(`[libvlc] Linux core libraries missing: ${source}`);
  await Promise.all(coreNames.map((name) => copyRequired(join(source, name), join(destination, name))));

  const vlcLibraryRoot = join(source, "vlc");
  if (await isDirectory(vlcLibraryRoot)) {
    const auxiliaryNames = (await readdir(vlcLibraryRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => /^libvlc_.+\.so(?:\..+)?$/.test(name));
    await Promise.all(auxiliaryNames.map((name) =>
      copyRequired(join(vlcLibraryRoot, name), join(destination, name))
    ));
  }

  const pluginSource = await firstExistingDirectory([
    join(source, "vlc", "plugins"),
    join(source, "plugins")
  ]);
  if (!pluginSource) throw new Error(`[libvlc] Linux plugin directory missing: ${source}`);
  await copyRequired(pluginSource, join(destination, "plugins"));

  const dataSource = sharedDataRoot && await isDirectory(sharedDataRoot) ? sharedDataRoot : undefined;
  if (dataSource) await copyRequired(dataSource, join(destination, "share"));
}

/** 为复制出的 Linux ELF 设置相对 RPATH，避免依赖 runner 的绝对目录。 */
async function patchLinuxRpaths(root, required) {
  const probe = spawnSync("patchelf", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    if (required) throw new Error("[libvlc] patchelf is required for Linux packaging");
    return [];
  }
  const files = await listFiles(root);
  let patchedCount = 0;
  for (const file of files) {
    const fileStat = await lstat(file);
    if (fileStat.isSymbolicLink() || !/\.so(?:\.|$)/.test(basename(file))) continue;
    const relativeRoot = relative(dirname(file), root).replaceAll("\\", "/");
    const rootRpath = relativeRoot ? `$ORIGIN/${relativeRoot}` : "$ORIGIN";
    const rpath = rootRpath === "$ORIGIN" ? "$ORIGIN" : `$ORIGIN:${rootRpath}`;
    const result = spawnSync("patchelf", ["--set-rpath", rpath, file], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`[libvlc] patchelf failed for ${file}: ${result.stderr?.trim()}`);
    }
    patchedCount += 1;
  }
  return patchedCount > 0
    ? [`Adjusted ELF RPATH on ${patchedCount} copied shared libraries; no VLC source code was modified.`]
    : [];
}

/** 将通用声明、完整许可证和上游 VLC 许可证放入运行时目录。 */
async function stageLicenses(source, destination, licenseRoot, required) {
  const output = join(destination, "LICENSES");
  await mkdir(output, { recursive: true });
  await copyRequired(resolve("resources", "licenses", "vlc"), output);
  const lgplJsonSource = resolve("resources", "ffmpeg", "licenses", "LGPL-2.1-only.json");
  await copyRequired(lgplJsonSource, join(output, "LGPL-2.1-only.json"));

  const roots = [licenseRoot, source].filter(Boolean);
  const copying = await firstExistingFile(roots.flatMap((root) => [
    join(root, "COPYING"),
    join(root, "COPYING.txt"),
    join(root, "GPL-2"),
    join(root, "GPL-2.0")
  ]));
  const copyingLib = await firstExistingFile(roots.flatMap((root) => [
    join(root, "COPYING.LIB"),
    join(root, "COPYING.LIB.txt"),
    join(root, "LGPL-2.1")
  ]));
  if (required && !copying) {
    throw new Error("[libvlc] upstream GPL COPYING text is required");
  }
  if (copying) await copyRequired(copying, join(output, "VLC-COPYING-GPL-2.0.txt"));
  if (copyingLib) {
    await copyRequired(copyingLib, join(output, "VLC-COPYING-LGPL-2.1.txt"));
  } else {
    const lgplDocument = JSON.parse(await readFile(lgplJsonSource, "utf8"));
    if (typeof lgplDocument.licenseText !== "string" || lgplDocument.licenseText.length < 1_000) {
      throw new Error("[libvlc] bundled LGPL-2.1 license text is invalid");
    }
    await writeFile(
      join(output, "VLC-COPYING-LGPL-2.1.txt"),
      `${lgplDocument.licenseText.trim()}\n`,
      "utf8"
    );
  }
}

/** 校验规范化运行时的核心库、插件、来源信息与许可证。 */
async function verifyNormalizedRuntime(directory, asset, requireUpstreamLicenses) {
  if (!(await isDirectory(directory))) throw new Error(`[libvlc] staged runtime missing: ${directory}`);
  const coreCandidates = asset.platform === "win32"
    ? [join(directory, "libvlc.dll"), join(directory, "libvlccore.dll")]
    : asset.platform === "darwin"
      ? [
          await findMatchingFile(join(directory, "lib"), /^libvlc(?:\.\d+)?\.dylib$/),
          await findMatchingFile(join(directory, "lib"), /^libvlccore(?:\.\d+)?\.dylib$/)
        ]
      : [
          await findMatchingFile(directory, /^libvlc\.so(?:\..+)?$/),
          await findMatchingFile(directory, /^libvlccore\.so(?:\..+)?$/)
        ];
  for (const path of coreCandidates) {
    if (!path || !(await isFileOrSymlink(path))) throw new Error(`[libvlc] core library missing: ${path ?? directory}`);
  }
  const pluginFiles = (await listFiles(join(directory, "plugins"))).filter((path) => {
    if (asset.platform === "win32") return path.endsWith(".dll");
    if (asset.platform === "darwin") return path.endsWith(".dylib");
    return /\.so(?:\.|$)/.test(path);
  });
  if (pluginFiles.length < 10) throw new Error(`[libvlc] plugin set is incomplete: ${pluginFiles.length}`);

  const metadata = JSON.parse(await readFile(join(directory, "SOURCE.json"), "utf8"));
  if (metadata.target !== asset.targetKey || !/^3\.0(?:\.|$)/.test(String(metadata.version))) {
    throw new Error(`[libvlc] invalid SOURCE.json: ${directory}`);
  }
  const licenses = [
    join(directory, "LICENSES", "README.md"),
    join(directory, "LICENSES", "SOURCE.md"),
    join(directory, "LICENSES", "LGPL-2.1-only.json"),
    join(directory, "LICENSES", "electron-vlc-player-MIT.txt")
  ];
  if (requireUpstreamLicenses) {
    licenses.push(
      join(directory, "LICENSES", "VLC-COPYING-GPL-2.0.txt"),
      join(directory, "LICENSES", "VLC-COPYING-LGPL-2.1.txt")
    );
  }
  for (const license of licenses) {
    if (!(await isFile(license))) throw new Error(`[libvlc] license file missing: ${license}`);
  }
  return { pluginCount: pluginFiles.length };
}

/** 复制必需文件或目录并保留相对符号链接。 */
async function copyRequired(source, destination) {
  await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
}

/** 复制存在的可选共享目录。 */
async function copyOptionalDirectories(source, destination, names) {
  for (const name of names) {
    const candidate = join(source, name);
    if (await isDirectory(candidate)) await copyRequired(candidate, join(destination, name));
  }
}

/** 递归列出目录下全部文件与符号链接。 */
async function listFiles(root) {
  if (!(await isDirectory(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

/** 在单层目录中查找匹配名称的文件。 */
async function findMatchingFile(root, pattern) {
  if (!(await isDirectory(root))) return undefined;
  const names = await readdir(root);
  const name = names.find((value) => pattern.test(value));
  return name ? join(root, name) : undefined;
}

/** 返回第一条存在的目录。 */
async function firstExistingDirectory(paths) {
  for (const path of paths) if (await isDirectory(path)) return path;
  return undefined;
}

/** 返回第一条存在的普通文件。 */
async function firstExistingFile(paths) {
  for (const path of paths) if (await isFile(path)) return path;
  return undefined;
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

/** 判断核心库路径是否为文件或符号链接。 */
async function isFileOrSymlink(path) {
  try {
    const value = await lstat(path);
    return value.isFile() || value.isSymbolicLink();
  } catch {
    return false;
  }
}

/** 探测开发机常见的 VLC 安装目录。 */
async function resolveDefaultSource(asset) {
  const candidates = asset.platform === "win32"
    ? [
        process.env.ProgramFiles && join(process.env.ProgramFiles, "VideoLAN", "VLC"),
        process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "VideoLAN", "VLC")
      ]
    : asset.platform === "darwin"
      ? ["/Applications/VLC.app/Contents/MacOS"]
      : asset.arch === "arm64"
        ? ["/usr/lib/aarch64-linux-gnu"]
        : ["/usr/lib/x86_64-linux-gnu"];
  for (const candidate of candidates.filter(Boolean)) {
    if (await isDirectory(candidate)) return candidate;
  }
  return undefined;
}

/** 解析来源、目标、平台和合规元数据参数。 */
function parseArgs(args) {
  const parsed = {
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
    version: DESKTOP_LIBVLC_VERSION,
    sourceRoot: undefined,
    sharedDataRoot: undefined,
    licenseRoot: undefined,
    sourceUrl: undefined,
    sourceCodeUrl: undefined,
    sourceCodeSha256: undefined,
    targetRoot: resolve("out", "libvlc"),
    required: false,
    verifyOnly: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--required") {
      parsed.required = true;
      continue;
    }
    if (arg === "--verify-only") {
      parsed.verifyOnly = true;
      continue;
    }
    if (["--platform", "--arch", "--version", "--source", "--shared-data", "--license-root", "--source-url", "--source-code-url", "--source-code-sha256", "--target"].includes(arg)) {
      const value = readValue(args, index, arg);
      index += 1;
      if (arg === "--platform") parsed.platform = value;
      if (arg === "--arch") parsed.arch = value;
      if (arg === "--version") parsed.version = value;
      if (arg === "--source") parsed.sourceRoot = resolve(value);
      if (arg === "--shared-data") parsed.sharedDataRoot = resolve(value);
      if (arg === "--license-root") parsed.licenseRoot = resolve(value);
      if (arg === "--source-url") parsed.sourceUrl = value;
      if (arg === "--source-code-url") parsed.sourceCodeUrl = value;
      if (arg === "--source-code-sha256") parsed.sourceCodeSha256 = value;
      if (arg === "--target") parsed.targetRoot = resolve(value);
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
