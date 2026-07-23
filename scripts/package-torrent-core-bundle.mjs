#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = parseArgs(process.argv.slice(2));
const targetName = `${options.platform}-${options.arch}`;
const binaryName = options.platform === "win32" ? "torrent-core.exe" : "torrent-core";
const outputDirectory = options.output ?? resolve("artifacts", "torrent-core", targetName);
const binaryPath = options.binary ?? await findBinary(binaryName, options.buildDirectory);

assertSafeOutputDirectory(outputDirectory);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(binaryPath, join(outputDirectory, binaryName));
if (options.platform !== "win32") await chmod(join(outputDirectory, binaryName), 0o755);

await writeFile(
  join(outputDirectory, "SOURCE.md"),
  [
    "# torrent-core build source",
    "",
    `- Target: \`${targetName}\``,
    "- Core: Ani Tracker torrent-core 0.1.0",
    "- libtorrent-rasterbar: 2.1.0 (pinned SHA-256 source archive)",
    "- Build mode: portable static dependencies",
    ""
  ].join("\n"),
  "utf8"
);

await execFileAsync(process.execPath, [
  resolve("scripts", "create-torrent-core-manifest.mjs"),
  "--platform", options.platform,
  "--arch", options.arch,
  "--directory", outputDirectory
]);
console.log(`[torrent-core] bundle staged: ${outputDirectory}`);

/** 在 Ninja 与多配置生成器的常见目录中查找核心二进制。 */
async function findBinary(binaryName, buildDirectory) {
  const candidates = [
    join(buildDirectory, binaryName),
    join(buildDirectory, "Release", binaryName)
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续检查下一种生成器布局。
    }
  }
  throw new Error(`torrent-core binary not found: ${candidates.join(", ")}`);
}

/** 防止脚本清理仓库根目录或资源源码目录。 */
function assertSafeOutputDirectory(directory) {
  const allowedRoot = resolve("artifacts", "torrent-core");
  if (directory !== allowedRoot && directory.startsWith(`${allowedRoot}${sep}`)) return;
  throw new Error(`output directory must be inside ${allowedRoot}: ${directory}`);
}

/** 解析构建目标、构建目录和输出目录。 */
function parseArgs(args) {
  const parsed = {
    platform: process.platform,
    arch: process.arch,
    buildDirectory: resolve("native", "torrent-core", "build", "portable-release"),
    binary: undefined,
    output: undefined
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!["--platform", "--arch", "--build-directory", "--binary", "--output"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--platform") parsed.platform = value;
    if (arg === "--arch") parsed.arch = value;
    if (arg === "--build-directory") parsed.buildDirectory = resolve(value);
    if (arg === "--binary") parsed.binary = resolve(value);
    if (arg === "--output") parsed.output = resolve(value);
    index += 1;
  }
  if (!["darwin", "win32", "linux"].includes(parsed.platform)) {
    throw new Error(`Unsupported platform: ${parsed.platform}`);
  }
  if (!["x64", "arm64"].includes(parsed.arch)) throw new Error(`Unsupported arch: ${parsed.arch}`);
  return parsed;
}
