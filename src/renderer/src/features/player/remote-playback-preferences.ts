import type { RemotePlaybackRequestMode } from "@shared/contracts";

const REMOTE_PLAYBACK_MODE_KEY = "ani.remotePlayer.defaultMode";

/** 读取当前远程设备的默认播放模式。 */
export function readRemotePlaybackMode(): RemotePlaybackRequestMode {
  try {
    return window.localStorage.getItem(REMOTE_PLAYBACK_MODE_KEY) === "transcode"
      ? "transcode"
      : "direct";
  } catch (error) {
    console.warn("[remote] 默认播放模式读取失败", { error });
    return "direct";
  }
}

/** 保存当前远程设备的默认播放模式。 */
export function storeRemotePlaybackMode(mode: RemotePlaybackRequestMode): void {
  try {
    window.localStorage.setItem(REMOTE_PLAYBACK_MODE_KEY, mode);
    console.info("[remote] 默认播放模式已保存", { mode });
  } catch (error) {
    console.warn("[remote] 默认播放模式保存失败", { mode, error });
  }
}
