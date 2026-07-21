#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { createGunzip, gunzipSync } from "node:zlib";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  FFMPEG_ASSETS,
  FFMPEG_RELEASE,
  findFfmpegAsset
} from "./ffmpeg-resource-manifest.mjs";

const defaultBaseUrl = "https://github.com/eugeneware/ffmpeg-static/releases/download";
const defaultFfprobeRegistryUrl = "https://registry.npmjs.org";
const defaultCacheRoot = resolve(".cache", "ffmpeg", FFMPEG_RELEASE);
const defaultTargetRoot = resolve("resources", "ffmpeg");
const defaultLicenseRoot = resolve("resources", "ffmpeg", "licenses");

const options = parseArgs(process.argv.slice(2));
const proxyUrl = options.proxyUrl || resolveProxyUrl(process.env);
const downloadAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
if (proxyUrl) {
  console.log(`[ffmpeg] using proxy: ${formatProxyUrl(proxyUrl)}`);
}
const selectedAsset = findFfmpegAsset(options.platform, options.arch);
if (!selectedAsset && !options.all) {
  console.error(`[ffmpeg] unsupported maintenance target: ${options.platform}-${options.arch}`);
  console.error(`[ffmpeg] supported targets: ${Object.keys(FFMPEG_ASSETS).join(", ")}`);
  process.exit(1);
}

const baseUrl = `${options.baseUrl.replace(/\/$/, "")}/${FFMPEG_RELEASE}`;
await mkdir(options.cacheRoot, { recursive: true });
const assetsToDownload = options.all
  ? Object.entries(FFMPEG_ASSETS).map(([targetKey, asset]) => ({ targetKey, ...asset }))
  : [selectedAsset];

for (const asset of assetsToDownload) {
  await updateBundledAsset(asset, options);
}

/** 下载、校验并更新指定平台的 FFmpeg 与 FFprobe 预构建资源。 */
async function updateBundledAsset(asset, currentOptions) {
  const archiveName = `ffmpeg-${asset.targetKey}.gz`;
  const ffprobeArchiveName = `${asset.targetKey}-${asset.ffprobe.packageVersion}.tgz`;
  const readmeName = `${asset.targetKey}.README`;
  const licenseName = `${asset.targetKey}.LICENSE`;
  const cacheFiles = {
    archive: join(currentOptions.cacheRoot, archiveName),
    ffprobeArchive: join(currentOptions.cacheRoot, ffprobeArchiveName),
    readme: join(currentOptions.cacheRoot, readmeName),
    license: join(currentOptions.cacheRoot, licenseName)
  };

  await Promise.all([
    ensureCachedAsset(`${baseUrl}/${archiveName}`, cacheFiles.archive, asset.archiveSha256, currentOptions),
    ensureCachedAsset(`${baseUrl}/${readmeName}`, cacheFiles.readme, asset.readmeSha256, currentOptions),
    ensureCachedAsset(`${baseUrl}/${licenseName}`, cacheFiles.license, asset.licenseSha256, currentOptions),
    ensureCachedAsset(
      createNpmTarballUrl(currentOptions.ffprobeRegistryUrl, asset.ffprobe),
      cacheFiles.ffprobeArchive,
      asset.ffprobe.archiveSha256,
      currentOptions
    )
  ]);

  const outputDirectory = join(currentOptions.targetRoot, asset.targetKey);
  const outputBinary = join(outputDirectory, asset.binaryName);
  const outputFfprobeBinary = join(outputDirectory, asset.ffprobe.binaryName);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await pipeline(createReadStream(cacheFiles.archive), createGunzip(), createWriteStream(outputBinary));
  await extractNpmPackageBinary(
    cacheFiles.ffprobeArchive,
    `package/${asset.ffprobe.binaryName}`,
    outputFfprobeBinary
  );
  await Promise.all([
    verifyExtractedBinary(outputBinary, asset.binarySize, asset.binarySha256, asset.targetKey, "FFmpeg"),
    verifyExtractedBinary(
      outputFfprobeBinary,
      asset.ffprobe.binarySize,
      asset.ffprobe.binarySha256,
      asset.targetKey,
      "FFprobe"
    )
  ]);
  if (asset.platform !== "win32") {
    await Promise.all([
      chmod(outputBinary, 0o755),
      chmod(outputFfprobeBinary, 0o755)
    ]);
  }
  const ffprobeLicensePath = join(currentOptions.licenseRoot, asset.ffprobe.licenseFile);
  if (!(await hasExpectedHash(ffprobeLicensePath, asset.ffprobe.licenseSha256))) {
    throw new Error(`[ffmpeg] FFprobe license missing or invalid: ${ffprobeLicensePath}`);
  }
  await Promise.all([
    copyFile(cacheFiles.readme, join(outputDirectory, "README")),
    copyFile(cacheFiles.license, join(outputDirectory, "LICENSE")),
    copyFile(ffprobeLicensePath, join(outputDirectory, "FFPROBE-LICENSE.json")),
    writeFile(join(outputDirectory, "SOURCE.json"), `${JSON.stringify({
      project: "ffmpeg-static",
      repository: "https://github.com/eugeneware/ffmpeg-static",
      release: FFMPEG_RELEASE,
      target: asset.targetKey,
      archive: archiveName,
      archiveSha256: asset.archiveSha256,
      binarySize: asset.binarySize,
      binarySha256: asset.binarySha256,
      ffprobe: {
        package: asset.ffprobe.packageName,
        version: asset.ffprobe.packageVersion,
        buildVersion: asset.ffprobe.buildVersion,
        homepage: asset.ffprobe.homepage,
        license: asset.ffprobe.license,
        licenseFile: "FFPROBE-LICENSE.json",
        archive: ffprobeArchiveName,
        archiveSha256: asset.ffprobe.archiveSha256,
        binarySize: asset.ffprobe.binarySize,
        binarySha256: asset.ffprobe.binarySha256
      }
    }, null, 2)}\n`, "utf8")
  ]);

  console.log(`[ffmpeg] updated FFmpeg and FFprobe ${asset.targetKey}: ${outputDirectory}`);
}

/** 生成 scoped npm 平台包的固定版本归档地址。 */
function createNpmTarballUrl(registryUrl, ffprobe) {
  const packageBaseName = ffprobe.packageName.split("/").at(-1);
  return `${registryUrl.replace(/\/$/, "")}/${ffprobe.packageName}/-/${packageBaseName}-${ffprobe.packageVersion}.tgz`;
}

/** 从 npm tgz 的 tar 数据中提取指定二进制。 */
async function extractNpmPackageBinary(archivePath, entryName, destination) {
  const tarBuffer = gunzipSync(await readFile(archivePath));
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      break;
    }
    const name = readTarText(header, 0, 100);
    const prefix = readTarText(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarText(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`[ffmpeg] invalid tar entry size: ${fullName}`);
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuffer.length) {
      throw new Error(`[ffmpeg] truncated tar entry: ${fullName}`);
    }
    if (fullName === entryName) {
      await writeFile(destination, tarBuffer.subarray(dataStart, dataEnd));
      return;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  throw new Error(`[ffmpeg] FFprobe entry missing from package: ${entryName}`);
}

/** 读取 tar 头中的空字符结尾文本字段。 */
function readTarText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** 校验解压后二进制大小与 SHA-256。 */
async function verifyExtractedBinary(path, expectedSize, expectedSha256, targetKey, binaryLabel) {
  const outputStat = await stat(path);
  const outputSha256 = await sha256(path);
  if (outputStat.size !== expectedSize || outputSha256 !== expectedSha256) {
    throw new Error(`[ffmpeg] extracted ${binaryLabel} verification failed: ${targetKey}`);
  }
}

/** 确保缓存文件存在且摘要正确，网络异常时自动重试。 */
async function ensureCachedAsset(url, destination, expectedSha256, currentOptions) {
  if (await hasExpectedHash(destination, expectedSha256)) {
    console.log(`[ffmpeg] cache hit: ${destination}`);
    return;
  }
  if (currentOptions.offline) {
    throw new Error(`[ffmpeg] offline cache missing or invalid: ${destination}`);
  }

  await mkdir(dirname(destination), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= currentOptions.retries; attempt += 1) {
    const temporaryPath = `${destination}.part-${process.pid}`;
    try {
      await downloadFile(url, temporaryPath, currentOptions.timeoutMs);
      const actualSha256 = await sha256(temporaryPath);
      if (actualSha256 !== expectedSha256) {
        throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`);
      }
      await rm(destination, { force: true });
      await rename(temporaryPath, destination);
      console.log(`[ffmpeg] downloaded: ${url}`);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporaryPath, { force: true });
      console.warn(`[ffmpeg] download attempt ${attempt}/${currentOptions.retries} failed: ${errorMessage(error)}`);
    }
  }

  throw new Error(`[ffmpeg] failed to download ${url}: ${errorMessage(lastError)}`);
}

/** 使用可配置代理和空闲超时下载单个构建资源。 */
async function downloadFile(url, destination, timeoutMs, redirectsRemaining = 5) {
  await new Promise((resolveDownload, rejectDownload) => {
    const request = httpsGet(url, {
      agent: downloadAgent,
      headers: { "User-Agent": "ani-tracker-build" }
    }, async (response) => {
      try {
        const location = response.headers.location;
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
          response.resume();
          if (redirectsRemaining <= 0) {
            throw new Error("Too many redirects");
          }
          await downloadFile(new URL(location, url).href, destination, timeoutMs, redirectsRemaining - 1);
          resolveDownload();
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          throw new Error(`HTTP ${response.statusCode ?? "unknown"}`);
        }
        await pipeline(response, createWriteStream(destination));
        resolveDownload();
      } catch (error) {
        rejectDownload(error);
      }
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    request.once("error", rejectDownload);
  });
}

/** 校验缓存文件的 SHA-256 摘要。 */
async function hasExpectedHash(path, expectedSha256) {
  try {
    await access(path);
    return await sha256(path) === expectedSha256;
  } catch {
    return false;
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

/** 解析目标平台、缓存和网络参数。 */
function parseArgs(args) {
  const parsed = {
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
    targetRoot: defaultTargetRoot,
    cacheRoot: defaultCacheRoot,
    baseUrl: process.env.FFMPEG_BINARIES_URL || defaultBaseUrl,
    ffprobeRegistryUrl: process.env.FFPROBE_PACKAGES_URL || defaultFfprobeRegistryUrl,
    licenseRoot: defaultLicenseRoot,
    timeoutMs: 120_000,
    retries: 3,
    offline: false,
    all: false,
    proxyUrl: undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--offline") {
      parsed.offline = true;
      continue;
    }
    if (arg === "--all") {
      parsed.all = true;
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
    if (arg === "--target") {
      parsed.targetRoot = resolve(readValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--cache") {
      parsed.cacheRoot = resolve(readValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--ffprobe-registry") {
      parsed.ffprobeRegistryUrl = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--license-root") {
      parsed.licenseRoot = resolve(readValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--proxy") {
      parsed.proxyUrl = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      parsed.timeoutMs = positiveInteger(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--retries") {
      parsed.retries = positiveInteger(readValue(args, index, arg), arg);
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

/** 读取正整数参数。 */
function positiveInteger(value, arg) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${arg} requires a positive integer`);
  }
  return parsed;
}

/** 按 HTTPS、HTTP 优先级读取标准代理环境变量。 */
function resolveProxyUrl(environment) {
  return environment.HTTPS_PROXY
    || environment.https_proxy
    || environment.HTTP_PROXY
    || environment.http_proxy;
}

/** 隐藏代理凭据后输出代理节点。 */
function formatProxyUrl(value) {
  const parsed = new URL(value);
  return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
}

/** 返回适合构建日志的错误说明。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
