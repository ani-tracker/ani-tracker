import { registerPlugin } from "@capacitor/core";
import type { AppDirectories, SecureStorePort } from "@shared/platform/ports";

interface SecureStoreKey {
  key: string;
}

interface SecureStoreValue extends SecureStoreKey {
  value: string;
}

interface SecureStoreResult {
  value?: string;
}

interface AndroidPlatformPlugin {
  getDirectories(): Promise<AppDirectories>;
  secureGet(options: SecureStoreKey): Promise<SecureStoreResult>;
  secureSet(options: SecureStoreValue): Promise<void>;
  secureDelete(options: SecureStoreKey): Promise<void>;
  invoke(options: { method: string; args: unknown[] }): Promise<{ value: unknown }>;
}

const nativePlatform = registerPlugin<AndroidPlatformPlugin>("AniPlatform");

/** 将 Capacitor 插件注册为 Renderer 使用的 Android 客户端桥。 */
export function installAndroidClientBridge(): void {
  window.aniAndroidBridge = {
    async invoke(method, args) {
      const result = await nativePlatform.invoke({ method, args });
      return result.value;
    }
  };
  console.info("[android] 原生客户端桥已注册");
}

/** 读取并由原生端预创建 Android 应用目录。 */
export async function getAndroidDirectories(): Promise<AppDirectories> {
  const directories = await nativePlatform.getDirectories();
  console.info("[android] 应用目录已准备", {
    databasePath: directories.databasePath,
    downloadDir: directories.downloadDir
  });
  return directories;
}

/** 创建由 Android Keystore 保护的敏感凭据存储适配器。 */
export function createAndroidSecureStore(): SecureStorePort {
  return {
    async get(key) {
      return (await nativePlatform.secureGet({ key })).value;
    },
    async set(key, value) {
      await nativePlatform.secureSet({ key, value });
    },
    async delete(key) {
      await nativePlatform.secureDelete({ key });
    }
  };
}
