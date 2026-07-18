export const THEME_SCHEMA_VERSION = 1 as const;
export const DEFAULT_THEME_PACK_ID = "default";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedThemeMode = Exclude<ThemeMode, "system">;

export const THEME_TOKEN_NAMES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "info",
  "info-foreground",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring"
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

/** 提供给导入器和外部主题工具复用的 JSON Schema。 */
export const THEME_PACK_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ani-tracker.local/schemas/theme-pack-v1.json",
  title: "Ani Tracker Theme Pack",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "name", "version", "style", "tokens"],
  properties: {
    schemaVersion: { const: THEME_SCHEMA_VERSION },
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,63}$" },
    name: { type: "string", minLength: 1, maxLength: 40 },
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$" },
    author: { type: "string", maxLength: 60 },
    description: { type: "string", maxLength: 160 },
    style: {
      type: "object",
      additionalProperties: false,
      required: ["radius"],
      properties: { radius: { type: "string", pattern: "^(?:[0-9]|1[0-2])(?:\\.[0-9]+)?px$" } }
    },
    tokens: {
      type: "object",
      additionalProperties: false,
      required: ["light", "dark"],
      properties: {
        light: { $ref: "#/$defs/themeTokens" },
        dark: { $ref: "#/$defs/themeTokens" }
      }
    }
  },
  $defs: {
    themeTokens: {
      type: "object",
      additionalProperties: false,
      required: [...THEME_TOKEN_NAMES],
      properties: Object.fromEntries(THEME_TOKEN_NAMES.map((name) => [name, {
        type: "string",
        pattern: "^(?:[0-9]{1,3}(?:\\.[0-9]+)?)\\s+(?:[0-9]{1,3}(?:\\.[0-9]+)?)%\\s+(?:[0-9]{1,3}(?:\\.[0-9]+)?)%$"
      }]))
    }
  }
} as const;

export interface ThemePackManifest {
  schemaVersion: typeof THEME_SCHEMA_VERSION;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  style: {
    radius: string;
  };
  tokens: {
    light: ThemeTokens;
    dark: ThemeTokens;
  };
}

export interface AppearanceSettings {
  themeMode: ThemeMode;
  themePackId: string;
  customThemePacks: ThemePackManifest[];
}

export interface ThemePackValidationResult {
  ok: boolean;
  errors: string[];
  pack?: ThemePackManifest;
}

const DEFAULT_LIGHT_TOKENS: ThemeTokens = {
  background: "210 30% 98%",
  foreground: "215 22% 15%",
  card: "0 0% 100%",
  "card-foreground": "215 22% 15%",
  popover: "0 0% 100%",
  "popover-foreground": "215 22% 15%",
  primary: "172 70% 30%",
  "primary-foreground": "0 0% 100%",
  secondary: "210 18% 94%",
  "secondary-foreground": "215 22% 20%",
  muted: "210 22% 92%",
  "muted-foreground": "215 12% 42%",
  accent: "190 34% 91%",
  "accent-foreground": "196 49% 20%",
  destructive: "350 84% 48%",
  "destructive-foreground": "0 0% 100%",
  success: "154 65% 32%",
  "success-foreground": "0 0% 100%",
  warning: "39 92% 43%",
  "warning-foreground": "31 68% 16%",
  info: "205 78% 40%",
  "info-foreground": "0 0% 100%",
  border: "214 18% 85%",
  input: "214 18% 85%",
  ring: "172 70% 30%",
  "chart-1": "172 70% 30%",
  "chart-2": "205 78% 40%",
  "chart-3": "344 66% 44%",
  "chart-4": "39 92% 43%",
  "chart-5": "262 50% 52%",
  sidebar: "0 0% 100%",
  "sidebar-foreground": "215 22% 18%",
  "sidebar-primary": "172 70% 30%",
  "sidebar-primary-foreground": "0 0% 100%",
  "sidebar-accent": "190 34% 91%",
  "sidebar-accent-foreground": "196 49% 20%",
  "sidebar-border": "214 18% 85%",
  "sidebar-ring": "172 70% 30%"
};

const DEFAULT_DARK_TOKENS: ThemeTokens = {
  background: "220 12% 9%",
  foreground: "210 20% 94%",
  card: "220 11% 12%",
  "card-foreground": "210 20% 94%",
  popover: "220 11% 12%",
  "popover-foreground": "210 20% 94%",
  primary: "171 68% 46%",
  "primary-foreground": "176 62% 8%",
  secondary: "217 10% 18%",
  "secondary-foreground": "210 18% 91%",
  muted: "217 10% 18%",
  "muted-foreground": "215 12% 66%",
  accent: "190 24% 20%",
  "accent-foreground": "185 42% 88%",
  destructive: "350 70% 53%",
  "destructive-foreground": "0 0% 100%",
  success: "151 56% 45%",
  "success-foreground": "151 70% 8%",
  warning: "40 90% 58%",
  "warning-foreground": "35 76% 10%",
  info: "204 80% 62%",
  "info-foreground": "210 72% 10%",
  border: "217 10% 24%",
  input: "217 10% 24%",
  ring: "171 68% 46%",
  "chart-1": "171 68% 46%",
  "chart-2": "204 80% 62%",
  "chart-3": "344 72% 64%",
  "chart-4": "40 90% 58%",
  "chart-5": "262 68% 70%",
  sidebar: "220 12% 11%",
  "sidebar-foreground": "210 18% 90%",
  "sidebar-primary": "171 68% 46%",
  "sidebar-primary-foreground": "176 62% 8%",
  "sidebar-accent": "190 24% 20%",
  "sidebar-accent-foreground": "185 42% 88%",
  "sidebar-border": "217 10% 24%",
  "sidebar-ring": "171 68% 46%"
};

export const BUILT_IN_THEME_PACKS: readonly ThemePackManifest[] = [
  {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: DEFAULT_THEME_PACK_ID,
    name: "青岚",
    version: "1.0.0",
    author: "Ani Tracker",
    description: "中性灰表面搭配青绿色主操作色。",
    style: { radius: "8px" },
    tokens: { light: DEFAULT_LIGHT_TOKENS, dark: DEFAULT_DARK_TOKENS }
  },
  {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: "coral-coast",
    name: "珊瑚海岸",
    version: "1.0.0",
    author: "Ani Tracker",
    description: "珊瑚红主操作色与海蓝辅助色，表面保持近中性。",
    style: { radius: "6px" },
    tokens: {
      light: {
        ...DEFAULT_LIGHT_TOKENS,
        primary: "8 75% 49%",
        "primary-foreground": "0 0% 100%",
        accent: "203 64% 91%",
        "accent-foreground": "207 52% 23%",
        ring: "8 75% 49%",
        "chart-1": "8 75% 49%",
        "chart-2": "203 72% 43%",
        "sidebar-primary": "8 75% 49%",
        "sidebar-accent": "203 64% 91%",
        "sidebar-accent-foreground": "207 52% 23%",
        "sidebar-ring": "8 75% 49%"
      },
      dark: {
        ...DEFAULT_DARK_TOKENS,
        primary: "8 80% 66%",
        "primary-foreground": "8 62% 10%",
        accent: "203 30% 22%",
        "accent-foreground": "201 58% 88%",
        ring: "8 80% 66%",
        "chart-1": "8 80% 66%",
        "chart-2": "203 80% 65%",
        "sidebar-primary": "8 80% 66%",
        "sidebar-primary-foreground": "8 62% 10%",
        "sidebar-accent": "203 30% 22%",
        "sidebar-accent-foreground": "201 58% 88%",
        "sidebar-ring": "8 80% 66%"
      }
    }
  },
  {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: "berry-mint",
    name: "莓青",
    version: "1.0.0",
    author: "Ani Tracker",
    description: "莓红操作色配合低饱和薄荷辅助色。",
    style: { radius: "4px" },
    tokens: {
      light: {
        ...DEFAULT_LIGHT_TOKENS,
        primary: "344 66% 44%",
        "primary-foreground": "0 0% 100%",
        accent: "174 32% 90%",
        "accent-foreground": "177 46% 20%",
        ring: "344 66% 44%",
        "chart-1": "344 66% 44%",
        "chart-2": "174 60% 34%",
        "sidebar-primary": "344 66% 44%",
        "sidebar-accent": "174 32% 90%",
        "sidebar-accent-foreground": "177 46% 20%",
        "sidebar-ring": "344 66% 44%"
      },
      dark: {
        ...DEFAULT_DARK_TOKENS,
        primary: "344 72% 64%",
        "primary-foreground": "344 60% 10%",
        accent: "174 22% 20%",
        "accent-foreground": "170 38% 88%",
        ring: "344 72% 64%",
        "chart-1": "344 72% 64%",
        "chart-2": "174 58% 54%",
        "sidebar-primary": "344 72% 64%",
        "sidebar-primary-foreground": "344 60% 10%",
        "sidebar-accent": "174 22% 20%",
        "sidebar-accent-foreground": "170 38% 88%",
        "sidebar-ring": "344 72% 64%"
      }
    }
  }
];

const BUILT_IN_THEME_IDS = new Set(BUILT_IN_THEME_PACKS.map((pack) => pack.id));
const THEME_TOKEN_NAME_SET = new Set<string>(THEME_TOKEN_NAMES);
const MANIFEST_KEYS = new Set(["schemaVersion", "id", "name", "version", "author", "description", "style", "tokens"]);

/** 创建全新的默认外观设置，避免共享可变数组。 */
export function createDefaultAppearanceSettings(): AppearanceSettings {
  return {
    themeMode: "system",
    themePackId: DEFAULT_THEME_PACK_ID,
    customThemePacks: []
  };
}

/** 返回内置和用户主题的合并列表。 */
export function listAvailableThemePacks(appearance: AppearanceSettings): ThemePackManifest[] {
  return [...BUILT_IN_THEME_PACKS, ...appearance.customThemePacks];
}

/** 查找当前主题；未知标识稳定回退默认主题。 */
export function resolveThemePack(appearance: AppearanceSettings): ThemePackManifest {
  return listAvailableThemePacks(appearance).find((pack) => pack.id === appearance.themePackId)
    ?? BUILT_IN_THEME_PACKS[0];
}

/** 校验并规范化持久化外观设置，丢弃不可信主题包。 */
export function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  if (!isRecord(value)) {
    return createDefaultAppearanceSettings();
  }

  const customThemePacks: ThemePackManifest[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(value.customThemePacks)) {
    for (const candidate of value.customThemePacks) {
      if (customThemePacks.length >= 50) {
        break;
      }
      const result = validateThemePack(candidate);
      if (!result.pack || BUILT_IN_THEME_IDS.has(result.pack.id) || seenIds.has(result.pack.id)) {
        continue;
      }
      seenIds.add(result.pack.id);
      customThemePacks.push(result.pack);
    }
  }

  const themeMode = isThemeMode(value.themeMode) ? value.themeMode : "system";
  const requestedThemeId = typeof value.themePackId === "string" ? value.themePackId : DEFAULT_THEME_PACK_ID;
  const themePackId = BUILT_IN_THEME_IDS.has(requestedThemeId) || seenIds.has(requestedThemeId)
    ? requestedThemeId
    : DEFAULT_THEME_PACK_ID;

  return { themeMode, themePackId, customThemePacks };
}

/** 严格校验声明式主题包，不允许未知令牌或任意样式字段。 */
export function validateThemePack(value: unknown): ThemePackValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["主题包必须是 JSON 对象"] };
  }

  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key)) {
      errors.push(`不支持的主题包字段：${key}`);
    }
  }
  if (value.schemaVersion !== THEME_SCHEMA_VERSION) {
    errors.push(`仅支持 schemaVersion ${THEME_SCHEMA_VERSION}`);
  }
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value.id)) {
    errors.push("主题 ID 只能包含 2-64 位小写字母、数字和连字符");
  }
  if (typeof value.name !== "string" || value.name.trim().length < 1 || value.name.trim().length > 40) {
    errors.push("主题名称长度必须为 1-40 个字符");
  }
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i.test(value.version)) {
    errors.push("主题版本必须使用语义版本格式");
  }
  if (value.author !== undefined && (typeof value.author !== "string" || value.author.length > 60)) {
    errors.push("主题作者长度不能超过 60 个字符");
  }
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 160)) {
    errors.push("主题说明长度不能超过 160 个字符");
  }

  if (isRecord(value.style)) {
    for (const key of Object.keys(value.style)) {
      if (key !== "radius") {
        errors.push(`不支持的主题样式字段：${key}`);
      }
    }
  }
  const radius = isRecord(value.style) ? value.style.radius : undefined;
  if (!isValidRadius(radius)) {
    errors.push("圆角必须是 0-12px 范围内的 px 值");
  }

  if (isRecord(value.tokens)) {
    for (const key of Object.keys(value.tokens)) {
      if (key !== "light" && key !== "dark") {
        errors.push(`不支持的主题模式字段：${key}`);
      }
    }
  }
  const light = isRecord(value.tokens) ? validateTokenSet(value.tokens.light, "浅色", errors) : undefined;
  const dark = isRecord(value.tokens) ? validateTokenSet(value.tokens.dark, "深色", errors) : undefined;
  if (!isRecord(value.tokens)) {
    errors.push("主题包缺少 tokens 对象");
  }

  if (errors.length > 0 || !light || !dark || typeof radius !== "string") {
    return { ok: false, errors };
  }

  const pack: ThemePackManifest = {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: value.id as string,
    name: (value.name as string).trim(),
    version: value.version as string,
    ...(typeof value.author === "string" && value.author.trim() ? { author: value.author.trim() } : {}),
    ...(typeof value.description === "string" && value.description.trim()
      ? { description: value.description.trim() }
      : {}),
    style: { radius },
    tokens: { light, dark }
  };
  return { ok: true, errors: [], pack };
}

/** 将十六进制颜色转换为主题使用的 HSL 通道。 */
export function hexToHslChannels(hex: string): string {
  const normalized = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    throw new Error("颜色必须是六位十六进制值");
  }
  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;

  return `${formatChannel(hue)} ${formatChannel(saturation * 100)}% ${formatChannel(lightness * 100)}%`;
}

/** 将主题 HSL 通道转换为颜色输入控件需要的十六进制值。 */
export function hslChannelsToHex(value: string): string {
  const channels = parseHslChannels(value);
  if (!channels) {
    return "#000000";
  }
  const [hue, saturationPercent, lightnessPercent] = channels;
  const saturation = saturationPercent / 100;
  const lightness = lightnessPercent / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const [redPart, greenPart, bluePart] = segment < 1 ? [chroma, x, 0]
    : segment < 2 ? [x, chroma, 0]
      : segment < 3 ? [0, chroma, x]
        : segment < 4 ? [0, x, chroma]
          : segment < 5 ? [x, 0, chroma]
            : [chroma, 0, x];
  const offset = lightness - chroma / 2;
  return `#${[redPart, greenPart, bluePart]
    .map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 为可编辑背景色选择对比度更高的前景色。 */
export function readableForegroundForHsl(value: string): string {
  const hex = hslChannelsToHex(value);
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const luminance = channels
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkContrast = (luminance + 0.05) / 0.065;
  return whiteContrast >= darkContrast ? "0 0% 100%" : "215 22% 15%";
}

function validateTokenSet(value: unknown, label: string, errors: string[]): ThemeTokens | undefined {
  if (!isRecord(value)) {
    errors.push(`${label}令牌必须是对象`);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!THEME_TOKEN_NAME_SET.has(key)) {
      errors.push(`${label}主题包含未知令牌：${key}`);
    }
  }
  const tokens = {} as ThemeTokens;
  for (const token of THEME_TOKEN_NAMES) {
    const tokenValue = value[token];
    if (typeof tokenValue !== "string" || !parseHslChannels(tokenValue)) {
      errors.push(`${label}主题令牌 ${token} 必须是合法 HSL 通道`);
      continue;
    }
    tokens[token] = tokenValue;
  }
  return errors.length > 0 ? undefined : tokens;
}

function parseHslChannels(value: string): [number, number, number] | undefined {
  const match = /^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const channels = match.slice(1).map(Number) as [number, number, number];
  return channels[0] <= 360 && channels[1] <= 100 && channels[2] <= 100 ? channels : undefined;
}

function isValidRadius(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  return Boolean(match && Number(match[1]) >= 0 && Number(match[1]) <= 12);
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatChannel(value: number): string {
  return Number(value.toFixed(1)).toString();
}
