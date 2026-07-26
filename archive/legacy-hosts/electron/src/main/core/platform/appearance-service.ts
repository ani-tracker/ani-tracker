import { BrowserWindow, nativeTheme } from "electron";
import type { AppearanceSettings, ThemeMode } from "@shared/theme";
import { logger } from "../logger";

const WINDOW_BACKGROUND = {
  light: "#f8fafc",
  dark: "#151619"
} as const;

/** 统一 Electron 原生主题与窗口背景，避免主进程和页面明暗不一致。 */
export class AppearanceService {
  constructor(private readonly getWindow: () => BrowserWindow | null) {
    nativeTheme.on("updated", this.handleNativeThemeUpdated);
  }

  /** 应用持久化主题模式并刷新当前窗口背景。 */
  applySettings(settings: AppearanceSettings): void {
    nativeTheme.themeSource = toElectronThemeSource(settings.themeMode);
    this.refreshWindowBackground();
    logger.info("Appearance settings applied", {
      themeMode: settings.themeMode,
      themePackId: settings.themePackId,
      resolvedTheme: nativeTheme.shouldUseDarkColors ? "dark" : "light"
    });
  }

  /** 返回创建窗口时应使用的背景色。 */
  getWindowBackgroundColor(): string {
    return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
  }

  /** 释放原生主题监听器。 */
  dispose(): void {
    nativeTheme.off("updated", this.handleNativeThemeUpdated);
  }

  private readonly handleNativeThemeUpdated = (): void => {
    this.refreshWindowBackground();
    logger.info("System appearance changed", {
      resolvedTheme: nativeTheme.shouldUseDarkColors ? "dark" : "light"
    });
  };

  private refreshWindowBackground(): void {
    const window = this.getWindow();
    if (window && !window.isDestroyed()) {
      window.setBackgroundColor(this.getWindowBackgroundColor());
    }
  }
}

/** 将应用主题模式映射为 Electron 原生主题源。 */
export function toElectronThemeSource(mode: ThemeMode): "system" | "light" | "dark" {
  return mode;
}
