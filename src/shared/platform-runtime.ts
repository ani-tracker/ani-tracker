/** 应用支持的客户端运行时。 */
export type AppRuntimeKind = "desktop" | "android" | "remote";

/** 页面用于决定功能可见性的平台能力集合。 */
export interface PlatformCapabilities {
  runtime: AppRuntimeKind;
  localData: boolean;
  sourceManagement: boolean;
  embeddedTorrent: boolean;
  externalQbittorrent: boolean;
  managedQbittorrent: boolean;
  nativePlayer: boolean;
  externalPlayerConfiguration: boolean;
  mediaScan: boolean;
  backgroundAutomation: boolean;
  windowControls: boolean;
  remoteGateway: boolean;
  fileExport: boolean;
}

/** 运行时探测所需的最小环境信息，避免共享层直接访问 window。 */
export interface AppRuntimeProbe {
  hasElectronBridge: boolean;
  nativePlatform?: string;
}

const PLATFORM_CAPABILITIES: Record<AppRuntimeKind, PlatformCapabilities> = {
  desktop: {
    runtime: "desktop",
    localData: true,
    sourceManagement: true,
    embeddedTorrent: true,
    externalQbittorrent: true,
    managedQbittorrent: true,
    nativePlayer: true,
    externalPlayerConfiguration: true,
    mediaScan: true,
    backgroundAutomation: true,
    windowControls: true,
    remoteGateway: true,
    fileExport: true
  },
  android: {
    runtime: "android",
    localData: true,
    sourceManagement: true,
    embeddedTorrent: true,
    externalQbittorrent: true,
    managedQbittorrent: false,
    nativePlayer: true,
    externalPlayerConfiguration: false,
    mediaScan: true,
    backgroundAutomation: true,
    windowControls: false,
    remoteGateway: false,
    fileExport: true
  },
  remote: {
    runtime: "remote",
    localData: false,
    sourceManagement: false,
    embeddedTorrent: false,
    externalQbittorrent: false,
    managedQbittorrent: false,
    nativePlayer: false,
    externalPlayerConfiguration: false,
    mediaScan: false,
    backgroundAutomation: false,
    windowControls: false,
    remoteGateway: false,
    fileExport: false
  }
};

/** 按明确优先级识别桌面、Android 或远程运行时。 */
export function resolveAppRuntime(probe: AppRuntimeProbe): AppRuntimeKind {
  if (probe.hasElectronBridge) {
    return "desktop";
  }
  if (probe.nativePlatform?.toLowerCase() === "android") {
    return "android";
  }
  return "remote";
}

/** 返回只读的平台能力副本，防止调用方污染全局定义。 */
export function getPlatformCapabilities(runtime: AppRuntimeKind): PlatformCapabilities {
  return { ...PLATFORM_CAPABILITIES[runtime] };
}
