type AppClient = NonNullable<Window["aniBridge"]>;

interface RemoteRpcResponse {
  result?: unknown;
  error?: string;
}

const REMOTE_TOKEN_STORAGE_KEY = "ani.remoteAccessToken";

/** 调用桌面端暴露的远程 RPC，并统一处理协议错误。 */
async function invokeRemote(baseUrl: string, method: string, args: unknown[]): Promise<unknown> {
  const accessToken = window.sessionStorage.getItem(REMOTE_TOKEN_STORAGE_KEY);
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

  const remoteUrl = import.meta.env.VITE_ANI_REMOTE_URL?.trim();
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
