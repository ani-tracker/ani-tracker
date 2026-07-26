import type {
  RemotePlaybackRequestMode,
  RemotePlaybackSession
} from "@shared/contracts";
import {
  appApi,
  closeRemotePlaybackSession,
  createRemotePlaybackSession
} from "@/lib/api";

export interface PlaybackSessionClient {
  create(taskId: string, mode: RemotePlaybackRequestMode, fileIndex?: number): Promise<RemotePlaybackSession>;
  close(sessionId: string): Promise<void>;
}

/** 使用远程 HTTP 鉴权接口创建播放器会话。 */
export const remotePlaybackSessionClient: PlaybackSessionClient = {
  create: createRemotePlaybackSession,
  close: closeRemotePlaybackSession
};

/** 使用本地 AppClient 创建受控播放器会话。 */
export const desktopPlaybackSessionClient: PlaybackSessionClient = {
  create: (taskId, _mode, fileIndex) => appApi.createDesktopPlaybackSession({
    taskId,
    ...(fileIndex === undefined ? {} : { fileIndex })
  }),
  close: (sessionId) => appApi.closeDesktopPlaybackSession(sessionId)
};
