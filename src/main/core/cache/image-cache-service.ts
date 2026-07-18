import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { logger } from "../logger";

export const DEFAULT_IMAGE_CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const ACCESS_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const MAX_REDIRECTS = 3;
const CACHE_METADATA_VERSION = 1;

const IMAGE_CONTENT_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"]
]);

export interface ImageCacheAsset {
  cacheKey: string;
  filePath: string;
  contentType: string;
  size: number;
}

export type ImageFetch = (input: string | URL, options?: RequestInit) => Promise<Response>;
export type ImageHostResolver = (hostname: string) => Promise<string[]>;

export interface ImageCacheServiceOptions {
  cacheDirectory: string;
  fetcher?: ImageFetch;
  hostResolver?: ImageHostResolver;
  maxBytes?: number;
  maxImageBytes?: number;
  signingSecret?: Buffer;
  tokenLifetimeMs?: number;
  clock?: () => number;
}

interface ImageCacheMetadata {
  version: typeof CACHE_METADATA_VERSION;
  cacheKey: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
}

/** 图片缓存错误只暴露稳定错误码，避免把磁盘和网络细节传到远程端。 */
export class ImageCacheError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ImageCacheError";
  }
}

/** 统一管理桌面端和远程端共用的持久图片缓存。 */
export class ImageCacheService {
  private cacheDirectory: string;
  private readonly fetcher: ImageFetch;
  private readonly hostResolver: ImageHostResolver;
  private readonly maxBytes: number;
  private readonly maxImageBytes: number;
  private readonly signingSecret: Buffer;
  private readonly tokenLifetimeMs: number;
  private readonly clock: () => number;
  private readonly inFlight = new Map<string, Promise<ImageCacheAsset>>();
  private readonly lastTouchedAt = new Map<string, number>();

  constructor(options: ImageCacheServiceOptions) {
    this.cacheDirectory = options.cacheDirectory;
    this.fetcher = options.fetcher ?? fetch;
    this.hostResolver = options.hostResolver ?? resolveHostAddresses;
    this.maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_IMAGE_CACHE_MAX_BYTES);
    this.maxImageBytes = normalizePositiveInteger(options.maxImageBytes, DEFAULT_IMAGE_MAX_BYTES);
    this.signingSecret = options.signingSecret ?? randomBytes(32);
    this.tokenLifetimeMs = normalizePositiveInteger(options.tokenLifetimeMs, DEFAULT_TOKEN_LIFETIME_MS);
    this.clock = options.clock ?? Date.now;
  }

  /** 切换到设置指定的缓存目录，后续请求会直接使用新目录。 */
  setCacheDirectory(cacheDirectory: string): void {
    if (cacheDirectory === this.cacheDirectory) {
      return;
    }
    this.cacheDirectory = cacheDirectory;
    this.lastTouchedAt.clear();
    logger.info("图片缓存目录已更新", { cacheDirectory });
  }

  /** 创建桌面自定义协议使用的短期签名地址。 */
  createElectronUrl(sourceUrl: string): string {
    return `ani-image://cache/${this.createToken(sourceUrl)}`;
  }

  /** 创建远程同源图片路由使用的短期签名路径。 */
  createRemotePath(sourceUrl: string): string {
    return `/api/images/${this.createToken(sourceUrl)}`;
  }

  /** 从签名令牌读取图片，非法或过期令牌不会触发网络请求。 */
  getByToken(token: string): Promise<ImageCacheAsset> {
    return this.get(this.readToken(token));
  }

  /** 返回已有缓存；首次缺失时下载，并合并同一 URL 的并发请求。 */
  async get(sourceUrl: string): Promise<ImageCacheAsset> {
    const normalizedUrl = normalizeImageSourceUrl(sourceUrl);
    const cacheKey = createCacheKey(normalizedUrl);
    const existing = await this.readCachedAsset(cacheKey);
    if (existing) {
      logger.info("图片缓存命中", { cacheKey, size: existing.size });
      this.touchAsset(existing);
      return existing;
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      logger.info("图片缓存合并并发请求", { cacheKey });
      return pending;
    }

    const task = this.downloadAndStore(normalizedUrl, cacheKey).finally(() => {
      if (this.inFlight.get(cacheKey) === task) {
        this.inFlight.delete(cacheKey);
      }
    });
    this.inFlight.set(cacheKey, task);
    return task;
  }

  /** 生成包含源地址和有效期的防篡改令牌。 */
  private createToken(sourceUrl: string): string {
    const normalizedUrl = normalizeImageSourceUrl(sourceUrl);
    const payload = Buffer.from(JSON.stringify({
      sourceUrl: normalizedUrl,
      expiresAt: this.clock() + this.tokenLifetimeMs
    })).toString("base64url");
    const signature = createHmac("sha256", this.signingSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  /** 校验签名、有效期和源地址后返回规范化 URL。 */
  private readToken(token: string): string {
    if (!token || token.length > 4_096) {
      throw new ImageCacheError("IMAGE_TOKEN_INVALID", "图片地址无效");
    }
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) {
      throw new ImageCacheError("IMAGE_TOKEN_INVALID", "图片地址无效");
    }
    const expected = createHmac("sha256", this.signingSecret).update(payload).digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, "base64url");
    } catch {
      throw new ImageCacheError("IMAGE_TOKEN_INVALID", "图片地址无效");
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new ImageCacheError("IMAGE_TOKEN_INVALID", "图片地址无效");
    }

    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        sourceUrl?: unknown;
        expiresAt?: unknown;
      };
      if (typeof parsed.expiresAt !== "number" || parsed.expiresAt < this.clock()) {
        throw new ImageCacheError("IMAGE_TOKEN_EXPIRED", "图片地址已过期");
      }
      if (typeof parsed.sourceUrl !== "string") {
        throw new ImageCacheError("IMAGE_TOKEN_INVALID", "图片地址无效");
      }
      return normalizeImageSourceUrl(parsed.sourceUrl);
    } catch (error) {
      if (error instanceof ImageCacheError) {
        throw error;
      }
      throw new ImageCacheError("IMAGE_TOKEN_INVALID", "图片地址无效");
    }
  }

  /** 读取完整且可信的磁盘缓存记录，损坏记录会被清理。 */
  private async readCachedAsset(cacheKey: string): Promise<ImageCacheAsset | undefined> {
    const metadataPath = this.metadataPath(cacheKey);
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as ImageCacheMetadata;
      if (!isValidMetadata(metadata, cacheKey)) {
        throw new Error("图片缓存元数据无效");
      }
      const filePath = join(this.cacheDirectory, metadata.fileName);
      const fileStats = await stat(filePath);
      if (!fileStats.isFile() || fileStats.size !== metadata.size || fileStats.size <= 0) {
        throw new Error("图片缓存文件不完整");
      }
      return {
        cacheKey,
        filePath,
        contentType: metadata.contentType,
        size: metadata.size
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      logger.warn("图片缓存损坏，准备重新下载", {
        cacheKey,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.removeCacheEntry(cacheKey);
      return undefined;
    }
  }

  /** 下载图片并使用临时文件原子写入缓存目录。 */
  private async downloadAndStore(sourceUrl: string, cacheKey: string): Promise<ImageCacheAsset> {
    logger.info("图片缓存未命中，开始下载", { cacheKey, host: new URL(sourceUrl).host });
    const response = await this.fetchImageResponse(sourceUrl);
    const contentType = normalizeContentType(response.headers.get("content-type"));
    const extension = IMAGE_CONTENT_TYPES.get(contentType);
    if (!extension) {
      throw new ImageCacheError("IMAGE_TYPE_UNSUPPORTED", "图片格式不受支持");
    }
    const body = await readImageBody(response, this.maxImageBytes);
    await mkdir(this.cacheDirectory, { recursive: true });
    const fileName = `${cacheKey}.${extension}`;
    const filePath = join(this.cacheDirectory, fileName);
    const metadata: ImageCacheMetadata = {
      version: CACHE_METADATA_VERSION,
      cacheKey,
      fileName,
      contentType,
      size: body.length,
      createdAt: new Date(this.clock()).toISOString()
    };
    const temporaryId = randomUUID();
    const temporaryFilePath = join(this.cacheDirectory, `${cacheKey}.${temporaryId}.tmp`);
    const temporaryMetadataPath = join(this.cacheDirectory, `${cacheKey}.${temporaryId}.json.tmp`);
    try {
      await writeFile(temporaryFilePath, body, { flag: "wx" });
      await writeFile(temporaryMetadataPath, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
      await rename(temporaryFilePath, filePath);
      await rename(temporaryMetadataPath, this.metadataPath(cacheKey));
    } finally {
      await Promise.all([
        rm(temporaryFilePath, { force: true }),
        rm(temporaryMetadataPath, { force: true })
      ]);
    }
    logger.info("图片缓存写入完成", { cacheKey, size: body.length, contentType });
    await this.pruneToLimit();
    return { cacheKey, filePath, contentType, size: body.length };
  }

  /** 手动处理有限次重定向，并在每一跳重新执行公网地址校验。 */
  private async fetchImageResponse(sourceUrl: string): Promise<Response> {
    let currentUrl = sourceUrl;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await validatePublicImageUrl(currentUrl, this.hostResolver);
      const response = await this.fetcher(currentUrl, { method: "GET", redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new ImageCacheError("IMAGE_REDIRECT_INVALID", "图片重定向无效");
        }
        currentUrl = normalizeImageSourceUrl(new URL(location, currentUrl).toString());
        continue;
      }
      if (!response.ok) {
        throw new ImageCacheError("IMAGE_FETCH_FAILED", `图片下载失败：HTTP ${response.status}`);
      }
      return response;
    }
    throw new ImageCacheError("IMAGE_REDIRECT_INVALID", "图片重定向无效");
  }

  /** 超出容量上限时优先删除最久未访问的图片。 */
  private async pruneToLimit(): Promise<void> {
    const entries = await readdir(this.cacheDirectory, { withFileTypes: true });
    const assets = await Promise.all(entries
      .filter((entry) => entry.isFile() && isCacheDataFile(entry.name))
      .map(async (entry) => {
        const filePath = join(this.cacheDirectory, entry.name);
        const fileStats = await stat(filePath);
        return { filePath, fileName: entry.name, size: fileStats.size, accessedAt: fileStats.mtimeMs };
      }));
    let totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
    if (totalBytes <= this.maxBytes) {
      return;
    }
    assets.sort((left, right) => left.accessedAt - right.accessedAt);
    let removedBytes = 0;
    for (const asset of assets) {
      if (totalBytes <= this.maxBytes) {
        break;
      }
      const cacheKey = asset.fileName.split(".")[0];
      await Promise.all([
        rm(asset.filePath, { force: true }),
        rm(this.metadataPath(cacheKey), { force: true })
      ]);
      totalBytes -= asset.size;
      removedBytes += asset.size;
      this.lastTouchedAt.delete(cacheKey);
    }
    logger.info("图片缓存容量清理完成", {
      maxBytes: this.maxBytes,
      removedBytes,
      remainingBytes: totalBytes
    });
  }

  /** 最多每小时更新一次访问时间，减少高频图片命中的磁盘写入。 */
  private touchAsset(asset: ImageCacheAsset): void {
    const now = this.clock();
    const lastTouchedAt = this.lastTouchedAt.get(asset.cacheKey) ?? 0;
    if (now - lastTouchedAt < ACCESS_TOUCH_INTERVAL_MS) {
      return;
    }
    this.lastTouchedAt.set(asset.cacheKey, now);
    const timestamp = new Date(now);
    void utimes(asset.filePath, timestamp, timestamp).catch((error) => {
      logger.warn("图片缓存访问时间更新失败", {
        cacheKey: asset.cacheKey,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  /** 删除一个缓存键关联的数据、元数据和残留临时文件。 */
  private async removeCacheEntry(cacheKey: string): Promise<void> {
    try {
      const entries = await readdir(this.cacheDirectory, { withFileTypes: true });
      await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(`${cacheKey}.`))
        .map((entry) => rm(join(this.cacheDirectory, entry.name), { force: true })));
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  private metadataPath(cacheKey: string): string {
    return join(this.cacheDirectory, `${cacheKey}.json`);
  }
}

/** 校验图片 URL 只指向公网 HTTP(S) 地址，阻止通过缓存入口访问内网。 */
export async function validatePublicImageUrl(sourceUrl: string, resolver: ImageHostResolver): Promise<void> {
  const url = new URL(normalizeImageSourceUrl(sourceUrl));
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new ImageCacheError("IMAGE_HOST_FORBIDDEN", "图片地址不允许访问本机或私有网络");
  }
  const addresses = isIP(hostname) ? [hostname] : await resolver(hostname);
  if (!addresses.length || addresses.some(isPrivateOrReservedAddress)) {
    throw new ImageCacheError("IMAGE_HOST_FORBIDDEN", "图片地址不允许访问本机或私有网络");
  }
}

/** 规范化源地址，片段不参与实际 HTTP 请求和缓存键。 */
export function normalizeImageSourceUrl(sourceUrl: string): string {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new ImageCacheError("IMAGE_URL_INVALID", "图片地址无效");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new ImageCacheError("IMAGE_URL_INVALID", "图片地址只支持公开 HTTP 或 HTTPS URL");
  }
  if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) {
    throw new ImageCacheError("IMAGE_URL_INVALID", "图片地址端口不受支持");
  }
  url.hash = "";
  return url.toString();
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function createCacheKey(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl).digest("hex");
}

function normalizeContentType(value: string | null): string {
  return value?.split(";", 1)[0].trim().toLowerCase() ?? "";
}

async function readImageBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new ImageCacheError("IMAGE_TOO_LARGE", "图片文件超过 20MB 限制");
  }
  if (!response.body) {
    throw new ImageCacheError("IMAGE_EMPTY", "图片内容为空");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new ImageCacheError("IMAGE_TOO_LARGE", "图片文件超过 20MB 限制");
    }
    chunks.push(chunk);
  }
  if (totalBytes === 0) {
    throw new ImageCacheError("IMAGE_EMPTY", "图片内容为空");
  }
  return Buffer.concat(chunks, totalBytes);
}

function isValidMetadata(value: ImageCacheMetadata, cacheKey: string): boolean {
  return value?.version === CACHE_METADATA_VERSION
    && value.cacheKey === cacheKey
    && /^[a-f0-9]{64}\.(?:jpg|png|webp|gif|avif)$/.test(value.fileName)
    && IMAGE_CONTENT_TYPES.has(value.contentType)
    && Number.isSafeInteger(value.size)
    && value.size > 0;
}

function isCacheDataFile(fileName: string): boolean {
  return /^[a-f0-9]{64}\.(?:jpg|png|webp|gif|avif)$/.test(fileName);
}

function isPrivateOrReservedAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) {
    return isPrivateOrReservedAddress(normalized.slice("::ffff:".length));
  }
  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19 || second === 51))
      || (first === 203 && second === 0)
      || first >= 224;
  }
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
