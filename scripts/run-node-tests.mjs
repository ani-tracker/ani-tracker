import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import electronPath from "electron";

const outputDir = "out/test-node";
rmSync(outputDir, { force: true, recursive: true });

const compileResult = spawnSync(
  process.execPath,
  [join("node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.test.node.json", "--pretty", "false"],
  { stdio: "inherit" }
);
if (compileResult.status !== 0) {
  process.exit(compileResult.status ?? 1);
}

writeFileSync(join(outputDir, "package.json"), '{"type":"commonjs"}\n');
const sharedModuleTarget = join(outputDir, "node_modules", "@shared");
mkdirSync(sharedModuleTarget, { recursive: true });
cpSync(join(outputDir, "shared"), sharedModuleTarget, { recursive: true });

const testFiles = [
  ...collectTestFiles(join(outputDir, "main", "core")),
  ...collectTestFiles(join(outputDir, "shared", "__tests__"))
];
const result = spawnSync(
  electronPath,
  ["--test", ...testFiles],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    shell: process.platform === "win32",
    stdio: "inherit"
  }
);

process.exit(result.status ?? 1);

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTestFiles(path);
    return entry.name.endsWith(".test.js") ? [path] : [];
  });
}
