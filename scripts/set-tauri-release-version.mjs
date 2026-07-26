#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const input = process.argv.slice(2).find((value) => value !== "--") ?? "";
const version = input.replace(/^v/, "");
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`[release] 版本号无效：${input || "<empty>"}`);
}

await updateJson("package.json", (value) => ({ ...value, version }));
await updateJson("src-tauri/tauri.conf.json", (value) => ({ ...value, version }));
console.log(`[release] Tauri 发布版本已设置：${version}`);

/** 读取、更新并以稳定两空格缩进写回 JSON。 */
async function updateJson(path, transform) {
  const value = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify(transform(value), null, 2)}\n`, "utf8");
}
