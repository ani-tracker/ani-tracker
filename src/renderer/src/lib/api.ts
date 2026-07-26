import type {
  ImageCacheResolveResult,
  RemotePlaybackRequestMode,
  RemotePlaybackSession
} from "@shared/contracts";
import type { AppClient } from "@shared/app-client";
import { createRemoteClient } from "@/lib/clients/remote-client";
import { createTauriClient } from "@/lib/clients/tauri-client";
import { getAppRuntime, isLocalAppRuntime, isTauriAppRuntime } from "@/lib/runtime";

interface RemoteRpcResponse {
  result?: unknown;
  error?: string;
  code?: string;
}

const REMOTE_TOKEN_STORAGE_KEY = "ani.remoteAccessToken";
export const REMOTE_AUTH_CHANGED_EVENT = "ani:remote-auth-changed";
const imageResolveRequests = new Map<string, Promise<string>>();

export interface RemotePairingState {
  needsPairing: boolean;
  remoteUrl?: string;
}

/** 判断当前渲染进程是否运行在 Tauri 本地应用。 */
export function isLocalClient(): boolean {
  return isLocalAppRuntime();
}

/** 判断当前渲染进程是否运行在 Tauri 本地应用。 */
export function isTauriClient(): boolean {
  return isTauriAppRuntime();
}

/** 判断当前渲染进程是否运行在 Android 本地应用。 */
export function isAndroidClient(): boolean {
  return getAppRuntime() === "android";
}

/** 返回 PWA 使用的同源远程地址，跨源接入留待 HTTPS 阶段。 */
export function getRemoteBaseUrl(): string | undefined {
  if (isLocalAppRuntime()) {
    return undefined;
  }
  return window.location.origin.replace(/\/+$/, "");
}

/** 返回远程客户端是否已保存设备令牌。 */
export function getRemotePairingState(): RemotePairingState {
  const remoteUrl = getRemoteBaseUrl();
  return {
    needsPairing: Boolean(remoteUrl && !window.localStorage.getItem(REMOTE_TOKEN_STORAGE_KEY)),
    remoteUrl
  };
}

/** 使用桌面端一次性配对码换取设备令牌。 */
export async function pairRemoteDevice(code: string, deviceName: string): Promise<void> {
  const baseUrl = getRemoteBaseUrl();
  if (!baseUrl) {
    throw new Error("本地桌面端不需要远程配对");
  }
  const response = await fetch(`${baseUrl}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName })
  });
  const payload = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !payload.token) {
    throw new Error(payload.error ?? `配对失败：${response.status}`);
  }
  window.localStorage.setItem(REMOTE_TOKEN_STORAGE_KEY, payload.token);
  window.dispatchEvent(new Event(REMOTE_AUTH_CHANGED_EVENT));
}

/** 清除本机设备令牌，用于重新配对。 */
export function clearRemoteDeviceToken(): void {
  window.localStorage.removeItem(REMOTE_TOKEN_STORAGE_KEY);
  imageResolveRequests.clear();
  window.dispatchEvent(new Event(REMOTE_AUTH_CHANGED_EVENT));
}

/** 将公网图片地址解析为桌面协议或远程同源缓存地址。 */
export function resolveCachedImageUrl(sourceUrl: string): Promise<string> {
  const normalizedSourceUrl = sourceUrl.trim();
  if (!normalizedSourceUrl) {
    return Promise.reject(new Error("图片地址不能为空"));
  }

  const existing = imageResolveRequests.get(normalizedSourceUrl);
  if (existing) {
    return existing;
  }

  const request = resolveCachedImageUrlOnce(normalizedSourceUrl).finally(() => {
    if (imageResolveRequests.get(normalizedSourceUrl) === request) {
      imageResolveRequests.delete(normalizedSourceUrl);
    }
  });
  imageResolveRequests.set(normalizedSourceUrl, request);
  return request;
}

/** 按当前运行环境请求一次签名图片缓存地址。 */
async function resolveCachedImageUrlOnce(sourceUrl: string): Promise<string> {
  if (isLocalAppRuntime()) {
    const result = await appApi.resolveCachedImageUrl(sourceUrl);
    return result.url;
  }

  const baseUrl = getRemoteBaseUrl();
  const accessToken = window.localStorage.getItem(REMOTE_TOKEN_STORAGE_KEY);
  if (!baseUrl || !accessToken) {
    throw new Error("当前设备尚未完成远程配对");
  }
  const response = await fetch(`${baseUrl}/api/images/resolve`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ url: sourceUrl })
  });
  const payload = (await response.json().catch(() => ({}))) as ImageCacheResolveResult & { error?: string };
  if (!response.ok || !payload.url) {
    if (response.status === 401) {
      clearRemoteDeviceToken();
    }
    throw new Error(payload.error ?? `图片地址解析失败：${response.status}`);
  }
  return new URL(payload.url, `${baseUrl}/`).toString();
}

/** 为当前远程设备创建绑定下载任务的播放会话。 */
export async function createRemotePlaybackSession(
  taskId: string,
  mode: RemotePlaybackRequestMode,
  fileIndex?: number
): Promise<RemotePlaybackSession> {
  return createRemoteMediaSession("/api/media/sessions", taskId, mode, fileIndex);
}

/** 为 PotPlayer 或 IINA 创建无需 Cookie 的短期拉流会话。 */
export async function createRemoteExternalPlaybackSession(
  taskId: string,
  mode: RemotePlaybackRequestMode,
  fileIndex?: number
): Promise<RemotePlaybackSession> {
  return createRemoteMediaSession("/api/media/external-sessions", taskId, mode, fileIndex);
}

/** 调用指定媒体入口创建远程播放会话。 */
async function createRemoteMediaSession(
  endpoint: "/api/media/sessions" | "/api/media/external-sessions",
  taskId: string,
  mode: RemotePlaybackRequestMode,
  fileIndex?: number
): Promise<RemotePlaybackSession> {
  const baseUrl = getRemoteBaseUrl();
  const accessToken = window.localStorage.getItem(REMOTE_TOKEN_STORAGE_KEY);
  if (!baseUrl || !accessToken) {
    throw new Error("当前设备尚未完成远程配对");
  }
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ taskId, mode, ...(fileIndex === undefined ? {} : { fileIndex }) })
  });
  const payload = (await response.json().catch(() => ({}))) as RemotePlaybackSession & { error?: string };
  if (!response.ok || !payload.id) {
    if (response.status === 401) {
      clearRemoteDeviceToken();
    }
    throw new Error(payload.error ?? `播放会话创建失败：${response.status}`);
  }
  return payload;
}

/** 关闭远程播放会话并通知桌面端回收转码资源。 */
export async function closeRemotePlaybackSession(sessionId: string): Promise<void> {
  const baseUrl = getRemoteBaseUrl();
  const accessToken = window.localStorage.getItem(REMOTE_TOKEN_STORAGE_KEY);
  if (!baseUrl || !accessToken) {
    return;
  }
  const response = await fetch(`${baseUrl}/api/media/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok && response.status !== 404) {
    console.warn("[remote] 播放会话关闭失败", { sessionId, status: response.status });
  }
}

/** 调用桌面端暴露的远程 RPC，并统一处理协议错误。 */
async function invokeRemote(baseUrl: string, method: string, args: unknown[]): Promise<unknown> {
  const accessToken = window.localStorage.getItem(REMOTE_TOKEN_STORAGE_KEY);
  const response = await fetch(`${baseUrl}/api/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify({ method, args })
  });

  const payload = (await response.json().catch(() => ({}))) as RemoteRpcResponse;
  if (!response.ok || payload.error) {
    if (response.status === 401) {
      clearRemoteDeviceToken();
    }
    throw new Error(payload.error ?? `远程请求失败：${response.status}`);
  }

  return payload.result;
}

/** 根据运行环境选择 Tauri 本地客户端或桌面网关远程客户端。 */
function createAppClient(): AppClient {
  const runtime = getAppRuntime();
  if (isTauriClient()) {
    const platform = runtime === "android" || runtime === "ios" ? runtime : "tauri-desktop";
    console.info("[renderer] 使用 Tauri invoke 客户端", { platform });
    return createTauriClient(platform);
  }
  const remoteUrl = getRemoteBaseUrl();
  if (remoteUrl) {
    console.info("[renderer] 使用远程 HTTP 客户端", { remoteUrl });
    const normalizedBaseUrl = remoteUrl.replace(/\/+$/, "");
    return createRemoteClient((method, args) => invokeRemote(normalizedBaseUrl, method, args));
  }

  return new Proxy({} as AppClient, {
    get() {
      return async () => {
        throw new Error("当前环境未连接 Ani Tracker 桌面端，请配置 VITE_ANI_REMOTE_URL。");
      };
    }
  });
}

export const appApi: AppClient = createAppClient();
