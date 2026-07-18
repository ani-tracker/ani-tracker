import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { logger } from "../logger";
import { ImageCacheError, type ImageCacheService } from "./image-cache-service";

const IMAGE_CACHE_SCHEME = "ani-image";

/** 在 app ready 前注册安全的标准图片协议能力。 */
export function registerImageCacheScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: IMAGE_CACHE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }]);
}

/** 将 ani-image 请求绑定到主进程共享图片缓存。 */
export function registerImageCacheProtocol(imageCacheService: ImageCacheService): void {
  protocol.handle(IMAGE_CACHE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "cache" || !/^\/[A-Za-z0-9_.-]{20,4096}$/.test(url.pathname)) {
        throw new ImageCacheError("IMAGE_TOKEN_INVALID", "图片地址无效");
      }
      const asset = await imageCacheService.getByToken(url.pathname.slice(1));
      return new Response(await readFile(asset.filePath), {
        status: 200,
        headers: {
          "Content-Type": asset.contentType,
          "Content-Length": String(asset.size),
          "Cache-Control": "private, max-age=86400, immutable",
          "X-Content-Type-Options": "nosniff",
          ETag: `"${asset.cacheKey}"`
        }
      });
    } catch (error) {
      logger.warn("桌面图片缓存请求失败", {
        errorCode: error instanceof ImageCacheError ? error.code : "IMAGE_CACHE_FAILED",
        errorType: error instanceof Error ? error.name : typeof error
      });
      return new Response(null, { status: 404 });
    }
  });
}
