#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, chmod, cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const CORE_VERSION = "0.1.0";
const LIBTORRENT_VERSION = "2.1.0";
const defaultSourceRoot = resolve(
  process.env.ANI_TORRENT_CORE_SOURCE_ROOT || join("resources", "torrent-core")
);
const defaultTargetRoot = resolve("out", "torrent-core");
const requiredLicenseFiles = [
  "licenses/libtorrent-BSD-3-Clause.txt",
  "licenses/openssl-Apache-2.0.txt",
  "licenses/boost-BSL-1.0.txt"
];
const supportedTargets = [
  { platform: "darwin", arch: "arm64", dir: "darwin-arm64", binary: "torrent-core" },
  { platform: "darwin", arch: "x64", dir: "darwin-x64", binary: "torrent-core" },
  { platform: "win32", arch: "x64", dir: "win32-x64", binary: "torrent-core.exe" },
  { platform: "win32", arch: "arm64", dir: "win32-arm64", binary: "torrent-core.exe" },
  { platform: "linux", arch: "x64", dir: "linux-x64", binary: "torrent-core" },
  { platform: "linux", arch: "arm64", dir: "linux-arm64", binary: "torrent-core" }
];

const options = parseArgs(process.argv.slice(2));
const selectedTarget = supportedTargets.find(
  (target) => target.platform === options.platform && target.arch === options.arch
);

if (!options.verifyAll && !selectedTarget) {
  console.error(`[torrent-core] unsupported build target: ${options.platform}-${options.arch}`);
  console.error(`[torrent-core] supported targets: ${supportedTargets.map((target) => target.dir).join(", ")}`);
  process.exit(1);
}

const targetsToVerify = options.verifyAll ? supportedTargets : [selectedTarget];
const availableTargets = [];
const missingTargets = [];

for (const target of targetsToVerify) {
  const sourceDirectory = join(options.sourceRoot, target.dir);
  if (!(await exists(sourceDirectory))) {
    missingTargets.push(target);
    continue;
  }
  await verifyBundle(sourceDirectory, target);
  availableTargets.push(target);
  console.log(`[torrent-core] verified ${target.dir}`);
}

if ((options.required || options.verifyAll) && missingTargets.length) {
  for (const target of missingTargets) {
    console.error(`[torrent-core] missing ${target.dir}: ${join(options.sourceRoot, target.dir, target.binary)}`);
  }
  process.exit(1);
}

if (!options.verifyOnly) {
  await rm(options.targetRoot, { recursive: true, force: true });
  for (const target of availableTargets) {
    const outputDirectory = join(options.targetRoot, target.dir);
    await cp(join(options.sourceRoot, target.dir), outputDirectory, {
      recursive: true,
      dereference: false
    });
    if (target.platform !== "win32") {
      await chmod(join(outputDirectory, target.binary), 0o755);
    }
    console.log(`[torrent-core] copied ${target.dir}: ${outputDirectory}`);
  }
}

if (!availableTargets.length && !options.verifyAll) {
  console.warn(
    `[torrent-core] no verified bundle for ${options.platform}-${options.arch}; `
    + "development can use native/torrent-core/build, but packaged embedded downloads will be unavailable."
  );
}

/** 校验单个平台资源的清单、摘要、许可证和运行能力。 */
async function verifyBundle(directory, target) {
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1
    || manifest.target !== target.dir
    || manifest.coreVersion !== CORE_VERSION
    || manifest.libtorrentVersion !== LIBTORRENT_VERSION
    || !Array.isArray(manifest.files)
  ) {
    throw new Error(`[torrent-core] invalid manifest: ${manifestPath}`);
  }

  const declaredFiles = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !Number.isInteger(file.size) || typeof file.sha256 !== "string") {
      throw new Error(`[torrent-core] invalid manifest file entry: ${manifestPath}`);
    }
    const filePath = resolveBundlePath(directory, file.path);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size !== file.size || await sha256(filePath) !== file.sha256) {
      throw new Error(`[torrent-core] file integrity mismatch: ${filePath}`);
    }
    declaredFiles.add(file.path.replaceAll("\\", "/"));
  }

  for (const requiredFile of [target.binary, ...requiredLicenseFiles]) {
    if (!declaredFiles.has(requiredFile)) {
      throw new Error(`[torrent-core] manifest is missing required file: ${requiredFile}`);
    }
  }

  const binaryPath = join(directory, target.binary);
  await verifyExecutable(binaryPath, target.platform);
  if (target.platform === process.platform && target.arch === process.arch) {
    await verifyRuntimeDependencies(directory, binaryPath, target.platform);
    await smokeTest(binaryPath);
  }
}

/** 限制清单路径始终位于对应资源目录内。 */
function resolveBundlePath(directory, path) {
  if (!path || isAbsolute(path)) {
    throw new Error(`[torrent-core] invalid bundle path: ${path}`);
  }
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(resolvedDirectory, path);
  if (resolvedPath !== resolvedDirectory && !resolvedPath.startsWith(`${resolvedDirectory}${sep}`)) {
    throw new Error(`[torrent-core] bundle path escapes target directory: ${path}`);
  }
  return resolvedPath;
}

/** 校验二进制文件类型和 POSIX 可执行位。 */
async function verifyExecutable(path, platform) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error(`[torrent-core] expected executable file: ${path}`);
  }
  if (platform !== "win32") {
    await access(path, constants.X_OK);
  }
}

/** 拒绝当前 macOS 资源引用 Homebrew 等包外绝对动态库。 */
async function verifyRuntimeDependencies(directory, binaryPath, platform) {
  if (platform !== "darwin") return;
  const candidates = [binaryPath, ...(await listFiles(directory)).filter((path) => path.endsWith(".dylib"))];
  for (const candidate of candidates) {
    const { stdout } = await execFileAsync("otool", ["-L", candidate]);
    const dependencies = stdout.split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean);
    for (const dependency of dependencies) {
      if (
        dependency.startsWith("/System/Library/")
        || dependency.startsWith("/usr/lib/")
        || dependency.startsWith("@loader_path/")
        || dependency.startsWith("@rpath/")
        || dependency === candidate
      ) {
        continue;
      }
      throw new Error(`[torrent-core] non-relocatable dependency in ${basename(candidate)}: ${dependency}`);
    }
  }
}

/** 真实执行 status 和 shutdown，确认协议与优雅退出可用。 */
async function smokeTest(binaryPath) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "ani-torrent-core-resource-"));
  const child = spawn(binaryPath, ["--data-dir", dataDirectory], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdin.end([
    JSON.stringify({ id: "verify-status", method: "status", params: {} }),
    JSON.stringify({ id: "verify-shutdown", method: "shutdown", params: {} })
  ].join("\n") + "\n");

  const result = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("[torrent-core] smoke test timed out"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });

  const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (
    result.code !== 0
    || responses.length !== 2
    || responses.some((response) => response.ok !== true && response.ok !== "true")
  ) {
    throw new Error(
      `[torrent-core] smoke test failed: code=${result.code} signal=${result.signal ?? "none"} stderr=${stderr.trim()}`
    );
  }
}

/** 递归返回目录中的普通文件。 */
async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

/** 计算资源文件的 SHA-256。 */
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** 判断路径是否存在。 */
async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 解析资源校验和复制参数。 */
function parseArgs(args) {
  const parsed = {
    sourceRoot: defaultSourceRoot,
    targetRoot: defaultTargetRoot,
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
    required: false,
    verifyAll: false,
    verifyOnly: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--required") parsed.required = true;
    else if (arg === "--verify-all") {
      parsed.verifyAll = true;
      parsed.verifyOnly = true;
    } else if (arg === "--verify-only") parsed.verifyOnly = true;
    else if (["--source", "--target", "--platform", "--arch"].includes(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--source") parsed.sourceRoot = resolve(value);
      if (arg === "--target") parsed.targetRoot = resolve(value);
      if (arg === "--platform") parsed.platform = value;
      if (arg === "--arch") parsed.arch = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
