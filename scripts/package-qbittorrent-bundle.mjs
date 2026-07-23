#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, cp, lstat, mkdir, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const QBITTORRENT_VERSION = "5.2.1.10";
const QBITTORRENT_UPSTREAM_VERSION = "5.2.1";
const LIBTORRENT_VERSION = "2.0.13";
const QT_VERSION = "6.8.3";
const VCPKG_VERSION = "2025.06.13";
const QBITTORRENT_SOURCE_SHA256 = "ee5e05db67ba52a9380b01501260473bcd6595b4750c5775c037ed3b6815e30b";
const LIBTORRENT_SOURCE_SHA256 = "892cb75c06318e2420de0faf9f63a908069d3d237676e2459fd30abe0cb3b1bf";
const SUPPORTED_TARGETS = new Set(["darwin-x64", "darwin-arm64", "linux-x64", "win32-x64"]);

const options = parseArgs(process.argv.slice(2));
const targetName = `${options.platform}-${options.arch}`;
if (!SUPPORTED_TARGETS.has(targetName)) throw new Error(`Unsupported target: ${targetName}`);
if (options.qtVersion !== QT_VERSION) {
  throw new Error(`Qt version must be ${QT_VERSION}, got ${options.qtVersion}`);
}
const outputDirectory = options.output ?? resolve("artifacts", "qbittorrent", targetName);
const archivePath = options.archive ?? resolve(
  "artifacts",
  "qbittorrent-packages",
  `qbittorrent-nox-${targetName}.tar.gz`
);

assertSafeOutput(outputDirectory, resolve("artifacts", "qbittorrent"));
assertSafeOutput(archivePath, resolve("artifacts", "qbittorrent-packages"));
await validateInput(options.input, options.platform);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(dirname(outputDirectory), { recursive: true });
await cp(options.input, outputDirectory, {
  recursive: true,
  dereference: false,
  verbatimSymlinks: true
});
await copyLicenses(outputDirectory, options);
await writeSourceRecord(outputDirectory, targetName, options);
await writeManifest(outputDirectory, targetName, options.qtVersion);

await mkdir(dirname(archivePath), { recursive: true });
await rm(archivePath, { force: true });
await execFileAsync("tar", [
  "-czf", archivePath,
  "-C", dirname(outputDirectory),
  basename(outputDirectory)
]);

console.log(`[qbittorrent] bundle staged: ${outputDirectory}`);
console.log(`[qbittorrent] archive created: ${archivePath}`);

/** 拷贝 qBittorrent 及其依赖许可证。 */
async function copyLicenses(directory, buildOptions) {
  const licensesDirectory = join(directory, "licenses");
  await mkdir(licensesDirectory, { recursive: true });
  const licenseCopies = [
    [join(buildOptions.qbittorrentSource, "COPYING"), "qbittorrent-COPYING.txt"],
    [join(buildOptions.qbittorrentSource, "COPYING.GPLv2"), "qbittorrent-GPL-2.0.txt"],
    [join(buildOptions.qbittorrentSource, "COPYING.GPLv3"), "qbittorrent-GPL-3.0.txt"],
    [join(buildOptions.libtorrentSource, "COPYING"), "libtorrent-BSD-3-Clause.txt"],
    [resolve("resources", "torrent-core", "licenses", "boost-BSL-1.0.txt"), "boost-BSL-1.0.txt"],
    [resolve("resources", "torrent-core", "licenses", "openssl-Apache-2.0.txt"), "openssl-Apache-2.0.txt"],
    [join(buildOptions.vcpkgInstalled, "share", "zlib", "copyright"), "zlib-license.txt"]
  ];

  const qtLicense = await findFirstExisting([
    join(buildOptions.qtRoot, "LICENSES", "LGPL-3.0-only.txt"),
    join(buildOptions.qtRoot, "LICENSES", "GPL-3.0-only.txt"),
    join(buildOptions.qbittorrentSource, "COPYING.GPLv3")
  ]);
  if (!qtLicense) throw new Error("Qt license file was not found");
  licenseCopies.push([qtLicense, "qt-GPL-or-LGPL-3.0.txt"]);

  for (const [source, name] of licenseCopies) {
    await stat(source);
    await cp(source, join(licensesDirectory, name));
  }
}

/** 生成独立产物的可追溯构建记录。 */
async function writeSourceRecord(directory, targetName, buildOptions) {
  const content = [
    "# qBittorrent-nox build source",
    "",
    `- Target: \`${targetName}\``,
    `- qBittorrent Enhanced Edition: \`${QBITTORRENT_VERSION}\``,
    `- Upstream qBittorrent baseline: \`${QBITTORRENT_UPSTREAM_VERSION}\``,
    `- libtorrent-rasterbar: \`${LIBTORRENT_VERSION}\``,
    `- Qt: \`${buildOptions.qtVersion}\``,
    `- vcpkg: \`${VCPKG_VERSION}\``,
    "- Build mode: GUI disabled, WebUI enabled, static Boost/OpenSSL/zlib/libtorrent, bundled dynamic Qt runtime",
    "- qBittorrent source: https://github.com/c0re100/qBittorrent-Enhanced-Edition/archive/refs/tags/release-5.2.1.10.tar.gz",
    `- qBittorrent source SHA-256: \`${QBITTORRENT_SOURCE_SHA256}\``,
    "- libtorrent source: https://github.com/arvidn/libtorrent/releases/download/v2.0.13/libtorrent-rasterbar-2.0.13.tar.gz",
    `- libtorrent source SHA-256: \`${LIBTORRENT_SOURCE_SHA256}\``,
    ""
  ].join("\n");
  await writeFile(join(directory, "SOURCE.md"), content, "utf8");
}

/** 为 bundle 内普通文件和符号链接生成完整性清单。 */
async function writeManifest(directory, targetName, qtVersion) {
  const files = [];
  for (const path of (await listEntries(directory)).sort()) {
    if (basename(path) === "manifest.json") continue;
    const itemStat = await lstat(path);
    const relativePath = relative(directory, path).replaceAll("\\", "/");
    if (itemStat.isSymbolicLink()) {
      files.push({
        path: relativePath,
        type: "symlink",
        target: await readlink(path)
      });
      continue;
    }
    files.push({
      path: relativePath,
      type: "file",
      size: itemStat.size,
      sha256: await sha256(path)
    });
  }

  const manifest = {
    schemaVersion: 2,
    target: targetName,
    qbittorrentVersion: QBITTORRENT_VERSION,
    qbittorrentUpstreamVersion: QBITTORRENT_UPSTREAM_VERSION,
    libtorrentVersion: LIBTORRENT_VERSION,
    qtVersion,
    generatedAt: new Date().toISOString(),
    files
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** 验证部署目录包含目标平台可执行文件。 */
async function validateInput(directory, platform) {
  const binary = platform === "win32"
    ? join(directory, "qbittorrent-nox.exe")
    : platform === "darwin"
      ? join(directory, "qbittorrent-nox.app", "Contents", "MacOS", "qbittorrent-nox")
      : join(directory, "qbittorrent-nox");
  const binaryStat = await stat(binary);
  if (!binaryStat.isFile()) throw new Error(`qBittorrent-nox binary is missing: ${binary}`);
}

/** 递归列出普通文件和符号链接。 */
async function listEntries(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await listEntries(path));
    if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
  }
  return paths;
}

/** 返回首个存在的路径。 */
async function findFirstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // 继续检查下一候选项。
    }
  }
  return undefined;
}

/** 计算文件 SHA-256。 */
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** 限制脚本清理范围始终位于产物目录。 */
function assertSafeOutput(path, allowedRoot) {
  if (path === allowedRoot || path.startsWith(`${allowedRoot}${sep}`)) return;
  throw new Error(`output must be inside ${allowedRoot}: ${path}`);
}

/** 解析构建输入、依赖版本和输出路径。 */
function parseArgs(args) {
  const parsed = {
    platform: process.platform,
    arch: process.arch,
    input: undefined,
    qtVersion: undefined,
    qtRoot: undefined,
    qbittorrentSource: resolve(".cache", "qbittorrent-build", "sources", "qbittorrent"),
    libtorrentSource: resolve(".cache", "qbittorrent-build", "sources", "libtorrent"),
    vcpkgInstalled: undefined,
    output: undefined,
    archive: undefined
  };
  const valueArgs = new Set([
    "--platform", "--arch", "--input", "--qt-version", "--qt-root",
    "--qbittorrent-source", "--libtorrent-source", "--vcpkg-installed", "--output", "--archive"
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!valueArgs.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = args[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--platform") parsed.platform = value;
    if (arg === "--arch") parsed.arch = value;
    if (arg === "--input") parsed.input = resolve(value);
    if (arg === "--qt-version") parsed.qtVersion = value;
    if (arg === "--qt-root") parsed.qtRoot = resolve(value);
    if (arg === "--qbittorrent-source") parsed.qbittorrentSource = resolve(value);
    if (arg === "--libtorrent-source") parsed.libtorrentSource = resolve(value);
    if (arg === "--vcpkg-installed") parsed.vcpkgInstalled = resolve(value);
    if (arg === "--output") parsed.output = resolve(value);
    if (arg === "--archive") parsed.archive = resolve(value);
    index += 1;
  }
  if (!["darwin", "win32", "linux"].includes(parsed.platform)) throw new Error(`Unsupported platform: ${parsed.platform}`);
  if (!["x64", "arm64"].includes(parsed.arch)) throw new Error(`Unsupported arch: ${parsed.arch}`);
  for (const key of ["input", "qtVersion", "qtRoot", "vcpkgInstalled"]) {
    if (!parsed[key]) throw new Error(`Missing required option: ${key}`);
  }
  return parsed;
}
