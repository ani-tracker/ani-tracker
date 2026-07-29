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
import { getAppRuntime } from "@/lib/runtime";
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
import { resolveToastPresentation } from "@shared/toast-policy";

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
  backgroundState: "none" | "loading" | "ready" | "missing" | "error";
  backgroundUrl?: string;
  resolvedTheme: ResolvedThemeMode;
  themePacks: ThemePackManifest[];
  previewAppearance: (appearance: AppearanceSettings) => void;
  clearPreview: () => void;
  commitAppearance: (appearance: AppearanceSettings) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  children: ReactNode;
  loadAppearance?: () => Promise<AppearanceSettings | undefined>;
  resolveBackground?: (themeId: string, fileName: string) => Promise<string | undefined>;
}

/** 管理跨端主题解析、预览、缓存和可选的平台设置加载。 */
export function ThemeProvider({ children, loadAppearance, resolveBackground }: ThemeProviderProps) {
  const [persistedAppearance, setPersistedAppearance] = useState(readCachedAppearance);
  const [preview, setPreview] = useState<AppearanceSettings | null>(null);
  const [systemDark, setSystemDark] = useState(readSystemDark);
  const [backgroundUrl, setBackgroundUrl] = useState<string>();
  const [backgroundState, setBackgroundState] = useState<ThemeContextValue["backgroundState"]>("none");
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
    let active = true;
    const background = themePack.backgroundImage;
    if (!background || !resolveBackground) {
      setBackgroundUrl(undefined);
      setBackgroundState("none");
      return () => {
        active = false;
      };
    }
    setBackgroundUrl(undefined);
    setBackgroundState("loading");
    void resolveBackground(themePack.id, background.file)
      .then((url) => {
        if (!active) return;
        setBackgroundUrl(url);
        setBackgroundState(url ? "ready" : "missing");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setBackgroundUrl(undefined);
        setBackgroundState("error");
        console.error("[renderer] 主题背景加载失败", {
          themeId: themePack.id,
          file: background.file,
          error
        });
      });
    return () => {
      active = false;
    };
  }, [resolveBackground, themePack.backgroundImage?.file, themePack.id]);

  useEffect(() => {
    writeThemeSnapshot(persistedAppearance, systemDark);
  }, [persistedAppearance, systemDark]);

  useEffect(() => {
    if (!loadAppearance) {
      return;
    }
    void loadAppearance()
      .then((appearance) => {
        if (!appearance) return;
        setPersistedAppearance(normalizeAppearanceSettings(appearance));
        console.info("[renderer] 外观设置加载完成", {
          themeMode: appearance.themeMode,
          themePackId: appearance.themePackId
        });
      })
      .catch((error: unknown) => {
        console.error("[renderer] 外观设置加载失败，继续使用缓存主题", error);
      });
  }, [loadAppearance]);

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
    backgroundState,
    backgroundUrl,
    resolvedTheme,
    themePacks: listAvailableThemePacks(appearance),
    previewAppearance,
    clearPreview,
    commitAppearance
  }), [appearance, backgroundState, backgroundUrl, clearPreview, commitAppearance, previewAppearance, resolvedTheme]);

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
  const presentation = resolveToastPresentation(getAppRuntime());
  return (
    <Toaster
      className={presentation.mobile ? "mobile-toast-center" : undefined}
      closeButton={presentation.closeButton}
      containerAriaLabel="应用提示"
      mobileOffset={presentation.mobile ? { left: "1rem", right: "1rem" } : undefined}
      position={presentation.position === "middle-center" ? "bottom-center" : presentation.position}
      richColors
      swipeDirections={presentation.swipeDirections}
      theme={resolvedTheme}
      visibleToasts={presentation.visibleToasts}
    />
  );
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
