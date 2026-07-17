type AppClient = NonNullable<Window["aniBridge"]>;

interface RemoteRpcResponse {
  result?: unknown;
  error?: string;
  code?: string;
}

const REMOTE_TOKEN_STORAGE_KEY = "ani.remoteAccessToken";
export const REMOTE_AUTH_CHANGED_EVENT = "ani:remote-auth-changed";
const REMOTE_METHODS = new Set([
  "getDashboard",
  "listNotifications",
  "getUnreadNotificationCount",
  "markNotificationRead",
  "markAllNotificationsRead",
  "listMyAnime",
  "listAnimeCatalog",
  "searchAnimeCatalog",
  "listFansubs",
  "listEpisodes",
  "listEpisodePreferences",
  "listDownloads",
  "refreshDownloads",
  "pauseDownload",
  "resumeDownload"
]);

export interface RemotePairingState {
  needsPairing: boolean;
  remoteUrl?: string;
}

/** 判断当前渲染进程是否运行在 Electron 桌面端。 */
export function isElectronClient(): boolean {
  return Boolean(window.aniBridge);
}

/** 返回 PWA 使用的同源远程地址，跨源接入留待 HTTPS 阶段。 */
export function getRemoteBaseUrl(): string | undefined {
  if (isElectronClient()) {
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
    throw new Error("Electron 桌面端不需要远程配对");
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
  window.dispatchEvent(new Event(REMOTE_AUTH_CHANGED_EVENT));
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

/** 创建与 Electron bridge 同形的远程客户端代理。 */
function createRemoteClient(baseUrl: string): AppClient {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return new Proxy({} as AppClient, {
    get(_target, property) {
      if (typeof property !== "string") {
        return undefined;
      }
      if (!REMOTE_METHODS.has(property)) {
        return async () => {
          throw new Error("当前远程客户端未开放此功能");
        };
      }

      return (...args: unknown[]) => invokeRemote(normalizedBaseUrl, property, args);
    }
  });
}

/** 根据运行环境选择 Electron IPC 或远程 HTTP 客户端。 */
function createAppClient(): AppClient {
  if (window.aniBridge) {
    console.info("[renderer] 使用 Electron IPC 客户端");
    return window.aniBridge;
  }

  const remoteUrl = getRemoteBaseUrl();
  if (remoteUrl) {
    console.info("[renderer] 使用远程 HTTP 客户端", { remoteUrl });
    return createRemoteClient(remoteUrl);
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
