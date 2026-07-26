import { join, resolve } from "node:path";

export interface RemoteRendererDirectoryOptions {
  appPath: string;
  bundleDirectory: string;
  rendererDevServerUrl?: string;
}

/** 按开发或生产运行模式返回远程 PWA 静态资源目录。 */
export function resolveRemoteRendererDirectory(options: RemoteRendererDirectoryOptions): string {
  const directory = options.rendererDevServerUrl
    ? join(options.appPath, ".remote-pwa", "renderer")
    : join(options.bundleDirectory, "../renderer");
  return resolve(directory);
}
