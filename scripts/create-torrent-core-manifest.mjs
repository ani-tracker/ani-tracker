#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import process from "node:process";

const CORE_VERSION = "0.1.0";
const LIBTORRENT_VERSION = "2.1.0";
const options = parseArgs(process.argv.slice(2));
const targetName = `${options.platform}-${options.arch}`;
const targetDirectory = options.directory ?? resolve("resources", "torrent-core", targetName);
const licenseSource = resolve("resources", "torrent-core", "licenses");
const binaryName = options.platform === "win32" ? "torrent-core.exe" : "torrent-core";

await stat(join(targetDirectory, binaryName));
await mkdir(join(targetDirectory, "licenses"), { recursive: true });
await cp(licenseSource, join(targetDirectory, "licenses"), { recursive: true, force: true });

const files = [];
for (const path of (await listFiles(targetDirectory)).sort()) {
  if (basename(path) === "manifest.json") continue;
  const fileStat = await stat(path);
  files.push({
    path: relative(targetDirectory, path).replaceAll("\\", "/"),
    size: fileStat.size,
    sha256: await sha256(path)
  });
}

const manifest = {
  schemaVersion: 1,
  target: targetName,
  coreVersion: CORE_VERSION,
  libtorrentVersion: LIBTORRENT_VERSION,
  generatedAt: new Date().toISOString(),
  files
};
await writeFile(join(targetDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[torrent-core] manifest written: ${join(targetDirectory, "manifest.json")}`);

/** 递归返回目标资源目录中的普通文件。 */
async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

/** 计算资源文件的 SHA-256。 */
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** 解析目标平台、架构和资源目录。 */
function parseArgs(args) {
  const parsed = {
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
    directory: undefined
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!["--platform", "--arch", "--directory"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--platform") parsed.platform = value;
    if (arg === "--arch") parsed.arch = value;
    if (arg === "--directory") parsed.directory = resolve(value);
    index += 1;
  }
  return parsed;
}
