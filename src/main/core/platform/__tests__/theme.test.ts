import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BUILT_IN_THEME_PACKS,
  THEME_PACK_JSON_SCHEMA,
  createDefaultAppearanceSettings,
  hexToHslChannels,
  hslChannelsToHex,
  normalizeAppearanceSettings,
  validateThemePack,
  type ThemePackManifest
} from "@shared/theme";

test("内置主题包均满足完整 schema", () => {
  assert.equal(THEME_PACK_JSON_SCHEMA.$defs.themeTokens.required.length, 38);
  for (const pack of BUILT_IN_THEME_PACKS) {
    const result = validateThemePack(pack);
    assert.equal(result.ok, true, `${pack.id}: ${result.errors.join("；")}`);
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

function clonePack(pack: ThemePackManifest): ThemePackManifest {
  return JSON.parse(JSON.stringify(pack)) as ThemePackManifest;
}
