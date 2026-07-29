#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = resolve(repoRoot, "src-tauri/tauri.ios.conf.json");
const projectSpecPath = resolve(repoRoot, "src-tauri/gen/apple/project.yml");
const xcodeProjectPath = resolve(
  repoRoot,
  "src-tauri/gen/apple/ani-tracker-tauri.xcodeproj/project.pbxproj"
);
const checkOnly = process.argv.includes("--check");

const config = JSON.parse(await readFile(configPath, "utf8"));
const deploymentTarget = config.bundle?.iOS?.minimumSystemVersion;
if (typeof deploymentTarget !== "string" || !/^\d+\.\d+$/.test(deploymentTarget)) {
  throw new Error("[ios-target] tauri.ios.conf.json 缺少有效的 iOS 最低系统版本");
}

await syncTarget(
  projectSpecPath,
  /^(\s*iOS:\s*)\d+(?:\.\d+)*\s*$/m,
  (prefix) => `${prefix}${deploymentTarget}`,
  "XcodeGen 工程描述"
);
await syncTarget(
  xcodeProjectPath,
  /(IPHONEOS_DEPLOYMENT_TARGET = )\d+(?:\.\d+)*;/g,
  (prefix) => `${prefix}${deploymentTarget};`,
  "Xcode 工程"
);

console.log(`[ios-target] iOS 最低系统版本已同步：${deploymentTarget}`);

/** 同步生成工程中的最低系统版本，并支持 CI 只读校验。 */
async function syncTarget(path, pattern, replacement, label) {
  const source = await readFile(path, "utf8");
  let replacementCount = 0;
  const updated = source.replace(pattern, (_match, prefix) => {
    replacementCount += 1;
    return replacement(prefix);
  });
  if (replacementCount === 0) {
    throw new Error(`[ios-target] ${label}缺少最低系统版本字段：${path}`);
  }
  if (updated === source) return;
  if (checkOnly) {
    throw new Error(`[ios-target] ${label}尚未同步到 ${deploymentTarget}：${path}`);
  }
  await writeFile(path, updated, "utf8");
}
