import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPackageViolations,
  collectSourceViolations,
  shouldInspectActiveSource
} from "./verify-retired-host-boundaries.mjs";

test("接受只包含 Tauri 的依赖和脚本", () => {
  assert.deepEqual(collectPackageViolations({
    dependencies: { "@tauri-apps/api": "2.11.1" },
    devDependencies: { vite: "5.4.8" },
    scripts: { dev: "pnpm run dev:tauri" }
  }), []);
});

test("拒绝旧宿主依赖和默认脚本回流", () => {
  const violations = collectPackageViolations({
    dependencies: { "@capacitor/core": "7.6.8", "better-sqlite3": "11.10.0" },
    devDependencies: { electron: "32.1.2" },
    scripts: { dev: "electron-vite dev" }
  });
  assert.equal(violations.length, 4);
  assert.match(violations.join("\n"), /@capacitor\/core/);
  assert.match(violations.join("\n"), /electron/);
});

test("拒绝活跃 Renderer 重新调用 Electron 或 Capacitor bridge", () => {
  const electron = collectSourceViolations("src/renderer/electron.ts", "window.aniBridge.invoke('list')");
  const capacitor = collectSourceViolations("src/mobile.ts", "import { Capacitor } from '@capacitor/core'");
  assert.match(electron.join("\n"), /Electron Renderer bridge/);
  assert.match(capacitor.join("\n"), /Capacitor 包/);
});

test("允许旧数据库迁移说明继续提及 Electron", () => {
  assert.deepEqual(
    collectSourceViolations("src-tauri/storage.rs", "// 只复制旧 Electron 数据库，不删除原文件"),
    []
  );
});

test("只排除门禁自身并继续检查其他脚本", () => {
  assert.equal(shouldInspectActiveSource("scripts/verify-retired-host-boundaries.mjs"), false);
  assert.equal(shouldInspectActiveSource("scripts/verify-retired-host-boundaries.test.mjs"), false);
  assert.equal(shouldInspectActiveSource("scripts/build-electron.mjs"), true);
});
