import type {
  DesktopPlaybackSessionInput,
  RemotePlaybackSession
} from "@shared/contracts";
import { logger } from "../logger";
import {
  RemoteMediaSessionError,
  type RemoteMediaAsset,
  type RemoteMediaSessionService
} from "../remote/remote-media-session-service";

const DESKTOP_PLAYER_DEVICE_PREFIX = "desktop-player";
const EXTERNAL_MEDIA_URL_PATTERN = /^\/api\/media\/external\/([A-Za-z0-9_-]{43})\/sessions\/([A-Za-z0-9_-]{32})(\/.+)$/;
const DESKTOP_MEDIA_URL_PATTERN = /^\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{32})\/(?:(file)|hls\/(index\.m3u8|segment-\d{6}\.ts)|subtitles\/(subtitle-\d{3}\.(?:ass|vtt)))$/;

type MediaSessionBackend = Pick<
  RemoteMediaSessionService,
  "createExternalSession" | "closeSession" | "closeDeviceSessions" | "getExternalAsset"
>;

/** 为 Electron 内置播放器创建带高熵票据的本地媒体会话。 */
export class DesktopPlaybackSessionService {
  constructor(private readonly mediaSessionService: MediaSessionBackend) {}

  /** 校验播放目标并返回 ani-media 协议地址。 */
  async createSession(input: DesktopPlaybackSessionInput, ownerId: number): Promise<RemotePlaybackSession> {
    validateInput(input);
    const deviceId = createDesktopPlayerDeviceId(ownerId);
    const session = await this.mediaSessionService.createExternalSession(
      input.taskId,
      deviceId,
      "direct",
      input.fileIndex
    );
    const mapped = {
      ...session,
      streamUrl: toDesktopMediaUrl(session.streamUrl),
      subtitles: session.subtitles.map((subtitle) => ({
        ...subtitle,
        url: toDesktopMediaUrl(subtitle.url)
      }))
    };
    logger.info("桌面内置播放会话已创建", {
      sessionId: session.id,
      taskId: session.taskId,
      fileIndex: session.fileIndex,
      mode: session.mode
    });
    return mapped;
  }

  /** 关闭桌面播放器拥有的会话并回收媒体资源。 */
  async closeSession(sessionId: string, ownerId: number): Promise<void> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(sessionId)) {
      return;
    }
    const closed = await this.mediaSessionService.closeSession(
      sessionId,
      createDesktopPlayerDeviceId(ownerId)
    );
    logger.info("桌面内置播放会话已关闭", { sessionId, closed });
  }

  /** 回收指定播放器窗口拥有的全部媒体会话。 */
  async closeOwnerSessions(ownerId: number): Promise<void> {
    const closedCount = await this.mediaSessionService.closeDeviceSessions(
      createDesktopPlayerDeviceId(ownerId)
    );
    logger.info("桌面内置播放器窗口会话已回收", { ownerId, closedCount });
  }

  /** 校验 ani-media 票据并解析对应媒体资源。 */
  async resolveAsset(requestUrl: string): Promise<RemoteMediaAsset> {
    const url = new URL(requestUrl);
    const route = url.hostname === "session" ? DESKTOP_MEDIA_URL_PATTERN.exec(url.pathname) : null;
    const assetName = route?.[3] ?? route?.[4] ?? route?.[5];
    if (!route || !assetName) {
      throw new RemoteMediaSessionError(404, "MEDIA_ASSET_NOT_FOUND", "媒体资源地址无效");
    }
    return this.mediaSessionService.getExternalAsset(route[2], route[1], assetName);
  }
}

/** 将远程服务生成的票据路径映射为 Electron 私有媒体协议。 */
export function toDesktopMediaUrl(value: string): string {
  const match = EXTERNAL_MEDIA_URL_PATTERN.exec(value);
  if (!match) {
    throw new RemoteMediaSessionError(500, "MEDIA_URL_INVALID", "媒体会话地址无效");
  }
  return `ani-media://session/${match[1]}/${match[2]}${match[3]}`;
}

/** 拒绝来自渲染进程的异常播放会话参数。 */
function validateInput(input: DesktopPlaybackSessionInput): void {
  if (!input || !/^[a-zA-Z0-9._:-]{1,160}$/.test(input.taskId)) {
    throw new RemoteMediaSessionError(400, "MEDIA_TASK_INVALID", "下载任务标识无效");
  }
  if (input.fileIndex !== undefined && (!Number.isSafeInteger(input.fileIndex) || input.fileIndex < 0)) {
    throw new RemoteMediaSessionError(400, "MEDIA_FILE_INVALID", "媒体文件标识无效");
  }
}

/** 将可信的 Electron 渲染进程标识转换为媒体会话所有者。 */
function createDesktopPlayerDeviceId(ownerId: number): string {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new RemoteMediaSessionError(400, "MEDIA_OWNER_INVALID", "播放器窗口标识无效");
  }
  return `${DESKTOP_PLAYER_DEVICE_PREFIX}:${ownerId}`;
}
