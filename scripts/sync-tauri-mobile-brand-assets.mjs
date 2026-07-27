#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PLATFORMS = new Set(["ios", "android"]);
const IOS_SOURCE = "src-tauri/icons/ios";
const IOS_TARGET = "src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset";
const ANDROID_SOURCE = "src-tauri/icons/android";
const ANDROID_TARGET = "src-tauri/gen/android/app/src/main/res";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}

/** 同步或校验 Tauri 移动生成工程中的品牌图标。 */
export async function syncMobileBrandAssets({ platform, projectRoot = process.cwd(), check = false }) {
  if (!PLATFORMS.has(platform)) {
    throw new Error("[mobile-brand] platform 必须为 ios 或 android");
  }
  const result = platform === "ios"
    ? await syncIosAssets(projectRoot, check)
    : await syncAndroidAssets(projectRoot, check);
  console.log(
    `[mobile-brand] ${platform} 品牌资产${check ? "校验" : "同步"}完成：${result} 个文件`
  );
  return result;
}

/** 执行命令行入口并保持参数边界明确。 */
async function main(args) {
  const options = parseArgs(args);
  await syncMobileBrandAssets(options);
}

/** 同步 iOS AppIcon Catalog，并拒绝未声明的图片残留。 */
async function syncIosAssets(projectRoot, check) {
  const sourceRoot = resolve(projectRoot, IOS_SOURCE);
  const targetRoot = resolve(projectRoot, IOS_TARGET);
  const contents = JSON.parse(await readFile(resolve(targetRoot, "Contents.json"), "utf8"));
  const definitions = contents.images
    .filter((image) => typeof image.filename === "string")
    .map((image) => ({ filename: image.filename, dimensions: iosDimensions(image) }));
  const expected = definitions.map(({ filename }) => filename).sort();
  await verifyExactFileSet(sourceRoot, expected, (name) => name.endsWith(".png"), "iOS 正式图标源");
  await verifyExactFileSet(targetRoot, expected, (name) => name.endsWith(".png"), "iOS AppIcon Catalog");

  for (const { filename, dimensions } of definitions) {
    const source = resolve(sourceRoot, filename);
    verifyPng(await readFile(source), dimensions, `iOS 正式图标 ${filename}`);
    if (!check) await copyAsset(source, resolve(targetRoot, filename));
  }
  await verifyMatchingAssets(sourceRoot, targetRoot, expected, "iOS AppIcon");
  return expected.length;
}

/** 同步 Android launcher、adaptive icon 和背景色资源。 */
async function syncAndroidAssets(projectRoot, check) {
  const sourceRoot = resolve(projectRoot, ANDROID_SOURCE);
  const targetRoot = resolve(projectRoot, ANDROID_TARGET);
  const expected = (await collectRelativeFiles(sourceRoot)).sort();
  const actual = (await collectRelativeFiles(targetRoot))
    .filter(isAndroidLauncherAsset)
    .sort();
  assertSameFiles(expected, actual, "Android launcher 资源");

  for (const path of expected) {
    const source = resolve(sourceRoot, path);
    if (path.endsWith(".png")) verifyPng(await readFile(source), undefined, `Android 图标 ${path}`);
    if (!check) await copyAsset(source, resolve(targetRoot, path));
  }
  await verifyMatchingAssets(sourceRoot, targetRoot, expected, "Android launcher");
  return expected.length;
}

/** 根据 Asset Catalog 的逻辑尺寸和倍率计算像素尺寸。 */
function iosDimensions(image) {
  const [width, height] = String(image.size).split("x").map(Number);
  const scale = Number.parseInt(String(image.scale), 10);
  if (![width, height, scale].every(Number.isFinite)) {
    throw new Error(`[mobile-brand] iOS AppIcon 尺寸声明无效：${JSON.stringify(image)}`);
  }
  return [Math.round(width * scale), Math.round(height * scale)];
}

/** 校验 PNG 签名、IHDR 和可选的目标尺寸。 */
function verifyPng(buffer, dimensions, label) {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`[mobile-brand] ${label} 不是有效 PNG`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (dimensions && (width !== dimensions[0] || height !== dimensions[1])) {
    throw new Error(
      `[mobile-brand] ${label} 尺寸错误：期望 ${dimensions[0]}x${dimensions[1]}，实际 ${width}x${height}`
    );
  }
}

/** 校验目录只包含预期命名的品牌资源。 */
async function verifyExactFileSet(root, expected, filter, label) {
  const actual = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && filter(entry.name))
    .map((entry) => entry.name)
    .sort();
  assertSameFiles(expected, actual, label);
}

/** 校验两个目录中的目标资产内容完全一致。 */
async function verifyMatchingAssets(sourceRoot, targetRoot, paths, label) {
  for (const path of paths) {
    const sourceHash = hash(await readFile(resolve(sourceRoot, path)));
    const targetHash = hash(await readFile(resolve(targetRoot, path)));
    if (sourceHash !== targetHash) {
      throw new Error(`[mobile-brand] ${label} 仍包含非项目资产：${path}`);
    }
  }
}

/** 比较资源文件集合，阻止旧图标以额外文件形式进入安装包。 */
function assertSameFiles(expected, actual, label) {
  if (expected.length === actual.length && expected.every((value, index) => value === actual[index])) {
    return;
  }
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((path) => !actualSet.has(path));
  const unexpected = actual.filter((path) => !expectedSet.has(path));
  throw new Error(
    `[mobile-brand] ${label} 文件集合不一致：missing=${missing.join(",") || "none"} unexpected=${unexpected.join(",") || "none"}`
  );
}

/** 递归收集目录内的相对文件路径。 */
async function collectRelativeFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) return collectRelativeFiles(root, path);
    return entry.isFile() ? [relative(root, path).split(sep).join("/")] : [];
  }));
  return files.flat();
}

/** 判断 Android 生成工程中的文件是否属于 launcher 品牌资产。 */
function isAndroidLauncherAsset(path) {
  return /^(?:mipmap-[^/]+\/ic_launcher(?:_foreground|_round)?\.png|mipmap-anydpi-v26\/ic_launcher\.xml|values\/ic_launcher_background\.xml)$/.test(path);
}

/** 创建目标目录并复制单个品牌资产。 */
async function copyAsset(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

/** 生成稳定的 SHA-256 内容摘要。 */
function hash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 解析平台、校验模式和测试使用的项目根目录。 */
function parseArgs(args) {
  const parsed = { platform: "", projectRoot: process.cwd(), check: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    if (arg === "--platform" || arg === "--project-root") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--platform") parsed.platform = value;
      if (arg === "--project-root") parsed.projectRoot = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!PLATFORMS.has(parsed.platform)) {
    throw new Error("--platform 必须为 ios 或 android");
  }
  return parsed;
}
