import { protocol } from "electron";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { logger } from "../logger";
import { RemoteMediaSessionError } from "../remote/remote-media-session-service";
import type { DesktopPlaybackSessionService } from "./desktop-playback-session-service";

const DESKTOP_MEDIA_SCHEME = "ani-media";

/** 在 app ready 前注册支持流式读取的桌面媒体协议。 */
export function registerDesktopMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: DESKTOP_MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }]);
}

/** 将 ani-media 请求绑定到桌面播放会话服务。 */
export function registerDesktopMediaProtocol(service: DesktopPlaybackSessionService): void {
  protocol.handle(DESKTOP_MEDIA_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    try {
      const asset = await service.resolveAsset(request.url);
      const fileStats = await stat(asset.filePath);
      const rangeHeader = asset.direct ? request.headers.get("range") ?? undefined : undefined;
      const range = rangeHeader ? parseByteRange(rangeHeader, fileStats.size) : undefined;
      if (rangeHeader && !range) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${fileStats.size}` }
        });
      }

      const start = range?.start ?? 0;
      const end = range?.end ?? fileStats.size - 1;
      const headers = new Headers({
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Length": String(Math.max(0, end - start + 1)),
        "Content-Type": asset.contentType,
        "X-Content-Type-Options": "nosniff"
      });
      if (asset.direct) headers.set("Accept-Ranges", "bytes");
      if (range) headers.set("Content-Range", `bytes ${start}-${end}/${fileStats.size}`);
      if (request.method === "HEAD") {
        return new Response(null, { status: range ? 206 : 200, headers });
      }

      const stream = createReadStream(asset.filePath, range ? { start, end } : undefined);
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status: range ? 206 : 200,
        headers
      });
    } catch (error) {
      const status = error instanceof RemoteMediaSessionError ? error.statusCode : 500;
      logger.warn("桌面内置媒体读取失败", {
        errorCode: error instanceof RemoteMediaSessionError ? error.code : "MEDIA_PROTOCOL_FAILED",
        errorType: error instanceof Error ? error.name : typeof error,
        status
      });
      return new Response(null, { status });
    }
  });
}

interface ByteRange {
  start: number;
  end: number;
}

/** 解析浏览器单段 Range 请求，拒绝多段与越界范围。 */
export function parseByteRange(value: string, size: number): ByteRange | undefined {
  if (!Number.isSafeInteger(size) || size <= 0) return undefined;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return undefined;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}
