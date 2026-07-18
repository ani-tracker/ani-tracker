import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { Toaster } from "@/components/ui/sonner";
import { appApi, isElectronClient } from "@/lib/api";
import {
  THEME_TOKEN_NAMES,
  createDefaultAppearanceSettings,
  listAvailableThemePacks,
  normalizeAppearanceSettings,
  resolveThemePack,
  type AppearanceSettings,
  type ResolvedThemeMode,
  type ThemePackManifest,
  type ThemeTokens
} from "@shared/theme";

const THEME_CACHE_KEY = "ani.theme.snapshot";

interface ThemeSnapshot {
  appearance: AppearanceSettings;
  resolvedTheme: ResolvedThemeMode;
  themePackId: string;
  tokens: ThemeTokens;
  radius: string;
}

interface ThemeContextValue {
  appearance: AppearanceSettings;
  resolvedTheme: ResolvedThemeMode;
  themePacks: ThemePackManifest[];
  previewAppearance: (appearance: AppearanceSettings) => void;
  clearPreview: () => void;
  commitAppearance: (appearance: AppearanceSettings) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** 管理桌面与 Web 的主题解析、预览、缓存和系统外观监听。 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [persistedAppearance, setPersistedAppearance] = useState(readCachedAppearance);
  const [preview, setPreview] = useState<AppearanceSettings | null>(null);
  const [systemDark, setSystemDark] = useState(readSystemDark);
  const appearance = preview ?? persistedAppearance;
  const resolvedTheme = resolveThemeMode(appearance, systemDark);
  const themePack = resolveThemePack(appearance);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    applyThemeToDocument(themePack, resolvedTheme);
  }, [resolvedTheme, themePack]);

  useEffect(() => {
    writeThemeSnapshot(persistedAppearance, systemDark);
  }, [persistedAppearance, systemDark]);

  useEffect(() => {
    if (!isElectronClient()) {
      return;
    }
    void appApi.getSettings()
      .then((settings) => {
        setPersistedAppearance(normalizeAppearanceSettings(settings.appearance));
        console.info("[renderer] 外观设置加载完成", {
          themeMode: settings.appearance.themeMode,
          themePackId: settings.appearance.themePackId
        });
      })
      .catch((error: unknown) => {
        console.error("[renderer] 外观设置加载失败，继续使用缓存主题", error);
      });
  }, []);

  const previewAppearance = useCallback((next: AppearanceSettings) => {
    setPreview(normalizeAppearanceSettings(next));
  }, []);

  const clearPreview = useCallback(() => {
    setPreview(null);
  }, []);

  const commitAppearance = useCallback((next: AppearanceSettings) => {
    const normalized = normalizeAppearanceSettings(next);
    setPersistedAppearance(normalized);
    setPreview(null);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    appearance,
    resolvedTheme,
    themePacks: listAvailableThemePacks(appearance),
    previewAppearance,
    clearPreview,
    commitAppearance
  }), [appearance, clearPreview, commitAppearance, previewAppearance, resolvedTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** 读取当前主题上下文。 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme 必须在 ThemeProvider 内使用");
  }
  return context;
}

/** 让 toast 外观跟随当前实际明暗模式。 */
export function ThemeToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster closeButton position="top-right" richColors theme={resolvedTheme} />;
}

function resolveThemeMode(appearance: AppearanceSettings, systemDark: boolean): ResolvedThemeMode {
  if (appearance.themeMode === "system") {
    return systemDark ? "dark" : "light";
  }
  return appearance.themeMode;
}

function applyThemeToDocument(pack: ThemePackManifest, resolvedTheme: ResolvedThemeMode): void {
  const root = document.documentElement;
  const tokens = pack.tokens[resolvedTheme];
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.dataset.themePack = pack.id;
  root.style.colorScheme = resolvedTheme;
  root.style.setProperty("--radius", pack.style.radius);
  for (const token of THEME_TOKEN_NAMES) {
    root.style.setProperty(`--${token}`, tokens[token]);
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  meta?.setAttribute("content", `hsl(${tokens.primary})`);
}

function readCachedAppearance(): AppearanceSettings {
  try {
    const snapshot = JSON.parse(window.localStorage.getItem(THEME_CACHE_KEY) ?? "null") as Partial<ThemeSnapshot> | null;
    return normalizeAppearanceSettings(snapshot?.appearance);
  } catch {
    return createDefaultAppearanceSettings();
  }
}

function writeThemeSnapshot(appearance: AppearanceSettings, systemDark: boolean): void {
  const normalized = normalizeAppearanceSettings(appearance);
  const resolvedTheme = resolveThemeMode(normalized, systemDark);
  const pack = resolveThemePack(normalized);
  const snapshot: ThemeSnapshot = {
    appearance: normalized,
    resolvedTheme,
    themePackId: pack.id,
    tokens: pack.tokens[resolvedTheme],
    radius: pack.style.radius
  };
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn("[renderer] 主题缓存写入失败", error);
  }
}

function readSystemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
