#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  FFMPEG_ASSETS,
  FFMPEG_RELEASE,
  findFfmpegAsset
} from "./ffmpeg-resource-manifest.mjs";

const defaultSourceRoot = resolve("resources", "ffmpeg");
const defaultTargetRoot = resolve("out", "ffmpeg");
const options = parseArgs(process.argv.slice(2));
const selectedAsset = findFfmpegAsset(options.platform, options.arch);

if (!selectedAsset && !options.verifyAll) {
  console.error(`[ffmpeg] unsupported build target: ${options.platform}-${options.arch}`);
  console.error(`[ffmpeg] supported targets: ${Object.keys(FFMPEG_ASSETS).join(", ")}`);
  process.exit(1);
}

const assetsToVerify = options.verifyAll
  ? Object.entries(FFMPEG_ASSETS).map(([targetKey, asset]) => ({ targetKey, ...asset }))
  : [selectedAsset];

for (const asset of assetsToVerify) {
  await verifyBundledAsset(options.sourceRoot, asset);
  console.log(`[ffmpeg] verified ${asset.targetKey}`);
}

if (!options.verifyOnly && selectedAsset) {
  await Promise.all(
    Object.keys(FFMPEG_ASSETS)
      .filter((targetKey) => targetKey !== selectedAsset.targetKey)
      .map((targetKey) => rm(join(options.targetRoot, targetKey), { recursive: true, force: true }))
  );
  const outputDirectory = join(options.targetRoot, selectedAsset.targetKey);
  await rm(outputDirectory, { recursive: true, force: true });
  await cp(join(options.sourceRoot, selectedAsset.targetKey), outputDirectory, {
    recursive: true,
    dereference: false
  });
  if (selectedAsset.platform !== "win32") {
    await Promise.all([
      chmod(join(outputDirectory, selectedAsset.binaryName), 0o755),
      chmod(join(outputDirectory, selectedAsset.ffprobe.binaryName), 0o755)
    ]);
  }
  console.log(`[ffmpeg] copied FFmpeg and FFprobe ${selectedAsset.targetKey}: ${outputDirectory}`);
}

/** 校验 FFmpeg、FFprobe、许可证、说明和来源元数据。 */
async function verifyBundledAsset(sourceRoot, asset) {
  const sourceDirectory = join(sourceRoot, asset.targetKey);
  await verifyFile(join(sourceDirectory, asset.binaryName), asset.binarySize, asset.binarySha256);
  await verifyFile(
    join(sourceDirectory, asset.ffprobe.binaryName),
    asset.ffprobe.binarySize,
    asset.ffprobe.binarySha256
  );
  await verifyTextFile(join(sourceDirectory, "README"), asset.readmeSha256);
  await verifyTextFile(join(sourceDirectory, "LICENSE"), asset.licenseSha256);
  await verifyTextFile(join(sourceDirectory, "FFPROBE-LICENSE.json"), asset.ffprobe.licenseSha256);

  const sourceMetadata = JSON.parse(await readFile(join(sourceDirectory, "SOURCE.json"), "utf8"));
  if (
    sourceMetadata.release !== FFMPEG_RELEASE
    || sourceMetadata.target !== asset.targetKey
    || sourceMetadata.binarySha256 !== asset.binarySha256
    || sourceMetadata.ffprobe?.package !== asset.ffprobe.packageName
    || sourceMetadata.ffprobe?.version !== asset.ffprobe.packageVersion
    || sourceMetadata.ffprobe?.binarySha256 !== asset.ffprobe.binarySha256
    || sourceMetadata.ffprobe?.archiveSha256 !== asset.ffprobe.archiveSha256
    || sourceMetadata.ffprobe?.license !== asset.ffprobe.license
  ) {
    throw new Error(`[ffmpeg] invalid source metadata: ${sourceDirectory}`);
  }
}

/** 校验资源文件类型、大小和 SHA-256。 */
async function verifyFile(path, expectedSize, expectedSha256) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error(`[ffmpeg] expected file: ${path}`);
  }
  if (expectedSize !== undefined && fileStat.size !== expectedSize) {
    throw new Error(`[ffmpeg] size mismatch: ${path}`);
  }
  const actualSha256 = await sha256(path);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`[ffmpeg] SHA-256 mismatch: ${path}`);
  }
}

/** 规范文本换行后校验摘要，避免 Windows 自动 CRLF 转换造成误报。 */
async function verifyTextFile(path, expectedSha256) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error(`[ffmpeg] expected file: ${path}`);
  }
  const content = await readFile(path, "utf8");
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const actualSha256 = createHash("sha256").update(normalizedContent, "utf8").digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`[ffmpeg] SHA-256 mismatch: ${path}`);
  }
}

/** 计算文件 SHA-256 摘要。 */
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** 解析资源源目录、输出目录和验证目标。 */
function parseArgs(args) {
  const parsed = {
    sourceRoot: defaultSourceRoot,
    targetRoot: defaultTargetRoot,
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
    verifyAll: false,
    verifyOnly: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--verify-all") {
      parsed.verifyAll = true;
      parsed.verifyOnly = true;
      continue;
    }
    if (arg === "--verify-only") {
      parsed.verifyOnly = true;
      continue;
    }
    if (arg === "--source") {
      parsed.sourceRoot = resolve(readValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--target") {
      parsed.targetRoot = resolve(readValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--platform") {
      parsed.platform = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--arch") {
      parsed.arch = readValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

/** 读取命令行参数值。 */
function readValue(args, index, arg) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}
