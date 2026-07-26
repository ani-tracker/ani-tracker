#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import process from "node:process";

const options = parseArgs(process.argv.slice(2));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const files = (await collectFiles(options.root))
  .filter((path) => resolve(path) !== options.output)
  .sort();
if (files.length === 0) throw new Error(`[release] 产物目录为空：${options.root}`);

const artifacts = [];
for (const path of files) {
  const metadata = await stat(path);
  const sha256 = await hashFile(path);
  const name = relative(options.root, path).replaceAll("\\", "/");
  artifacts.push({ name, size: metadata.size, sha256 });
  await writeFile(`${path}.sha256`, `${sha256}  ${basename(path)}\n`, "utf8");
}

await mkdir(dirname(options.output), { recursive: true });
await writeFile(options.output, `${JSON.stringify({
  schemaVersion: 1,
  product: "Ani Tracker",
  version: packageJson.version,
  target: options.target,
  artifacts
}, null, 2)}\n`, "utf8");
console.log(`[release] 已生成 ${options.target} 产物清单：${artifacts.length} 个文件`);

/** 递归收集目录中的普通文件。 */
async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return collectFiles(path);
    return entry.isFile() && !entry.name.endsWith(".sha256") ? [path] : [];
  }));
  return nested.flat();
}

/** 流式计算文件 SHA-256，避免将安装包全部载入内存。 */
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** 解析产物目录、平台标识和清单输出路径。 */
function parseArgs(args) {
  const parsed = { root: "", target: "", output: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!["--root", "--target", "--output"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    index += 1;
    if (arg === "--root") parsed.root = resolve(value);
    if (arg === "--target") parsed.target = value;
    if (arg === "--output") parsed.output = resolve(value);
  }
  if (!parsed.root || !parsed.target || !parsed.output) {
    throw new Error("--root、--target 和 --output 均为必填参数");
  }
  return parsed;
}
