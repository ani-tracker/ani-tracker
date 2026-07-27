import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { syncMobileBrandAssets } from "./sync-tauri-mobile-brand-assets.mjs";

const projectRoot = resolve(".");

test("iOS 生成工程强制同步正式 AppIcon", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ani-mobile-brand-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const filename = "AppIcon-20x20@1x.png";
  const source = resolve(projectRoot, "src-tauri/icons/ios", filename);
  const sourceTarget = resolve(temporaryRoot, "src-tauri/icons/ios", filename);
  const generatedRoot = resolve(
    temporaryRoot,
    "src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"
  );
  await mkdir(dirname(sourceTarget), { recursive: true });
  await mkdir(generatedRoot, { recursive: true });
  await copyFile(source, sourceTarget);
  await writeFile(resolve(generatedRoot, filename), "legacy-logo");
  await writeFile(resolve(generatedRoot, "Contents.json"), JSON.stringify({
    images: [{ size: "20x20", scale: "1x", idiom: "ipad", filename }],
    info: { version: 1, author: "xcode" }
  }));

  assert.equal(await syncMobileBrandAssets({ platform: "ios", projectRoot: temporaryRoot }), 1);
  assert.deepEqual(await readFile(resolve(generatedRoot, filename)), await readFile(source));
  await assert.doesNotReject(() => syncMobileBrandAssets({
    platform: "ios",
    projectRoot: temporaryRoot,
    check: true
  }));
});

test("Android 生成工程 launcher 资源与正式图标一致", async () => {
  await assert.doesNotReject(() => syncMobileBrandAssets({
    platform: "android",
    projectRoot,
    check: true
  }));
});

test("移动品牌校验拒绝被旧内容覆盖的图标", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ani-mobile-brand-check-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const filename = "AppIcon-20x20@1x.png";
  const source = resolve(projectRoot, "src-tauri/icons/ios", filename);
  const sourceTarget = resolve(temporaryRoot, "src-tauri/icons/ios", filename);
  const generatedRoot = resolve(
    temporaryRoot,
    "src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"
  );
  await mkdir(dirname(sourceTarget), { recursive: true });
  await mkdir(generatedRoot, { recursive: true });
  await copyFile(source, sourceTarget);
  await copyFile(source, resolve(generatedRoot, filename));
  await writeFile(resolve(generatedRoot, "Contents.json"), JSON.stringify({
    images: [{ size: "20x20", scale: "1x", idiom: "ipad", filename }],
    info: { version: 1, author: "xcode" }
  }));
  await writeFile(resolve(generatedRoot, filename), "legacy-logo");

  await assert.rejects(
    () => syncMobileBrandAssets({ platform: "ios", projectRoot: temporaryRoot, check: true }),
    /非项目资产/
  );
});

test("Android 生成布局不再携带模板文案", async () => {
  const layout = await readFile(
    resolve(projectRoot, "src-tauri/gen/android/app/src/main/res/layout/activity_main.xml"),
    "utf8"
  );
  assert.doesNotMatch(layout, /Hello World|Customize your theme/i);
});

test("移动初始化、打包和最终包校验均接入品牌门禁", async () => {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  for (const script of [
    "init:tauri:ios",
    "package:tauri:ios",
    "package:tauri:android",
    "package:tauri:android:debug",
    "verify:tauri:ios-package",
    "verify:tauri:android-package"
  ]) {
    assert.match(packageJson.scripts[script], /sync:tauri:mobile-brand/, `${script} 缺少品牌同步或校验`);
  }
  assert.match(packageJson.scripts["verify:tauri:ios-package"], /--check/);
  assert.match(packageJson.scripts["verify:tauri:android-package"], /--check/);
});
