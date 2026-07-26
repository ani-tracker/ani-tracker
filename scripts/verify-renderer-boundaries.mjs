#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const rendererRoots = {
  local: resolve("out/tauri"),
  remote: resolve(".tauri-remote-pwa")
};

await main(process.argv.slice(2));

/** 校验 Renderer 构建阶段生成的模块边界证明。 */
async function main(args) {
  const requested = parseRenderer(args);
  const renderers = requested === "all" ? ["local", "remote"] : [requested];
  for (const renderer of renderers) {
    const manifestPath = resolve(rendererRoots[renderer], "ani-renderer-boundary.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.renderer !== renderer) {
      throw new Error(`[renderer-boundary] 边界证明无效：${manifestPath}`);
    }
    if (!Number.isSafeInteger(manifest.verifiedModuleCount) || manifest.verifiedModuleCount <= 0) {
      throw new Error(`[renderer-boundary] 未记录有效模块数量：${manifestPath}`);
    }
    console.log(`[renderer-boundary] ${renderer} Renderer 模块边界通过：${manifest.verifiedModuleCount} 个模块`);
  }
}

/** 解析需要校验的 Renderer 种类。 */
function parseRenderer(args) {
  let renderer = "all";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--renderer") {
      renderer = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!new Set(["local", "remote", "all"]).has(renderer)) {
    throw new Error("--renderer 必须为 local、remote 或 all");
  }
  return renderer;
}
