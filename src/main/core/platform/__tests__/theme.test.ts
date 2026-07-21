import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BUILT_IN_THEME_PACKS,
  THEME_PACK_JSON_SCHEMA,
  createDefaultAppearanceSettings,
  hexToHslChannels,
  hslChannelsToHex,
  normalizeAppearanceSettings,
  readableForegroundForHsl,
  validateThemePack,
  type ResolvedThemeMode,
  type ThemeTokenName,
  type ThemePackManifest
} from "@shared/theme";

const TEXT_CONTRAST_PAIRS: ReadonlyArray<readonly [ThemeTokenName, ThemeTokenName]> = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "muted"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["success-foreground", "success"],
  ["warning-foreground", "warning"],
  ["info-foreground", "info"],
  ["sidebar-foreground", "sidebar"],
  ["sidebar-primary-foreground", "sidebar-primary"],
  ["sidebar-accent-foreground", "sidebar-accent"]
];

test("内置主题包均满足完整 schema", () => {
  assert.equal(THEME_PACK_JSON_SCHEMA.$defs.themeTokens.required.length, 38);
  for (const pack of BUILT_IN_THEME_PACKS) {
    const result = validateThemePack(pack);
    assert.equal(result.ok, true, `${pack.id}: ${result.errors.join("；")}`);
  }
});

test("图片取色主题规范示例可直接导入", () => {
  const example = JSON.parse(readFileSync("docs/自定义主题提示词/image-palette-example.ani-theme.json", "utf8")) as unknown;
  const result = validateThemePack(example);
  assert.equal(result.ok, true, result.errors.join("；"));
});

test("主题包导出 JSON 可无损重新导入", () => {
  const example = JSON.parse(readFileSync("docs/自定义主题提示词/image-palette-example.ani-theme.json", "utf8")) as unknown;
  const imported = validateThemePack(example);
  assert.ok(imported.pack);

  const exportedJson = `${JSON.stringify(imported.pack, null, 2)}\n`;
  const roundTrip = validateThemePack(JSON.parse(exportedJson));

  assert.equal(Buffer.byteLength(exportedJson, "utf8") < 128 * 1024, true);
  assert.equal(roundTrip.ok, true, roundTrip.errors.join("；"));
  assert.deepEqual(roundTrip.pack, imported.pack);
});

test("内置主题包满足 WCAG AA 文字与焦点可见性对比度", () => {
  for (const pack of BUILT_IN_THEME_PACKS) {
    for (const mode of ["light", "dark"] as const satisfies readonly ResolvedThemeMode[]) {
      const tokens = pack.tokens[mode];
      for (const [foreground, background] of TEXT_CONTRAST_PAIRS) {
        const ratio = contrastRatio(tokens[foreground], tokens[background]);
        assert.ok(
          ratio >= 4.5,
          `${pack.id}/${mode} 的 ${foreground} 与 ${background} 对比度仅 ${ratio.toFixed(2)}:1`
        );
      }

      const focusRatio = contrastRatio(tokens.ring, tokens.background);
      assert.ok(
        focusRatio >= 3,
        `${pack.id}/${mode} 的焦点环与页面背景对比度仅 ${focusRatio.toFixed(2)}:1`
      );
    }
  }
});

test("主题校验拒绝未知令牌和不安全字段", () => {
  const candidate = clonePack(BUILT_IN_THEME_PACKS[0]) as ThemePackManifest & {
    css?: string;
    tokens: ThemePackManifest["tokens"] & { light: ThemePackManifest["tokens"]["light"] & { injected?: string } };
  };
  candidate.id = "custom-invalid";
  candidate.css = "body { display: none }";
  (candidate.style as { radius: string; shadow?: string }).shadow = "url(https://example.test)";
  candidate.tokens.light.injected = "0 0% 0%";

  const result = validateThemePack(candidate);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("不支持的主题包字段")));
  assert.ok(result.errors.some((error) => error.includes("不支持的主题样式字段")));
  assert.ok(result.errors.some((error) => error.includes("未知令牌")));
});

test("主题校验拒绝文字和控件对比度不足的用户主题", () => {
  const candidate = clonePack(BUILT_IN_THEME_PACKS[0]);
  candidate.id = "custom-low-contrast";
  candidate.tokens.dark["muted-foreground"] = candidate.tokens.dark.muted;
  candidate.tokens.light.ring = candidate.tokens.light.background;

  const result = validateThemePack(candidate);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("深色主题 muted-foreground") && error.includes("4.5:1")));
  assert.ok(result.errors.some((error) => error.includes("浅色主题 ring") && error.includes("3:1")));
});

test("外观设置保留有效用户主题并回退未知主题 ID", () => {
  const custom = clonePack(BUILT_IN_THEME_PACKS[1]);
  custom.id = "custom-coral";
  custom.name = "自定义珊瑚";
  const valid = normalizeAppearanceSettings({
    themeMode: "dark",
    themePackId: custom.id,
    customThemePacks: [custom]
  });
  const fallback = normalizeAppearanceSettings({
    themeMode: "invalid",
    themePackId: "missing",
    customThemePacks: [{ id: "broken" }]
  });

  assert.equal(valid.themeMode, "dark");
  assert.equal(valid.themePackId, custom.id);
  assert.equal(valid.customThemePacks.length, 1);
  assert.deepEqual(fallback, createDefaultAppearanceSettings());
});

test("主题颜色可在十六进制与 HSL 通道间稳定转换", () => {
  const hsl = hexToHslChannels("#14816f");
  assert.equal(hslChannelsToHex(hsl), "#14816f");
});

test("自动前景色在中间亮度背景上仍满足文字对比度", () => {
  const background = "0 0% 50%";
  const foreground = readableForegroundForHsl(background);
  assert.ok(contrastRatio(foreground, background) >= 4.5);
});

function clonePack(pack: ThemePackManifest): ThemePackManifest {
  return JSON.parse(JSON.stringify(pack)) as ThemePackManifest;
}

/** 计算两种 HSL 主题色的 WCAG 对比度。 */
function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 将 HSL 主题通道换算为相对亮度。 */
function relativeLuminance(value: string): number {
  return hslToRgb(value)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

/** 将主题 HSL 通道转换为 0-1 范围的 RGB 通道。 */
function hslToRgb(value: string): [number, number, number] {
  const [hue, saturation, lightness] = value.match(/[\d.]+/g)!.map(Number);
  const chroma = saturation * Math.min(lightness, 100 - lightness) / 100;
  const channel = (offset: number) => {
    const segment = (offset + hue / 30) % 12;
    return (lightness - chroma * Math.max(-1, Math.min(segment - 3, 9 - segment, 1))) / 100;
  };
  return [channel(0), channel(8), channel(4)];
}
