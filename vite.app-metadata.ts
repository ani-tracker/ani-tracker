import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version?: unknown };

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("package.json 缺少有效的 version 字段");
}

export const appVersion = packageMetadata.version;
