import type { AppClient } from "@shared/app-client";
import { createTauriClient } from "@/lib/clients/tauri-client";
import { getAppRuntime, isTauriAppRuntime } from "@/lib/runtime";

const imageResolveRequests = new Map<string, Promise<string>>();

/** 判断当前渲染进程是否运行在本地应用。 */
export function isLocalClient(): boolean {
  return true;
}

/** 判断当前渲染进程是否运行在 Tauri 本地应用。 */
export function isTauriClient(): boolean {
  return isTauriAppRuntime();
}

/** 判断当前渲染进程是否运行在 Android 本地应用。 */
export function isAndroidClient(): boolean {
  return getAppRuntime() === "android";
}

/** 将公网图片地址解析为 Tauri 受控缓存地址。 */
export function resolveCachedImageUrl(sourceUrl: string): Promise<string> {
  const normalizedSourceUrl = sourceUrl.trim();
  if (!normalizedSourceUrl) {
    return Promise.reject(new Error("图片地址不能为空"));
  }
  const existing = imageResolveRequests.get(normalizedSourceUrl);
  if (existing) return existing;

  const request = appApi.resolveCachedImageUrl(normalizedSourceUrl)
    .then((result) => result.url)
    .finally(() => {
      if (imageResolveRequests.get(normalizedSourceUrl) === request) {
        imageResolveRequests.delete(normalizedSourceUrl);
      }
    });
  imageResolveRequests.set(normalizedSourceUrl, request);
  return request;
}

/** 删除解码失败对应的宿主缓存，并清理当前解析请求。 */
export async function invalidateCachedImageUrl(sourceUrl: string): Promise<void> {
  const normalizedSourceUrl = sourceUrl.trim();
  imageResolveRequests.delete(normalizedSourceUrl);
  const invalidate = appApi.invalidateCachedImageUrl;
  if (!invalidate) {
    throw new Error("当前宿主不支持失效图片缓存");
  }
  await invalidate.call(appApi, normalizedSourceUrl);
}

/** 创建仅允许 Tauri invoke 的本地客户端。 */
function createAppClient(): AppClient {
  const runtime = getAppRuntime();
  if (isTauriClient()) {
    const platform = runtime === "android" || runtime === "ios" ? runtime : "tauri-desktop";
    console.info("[renderer] 使用 Tauri invoke 客户端", { platform });
    return createTauriClient(platform);
  }

  console.error("[renderer] 本地 Renderer 缺少 Tauri bridge");
  return new Proxy({} as AppClient, {
    get() {
      return async () => {
        throw new Error("本地应用未连接 Tauri 宿主，请从 Tauri 入口启动。");
      };
    }
  });
}

export const appApi: AppClient = createAppClient();
