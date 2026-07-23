#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const sources = [
  {
    name: "qbittorrent",
    archive: "qbittorrent-enhanced-5.2.1.10.tar.gz",
    url: "https://github.com/c0re100/qBittorrent-Enhanced-Edition/archive/refs/tags/release-5.2.1.10.tar.gz",
    sha256: "ee5e05db67ba52a9380b01501260473bcd6595b4750c5775c037ed3b6815e30b"
  },
  {
    name: "libtorrent",
    archive: "libtorrent-rasterbar-2.0.13.tar.gz",
    url: "https://github.com/arvidn/libtorrent/releases/download/v2.0.13/libtorrent-rasterbar-2.0.13.tar.gz",
    sha256: "892cb75c06318e2420de0faf9f63a908069d3d237676e2459fd30abe0cb3b1bf"
  }
];

const cacheRoot = parseCacheRoot(process.argv.slice(2));
assertSafeCacheRoot(cacheRoot);
await mkdir(cacheRoot, { recursive: true });

for (const source of sources) {
  const archivePath = join(cacheRoot, "downloads", source.archive);
  const sourceDirectory = join(cacheRoot, "sources", source.name);
  await ensureArchive(source, archivePath);
  await ensureExtracted(source, archivePath, sourceDirectory);
  console.log(`[qbittorrent-build] source ready: ${source.name} -> ${sourceDirectory}`);
}

/** 下载并校验固定摘要的源码归档。 */
async function ensureArchive(source, archivePath) {
  await mkdir(dirname(archivePath), { recursive: true });
  if (await exists(archivePath)) {
    if (await sha256(archivePath) === source.sha256) return;
    await rm(archivePath, { force: true });
  }

  console.log(`[qbittorrent-build] downloading ${source.url}`);
  await execFileAsync("curl", [
    "-L",
    "--fail",
    "--retry", "3",
    "--output", archivePath,
    source.url
  ], { maxBuffer: 10 * 1024 * 1024 });

  const actual = await sha256(archivePath);
  if (actual !== source.sha256) {
    await rm(archivePath, { force: true });
    throw new Error(`${source.name} source SHA-256 mismatch: expected ${source.sha256}, got ${actual}`);
  }
}

/** 摘要未变化时复用已解压源码，否则重新生成干净目录。 */
async function ensureExtracted(source, archivePath, sourceDirectory) {
  const markerPath = join(sourceDirectory, ".ani-source-sha256");
  if (await exists(markerPath)) {
    const marker = (await readFile(markerPath, "utf8")).trim();
    if (marker === source.sha256) return;
  }

  await rm(sourceDirectory, { recursive: true, force: true });
  await mkdir(sourceDirectory, { recursive: true });
  await execFileAsync("tar", [
    "-xzf", archivePath,
    "--strip-components=1",
    "-C", sourceDirectory
  ], { maxBuffer: 10 * 1024 * 1024 });
  await writeFile(markerPath, `${source.sha256}\n`, "utf8");
}

/** 计算文件 SHA-256。 */
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** 判断路径是否存在。 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 只允许清理仓库缓存目录，避免误删源码。 */
function assertSafeCacheRoot(directory) {
  const allowedRoot = resolve(".cache", "qbittorrent-build");
  if (directory === allowedRoot || directory.startsWith(`${allowedRoot}${sep}`)) return;
  throw new Error(`cache root must be inside ${allowedRoot}: ${directory}`);
}

/** 解析可复用的源码缓存目录。 */
function parseCacheRoot(args) {
  let cacheRoot = resolve(".cache", "qbittorrent-build");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg !== "--cache-root") throw new Error(`Unknown argument: ${arg}`);
    const value = args[index + 1];
    if (!value) throw new Error("--cache-root requires a value");
    cacheRoot = resolve(value);
    index += 1;
  }
  return cacheRoot;
}
