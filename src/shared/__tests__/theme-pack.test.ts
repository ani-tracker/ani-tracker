import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BUILT_IN_THEME_PACKS,
  THEME_PACK_JSON_SCHEMA,
  detectThemeBackgroundContentType,
  isValidThemeArchiveEntryName,
  themeBackgroundExtension,
  validateThemePack
} from "../theme";

function cloneDefaultTheme(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(BUILT_IN_THEME_PACKS[0])) as Record<string, unknown>;
}

test("v1 纯色主题导入后规范化为 v2", () => {
  const candidate = cloneDefaultTheme();
  candidate.schemaVersion = 1;
  candidate.id = "legacy-theme";

  const result = validateThemePack(candidate);

  assert.equal(result.ok, true);
  assert.equal(result.pack?.schemaVersion, 2);
  assert.equal(result.pack?.backgroundImage, undefined);
});

test("v2 主题接受受限背景配置", () => {
  const candidate = cloneDefaultTheme();
  candidate.id = "image-theme";
  candidate.backgroundImage = {
    file: "background-a1b2c3d4.webp",
    position: { x: 35, y: 60 },
    overlayOpacity: { light: 0.82, dark: 0.88 }
  };

  const result = validateThemePack(candidate);

  assert.equal(result.ok, true);
  assert.deepEqual(result.pack?.backgroundImage, candidate.backgroundImage);
  assert.equal(THEME_PACK_JSON_SCHEMA.$id.endsWith("theme-pack-v2.json"), true);
});

test("v1 主题拒绝背景字段，v2 拒绝越界遮罩", () => {
  const legacy = cloneDefaultTheme();
  legacy.schemaVersion = 1;
  legacy.id = "legacy-image-theme";
  legacy.backgroundImage = {
    file: "background-a1b2c3d4.webp",
    position: { x: 50, y: 50 },
    overlayOpacity: { light: 0.8, dark: 0.8 }
  };
  assert.equal(validateThemePack(legacy).ok, false);

  const invalid = cloneDefaultTheme();
  invalid.id = "invalid-image-theme";
  invalid.backgroundImage = {
    file: "background-a1b2c3d4.webp",
    position: { x: 50, y: 50 },
    overlayOpacity: { light: 0.2, dark: 0.8 }
  };
  assert.equal(validateThemePack(invalid).ok, false);
});

test("主题 ZIP 条目只允许根目录清单和受限图片名", () => {
  assert.equal(isValidThemeArchiveEntryName("image-theme.ani-theme.json"), true);
  assert.equal(isValidThemeArchiveEntryName("background-a1b2c3d4.webp"), true);
  assert.equal(isValidThemeArchiveEntryName("../background-a1b2c3d4.webp"), false);
  assert.equal(isValidThemeArchiveEntryName("nested/image-theme.ani-theme.json"), false);
  assert.equal(isValidThemeArchiveEntryName("background.svg"), false);
});

test("主题背景按文件头识别 JPEG、PNG 与 WebP", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

  assert.equal(detectThemeBackgroundContentType(jpeg), "image/jpeg");
  assert.equal(detectThemeBackgroundContentType(png), "image/png");
  assert.equal(detectThemeBackgroundContentType(webp), "image/webp");
  assert.equal(detectThemeBackgroundContentType(new Uint8Array([1, 2, 3])), undefined);
  assert.equal(themeBackgroundExtension("image/jpeg"), "jpg");
  assert.equal(themeBackgroundExtension("image/png"), "png");
  assert.equal(themeBackgroundExtension("image/webp"), "webp");
});
