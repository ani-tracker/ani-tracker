import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const TOKEN_COUNT = 38;
const projectRoot = resolve(import.meta.dirname, "..");
const themeSource = await readFile(resolve(projectRoot, "src/shared/theme.ts"), "utf8");
const globalCss = await readFile(resolve(projectRoot, "src/renderer/src/styles/globals.css"), "utf8");

/** 从主题源码常量中提取完整令牌集合。 */
function readSourceTokens(startMarker, endMarker) {
  const block = themeSource.slice(themeSource.indexOf(startMarker), themeSource.indexOf(endMarker));
  return Object.fromEntries(
    [...block.matchAll(/^\s{2}(?:"([a-z0-9-]+)"|([a-z][a-z0-9-]*)):\s*"([^"]+)"/gm)]
      .map((match) => [match[1] || match[2], match[3]])
  );
}

/** 从根 CSS 的指定模式中提取回退变量。 */
function readCssTokens(startMarker, endMarker) {
  const start = globalCss.indexOf(startMarker);
  const block = globalCss.slice(start, globalCss.indexOf(endMarker, start));
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)]
      .map((match) => [match[1], match[2].trim()])
  );
}

/** 将 HSL 通道转换为用于亮度计算的 sRGB。 */
function hslToRgb(value) {
  const channels = value.match(/[\d.]+/g)?.map(Number);
  if (!channels || channels.length !== 3) {
    throw new Error(`无效 HSL 通道：${value}`);
  }
  const [hue, saturationPercent, lightnessPercent] = channels;
  const saturation = saturationPercent / 100;
  const lightness = lightnessPercent / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const offset = lightness - chroma / 2;
  const parts = hue < 60 ? [chroma, secondary, 0]
    : hue < 120 ? [secondary, chroma, 0]
      : hue < 180 ? [0, chroma, secondary]
        : hue < 240 ? [0, secondary, chroma]
          : hue < 300 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  return parts.map((channel) => channel + offset);
}

/** 计算符合 WCAG 定义的相对亮度。 */
function relativeLuminance(value) {
  return hslToRgb(value)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

/** 返回两个 HSL 颜色间的 WCAG 对比度。 */
function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

/** 校验失败时抛出包含具体令牌的错误。 */
function assertContrast(mode, tokens, background, foreground, minimum) {
  const ratio = contrastRatio(tokens[background], tokens[foreground]);
  if (ratio < minimum) {
    throw new Error(`${mode} ${background}/${foreground} 对比度 ${ratio.toFixed(2)}，要求 ${minimum}`);
  }
}

const modes = [
  {
    name: "浅色",
    tokens: readSourceTokens("const DEFAULT_LIGHT_TOKENS", "const DEFAULT_DARK_TOKENS"),
    fallbacks: readCssTokens(":root {", ".dark {")
  },
  {
    name: "深色",
    tokens: readSourceTokens("const DEFAULT_DARK_TOKENS", "export const BUILT_IN_THEME_PACKS"),
    fallbacks: readCssTokens(".dark {", "html {")
  }
];

const textPairs = [
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
];

for (const mode of modes) {
  const entries = Object.entries(mode.tokens);
  if (entries.length !== TOKEN_COUNT) {
    throw new Error(`${mode.name}主题应包含 ${TOKEN_COUNT} 个令牌，实际为 ${entries.length}`);
  }
  for (const [token, value] of entries) {
    if (mode.fallbacks[token] !== value) {
      throw new Error(`${mode.name}主题 ${token} 与 globals.css 回退值不一致`);
    }
  }
  for (const [background, foreground] of textPairs) {
    assertContrast(mode.name, mode.tokens, background, foreground, 4.5);
  }
  assertContrast(mode.name, mode.tokens, "background", "input", 3);
  assertContrast(mode.name, mode.tokens, "background", "ring", 3);
  assertContrast(mode.name, mode.tokens, "card", "input", 3);
  assertContrast(mode.name, mode.tokens, "card", "ring", 3);
  console.log(`[theme] ${mode.name}：${TOKEN_COUNT} 个令牌、文本与控件对比度通过`);
}
