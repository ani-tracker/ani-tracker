#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const RETIRED_DEPENDENCIES = new Set([
  "@capacitor-community/sqlite",
  "@capacitor/android",
  "@capacitor/cli",
  "@capacitor/core",
  "@electron/rebuild",
  "@types/better-sqlite3",
  "@types/node-forge",
  "better-sqlite3",
  "electron",
  "electron-builder",
  "electron-vite",
  "electron-vlc-player",
  "node-forge"
]);
const RETIRED_SCRIPT_PATTERN = /\b(?:capacitor|electron(?:-builder|-vite)?)\b/i;
const REQUIRED_TAURI_SCRIPTS = new Map([
  ["dev", "pnpm run dev:tauri"],
  ["build", "pnpm run build:tauri"],
  ["package:desktop", "pnpm run package:tauri:desktop"]
]);
const FALLBACK_TAG = "legacy-hosts-final";
const FALLBACK_COMMIT = "6caf060f7247576f0f2f49d6ba9892e1149ed236";
const RETIRED_SOURCE_PATTERNS = [
  { name: "Capacitor 包", pattern: /@capacitor(?:-community)?\// },
  { name: "Capacitor 全局桥", pattern: /\bCapacitor\.(?:getPlatform|isNativePlatform|registerPlugin)\b/ },
  { name: "Electron import", pattern: /\bfrom\s+["']electron(?:\/|["'])|\brequire\(\s*["']electron(?:\/|["'])/ },
  { name: "Electron Renderer bridge", pattern: /\bwindow\.(?:aniBridge|electronAPI)\b/ },
  { name: "Electron 构建依赖", pattern: /\belectron-(?:builder|vite|vlc-player)\b/ },
  { name: "旧 SQLite 原生依赖", pattern: /\bbetter-sqlite3\b/ },
  { name: "旧证书依赖", pattern: /\bnode-forge\b/ }
];
const ACTIVE_SOURCE_ROOTS = ["src", "src-tauri", "crates", "native", "scripts"];
const BOUNDARY_VERIFIER_PATHS = new Set([
  "scripts/verify-retired-host-boundaries.mjs",
  "scripts/verify-retired-host-boundaries.test.mjs"
]);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".h", ".hpp", ".js", ".json", ".jsx", ".kt", ".kts",
  ".mjs", ".rs", ".swift", ".toml", ".ts", ".tsx", ".xml"
]);
const REQUIRED_ARCHIVE_PATHS = [
  "archive/legacy-hosts/README.md",
  "archive/legacy-hosts/legacy-dependencies.json",
  "archive/legacy-hosts/electron/electron.vite.config.ts",
  "archive/legacy-hosts/electron/src/main",
  "archive/legacy-hosts/capacitor/capacitor.config.ts",
  "archive/legacy-hosts/capacitor/android",
  "archive/legacy-hosts/capacitor/ios"
];
const FORBIDDEN_ACTIVE_PATHS = [
  "android",
  "ios",
  "src/main",
  "src/preload",
  "capacitor.config.ts",
  "electron-builder.config.cjs",
  "electron.vite.config.ts",
  "vite.mobile.config.ts"
];

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

/** 验证旧宿主只存在归档中，且不会重新进入当前依赖、脚本或活跃源码。 */
async function main() {
  const root = process.cwd();
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const violations = collectPackageViolations(packageJson);
  const archiveManifest = JSON.parse(await readFile(
    join(root, "archive/legacy-hosts/legacy-dependencies.json"),
    "utf8"
  ));
  violations.push(...collectArchiveManifestViolations(archiveManifest));

  for (const path of REQUIRED_ARCHIVE_PATHS) {
    if (!(await pathExists(join(root, path)))) violations.push(`归档缺少：${path}`);
  }
  for (const path of FORBIDDEN_ACTIVE_PATHS) {
    if (await pathExists(join(root, path))) violations.push(`旧宿主仍在活跃路径：${path}`);
  }
  for (const sourceRoot of ACTIVE_SOURCE_ROOTS) {
    const absoluteRoot = join(root, sourceRoot);
    for (const file of await collectTextFiles(absoluteRoot)) {
      const projectPath = relative(root, file).replaceAll("\\", "/");
      if (!shouldInspectActiveSource(projectPath)) continue;
      const content = await readFile(file, "utf8");
      violations.push(...collectSourceViolations(projectPath, content));
    }
  }

  if (violations.length > 0) {
    throw new Error(`[retired-host-boundary] 旧宿主边界校验失败：\n- ${violations.join("\n- ")}`);
  }
  console.log("[retired-host-boundary] Electron/Capacitor 仅保留在归档目录");
}

/** 返回根依赖和脚本中重新接入旧宿主的违规项。 */
export function collectPackageViolations(packageJson) {
  const violations = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(packageJson[field] ?? {})) {
      if (RETIRED_DEPENDENCIES.has(name)) violations.push(`${field} 重新引入 ${name}`);
    }
  }
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    if (RETIRED_SCRIPT_PATTERN.test(String(command))) violations.push(`脚本 ${name} 重新调用旧宿主`);
  }
  for (const [name, command] of REQUIRED_TAURI_SCRIPTS) {
    if (packageJson.scripts?.[name] !== command) {
      violations.push(`默认脚本 ${name} 未固定到 Tauri`);
    }
  }
  return violations;
}

/** 返回旧宿主归档清单中回退标签或提交不一致的违规项。 */
export function collectArchiveManifestViolations(manifest) {
  const violations = [];
  if (manifest?.fallbackTag !== FALLBACK_TAG) {
    violations.push(`归档回退标签必须为 ${FALLBACK_TAG}`);
  }
  if (manifest?.fallbackCommit !== FALLBACK_COMMIT) {
    violations.push(`归档回退提交必须为 ${FALLBACK_COMMIT}`);
  }
  return violations;
}

/** 返回单个活跃源码文件中的旧宿主 API 或原生依赖引用。 */
export function collectSourceViolations(path, content) {
  return RETIRED_SOURCE_PATTERNS
    .filter(({ pattern }) => pattern.test(content))
    .map(({ name }) => `${path.replaceAll("\\", "/")} 引用了${name}`);
}

/** 仅跳过包含旧宿主检测样例的门禁实现与测试自身。 */
export function shouldInspectActiveSource(path) {
  return !BOUNDARY_VERIFIER_PATHS.has(path.replaceAll("\\", "/"));
}

/** 递归收集需要检查的活跃源码文本。 */
async function collectTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTextFiles(path);
    return entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) ? [path] : [];
  }));
  return nested.flat();
}

/** 判断文件或目录是否存在。 */
async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
