export const THEME_SCHEMA_VERSION = 2 as const;
export const LEGACY_THEME_SCHEMA_VERSION = 1 as const;
export const DEFAULT_THEME_PACK_ID = "default";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedThemeMode = Exclude<ThemeMode, "system">;
export type ThemeBackgroundContentType = "image/jpeg" | "image/png" | "image/webp";

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

export interface ThemeBackgroundImageSettings {
  file: string;
  position: {
    x: number;
    y: number;
  };
  overlayOpacity: {
    light: number;
    dark: number;
  };
}

/** 提供给导入器和外部主题工具复用的 JSON Schema。 */
export const THEME_PACK_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ani-tracker.local/schemas/theme-pack-v2.json",
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
    },
    backgroundImage: {
      type: "object",
      additionalProperties: false,
      required: ["file", "position", "overlayOpacity"],
      properties: {
        file: { type: "string", pattern: "^background(?:-[a-z0-9]{8,32})?\\.(?:jpg|png|webp)$" },
        position: {
          type: "object",
          additionalProperties: false,
          required: ["x", "y"],
          properties: {
            x: { type: "number", minimum: 0, maximum: 100 },
            y: { type: "number", minimum: 0, maximum: 100 }
          }
        },
        overlayOpacity: {
          type: "object",
          additionalProperties: false,
          required: ["light", "dark"],
          properties: {
            light: { type: "number", minimum: 0.55, maximum: 0.98 },
            dark: { type: "number", minimum: 0.55, maximum: 0.98 }
          }
        }
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
  backgroundImage?: ThemeBackgroundImageSettings;
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
  background: "7 100% 98%",
  foreground: "4 23% 12%",
  card: "0 0% 100%",
  "card-foreground": "4 23% 12%",
  popover: "0 0% 100%",
  "popover-foreground": "4 23% 12%",
  primary: "3 61% 41%",
  "primary-foreground": "0 0% 100%",
  secondary: "240 6% 89%",
  "secondary-foreground": "210 3% 28%",
  muted: "7 56% 91%",
  "muted-foreground": "6 18% 29%",
  accent: "169 43% 90%",
  "accent-foreground": "173 100% 16%",
  destructive: "0 75% 42%",
  "destructive-foreground": "0 0% 100%",
  success: "173 100% 20%",
  "success-foreground": "0 0% 100%",
  warning: "38 88% 55%",
  "warning-foreground": "31 76% 10%",
  info: "194 100% 31%",
  "info-foreground": "0 0% 100%",
  border: "7 31% 81%",
  input: "7 13% 49%",
  ring: "3 61% 41%",
  "chart-1": "3 61% 41%",
  "chart-2": "173 100% 25%",
  "chart-3": "38 88% 45%",
  "chart-4": "194 100% 36%",
  "chart-5": "274 42% 48%",
  sidebar: "7 100% 97%",
  "sidebar-foreground": "4 23% 12%",
  "sidebar-primary": "3 61% 41%",
  "sidebar-primary-foreground": "0 0% 100%",
  "sidebar-accent": "7 100% 93%",
  "sidebar-accent-foreground": "3 61% 31%",
  "sidebar-border": "7 31% 81%",
  "sidebar-ring": "3 61% 41%"
};

const DEFAULT_DARK_TOKENS: ThemeTokens = {
  background: "6 23% 8%",
  foreground: "7 100% 95%",
  card: "4 23% 12%",
  "card-foreground": "7 100% 95%",
  popover: "7 18% 16%",
  "popover-foreground": "7 100% 95%",
  primary: "6 100% 84%",
  "primary-foreground": "357 100% 13%",
  secondary: "8 14% 23%",
  "secondary-foreground": "7 56% 91%",
  muted: "8 16% 20%",
  "muted-foreground": "7 20% 70%",
  accent: "171 70% 18%",
  "accent-foreground": "169 85% 74%",
  destructive: "0 85% 68%",
  "destructive-foreground": "0 60% 10%",
  success: "169 62% 62%",
  "success-foreground": "173 100% 9%",
  warning: "40 88% 65%",
  "warning-foreground": "31 76% 10%",
  info: "194 70% 65%",
  "info-foreground": "195 80% 10%",
  border: "7 20% 32%",
  input: "7 21% 45%",
  ring: "6 100% 84%",
  "chart-1": "6 100% 74%",
  "chart-2": "169 62% 62%",
  "chart-3": "40 88% 65%",
  "chart-4": "194 70% 65%",
  "chart-5": "274 58% 72%",
  sidebar: "5 24% 10%",
  "sidebar-foreground": "7 100% 95%",
  "sidebar-primary": "6 100% 84%",
  "sidebar-primary-foreground": "357 100% 13%",
  "sidebar-accent": "7 18% 18%",
  "sidebar-accent-foreground": "7 100% 95%",
  "sidebar-border": "7 20% 32%",
  "sidebar-ring": "6 100% 84%"
};

export const BUILT_IN_THEME_PACKS: readonly ThemePackManifest[] = [
  {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: DEFAULT_THEME_PACK_ID,
    name: "Anime Editorial",
    version: "1.0.0",
    author: "Ani Tracker",
    description: "纸白与暖黑表面搭配珊瑚红、青绿强调色。",
    style: { radius: "6px" },
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
const MANIFEST_KEYS = new Set([
  "schemaVersion",
  "id",
  "name",
  "version",
  "author",
  "description",
  "style",
  "tokens",
  "backgroundImage"
]);
const TEXT_CONTRAST_PAIRS = [
  ["background", "foreground"],
  ["card", "card-foreground"],
  ["popover", "popover-foreground"],
  ["primary", "primary-foreground"],
  ["secondary", "secondary-foreground"],
  ["muted", "muted-foreground"],
  ["accent", "accent-foreground"],
  ["destructive", "destructive-foreground"],
  ["success", "success-foreground"],
  ["warning", "warning-foreground"],
  ["info", "info-foreground"],
  ["sidebar", "sidebar-foreground"],
  ["sidebar-primary", "sidebar-primary-foreground"],
  ["sidebar-accent", "sidebar-accent-foreground"]
] as const satisfies ReadonlyArray<readonly [ThemeTokenName, ThemeTokenName]>;
const CONTROL_CONTRAST_PAIRS = [
  ["background", "input"],
  ["background", "ring"],
  ["card", "input"],
  ["card", "ring"]
] as const satisfies ReadonlyArray<readonly [ThemeTokenName, ThemeTokenName]>;
const MINIMUM_TEXT_CONTRAST = 4.5;
const MINIMUM_CONTROL_CONTRAST = 3;
const THEME_BACKGROUND_FILE_PATTERN = /^background(?:-[a-z0-9]{8,32})?\.(?:jpg|png|webp)$/;
const THEME_ARCHIVE_MANIFEST_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}\.ani-theme\.json$/;

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

/** 判断主题背景文件名是否可安全映射到应用私有目录。 */
export function isValidThemeBackgroundFileName(value: string): boolean {
  return THEME_BACKGROUND_FILE_PATTERN.test(value);
}

/** 根据图片文件头识别主题背景真实格式，不信任文件扩展名或 MIME 声明。 */
export function detectThemeBackgroundContentType(bytes: Uint8Array): ThemeBackgroundContentType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    .every((value, index) => bytes[index] === value)) {
    return "image/png";
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50) {
    return "image/webp";
  }
  return undefined;
}

/** 将主题背景真实内容类型映射为安全文件扩展名。 */
export function themeBackgroundExtension(contentType: ThemeBackgroundContentType): "jpg" | "png" | "webp" {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  return "webp";
}

/** 判断 ZIP 条目是否为根目录下允许的主题清单或背景图片。 */
export function isValidThemeArchiveEntryName(value: string): boolean {
  return !value.includes("/")
    && !value.includes("\\")
    && (THEME_ARCHIVE_MANIFEST_PATTERN.test(value) || isValidThemeBackgroundFileName(value));
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
  const legacySchema = value.schemaVersion === LEGACY_THEME_SCHEMA_VERSION;
  if (!legacySchema && value.schemaVersion !== THEME_SCHEMA_VERSION) {
    errors.push(`仅支持 schemaVersion ${LEGACY_THEME_SCHEMA_VERSION} 或 ${THEME_SCHEMA_VERSION}`);
  }
  if (legacySchema && value.backgroundImage !== undefined) {
    errors.push("schemaVersion 1 不支持背景图片配置");
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
  if (light) {
    validateTokenContrast(light, "浅色", errors);
  }
  if (dark) {
    validateTokenContrast(dark, "深色", errors);
  }

  const backgroundImage = value.backgroundImage === undefined
    ? undefined
    : validateBackgroundImageSettings(value.backgroundImage, errors);

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
    tokens: { light, dark },
    ...(backgroundImage ? { backgroundImage } : {})
  };
  return { ok: true, errors: [], pack };
}

/** 校验主题包中的可选背景图片描述，图片二进制由主题包单独携带。 */
function validateBackgroundImageSettings(
  value: unknown,
  errors: string[]
): ThemeBackgroundImageSettings | undefined {
  const initialErrorCount = errors.length;
  if (!isRecord(value)) {
    errors.push("背景图片配置必须是对象");
    return undefined;
  }
  rejectUnknownKeys(value, new Set(["file", "position", "overlayOpacity"]), "背景图片", errors);
  const file = typeof value.file === "string" ? value.file : "";
  if (!isValidThemeBackgroundFileName(file)) {
    errors.push("背景图片文件名必须是安全的 background 图片文件名");
  }

  const position = readNumberPair(value.position, "背景焦点", 0, 100, errors, "x", "y");
  const overlayOpacity = readNumberPair(
    value.overlayOpacity,
    "背景遮罩",
    0.55,
    0.98,
    errors,
    "light",
    "dark"
  );
  if (errors.length > initialErrorCount || !position || !overlayOpacity) {
    return undefined;
  }
  return {
    file,
    position: { x: position[0], y: position[1] },
    overlayOpacity: { light: overlayOpacity[0], dark: overlayOpacity[1] }
  };
}

/** 读取只允许两个数值字段的受限配置对象。 */
function readNumberPair(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  errors: string[],
  firstKey: string,
  secondKey: string
): [number, number] | undefined {
  if (!isRecord(value)) {
    errors.push(`${label}配置必须是对象`);
    return undefined;
  }
  rejectUnknownKeys(value, new Set([firstKey, secondKey]), label, errors);
  const first = value[firstKey];
  const second = value[secondKey];
  if (!isNumberInRange(first, minimum, maximum) || !isNumberInRange(second, minimum, maximum)) {
    errors.push(`${label}数值必须在 ${minimum}-${maximum} 范围内`);
    return undefined;
  }
  return [first, second];
}

/** 拒绝声明式主题配置中的未知字段。 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  errors: string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}包含未知字段：${key}`);
  }
}

function isNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
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
  const white = "0 0% 100%";
  const dark = "215 22% 15%";
  const whiteContrast = contrastRatio(value, white);
  const darkContrast = contrastRatio(value, dark);
  if (Math.max(whiteContrast, darkContrast) >= MINIMUM_TEXT_CONTRAST) {
    return whiteContrast >= darkContrast ? white : dark;
  }

  // 中间亮度可能与带色深前景都不足 4.5:1，使用纯黑保证可读性。
  return "0 0% 0%";
}

function validateTokenSet(value: unknown, label: string, errors: string[]): ThemeTokens | undefined {
  const initialErrorCount = errors.length;
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
  return errors.length > initialErrorCount ? undefined : tokens;
}

/** 校验主题文字、输入边界和焦点环均满足 WCAG 对比度要求。 */
function validateTokenContrast(tokens: ThemeTokens, label: string, errors: string[]): void {
  for (const [background, foreground] of TEXT_CONTRAST_PAIRS) {
    const ratio = contrastRatio(tokens[background], tokens[foreground]);
    if (ratio < MINIMUM_TEXT_CONTRAST) {
      errors.push(
        `${label}主题 ${foreground} 与 ${background} 的文字对比度仅 ${ratio.toFixed(2)}:1，至少需要 ${MINIMUM_TEXT_CONTRAST}:1`
      );
    }
  }
  for (const [surface, control] of CONTROL_CONTRAST_PAIRS) {
    const ratio = contrastRatio(tokens[surface], tokens[control]);
    if (ratio < MINIMUM_CONTROL_CONTRAST) {
      errors.push(
        `${label}主题 ${control} 与 ${surface} 的控件对比度仅 ${ratio.toFixed(2)}:1，至少需要 ${MINIMUM_CONTROL_CONTRAST}:1`
      );
    }
  }
}

/** 计算两个 HSL 主题颜色间的 WCAG 对比度。 */
function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

/** 将 HSL 主题颜色转换为 WCAG 相对亮度。 */
function relativeLuminance(value: string): number {
  const [hue, saturationPercent, lightnessPercent] = parseHslChannels(value) ?? [0, 0, 0];
  const saturation = saturationPercent / 100;
  const lightness = lightnessPercent / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const offset = lightness - chroma / 2;
  const rgb = hue < 60 ? [chroma, secondary, 0]
    : hue < 120 ? [secondary, chroma, 0]
      : hue < 180 ? [0, chroma, secondary]
        : hue < 240 ? [0, secondary, chroma]
          : hue < 300 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  return rgb
    .map((channel) => channel + offset)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
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
