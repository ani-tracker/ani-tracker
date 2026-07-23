#!/usr/bin/env node
import { access, cp, mkdir, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const defaultSourceRoot = resolve("resources", "qbittorrent");
const defaultTargetRoot = resolve("out", "qbittorrent");

const supportedTargets = [
  {
    platform: "darwin",
    arch: "arm64",
    dir: "darwin-arm64",
    binaries: [
      "qbittorrent-nox",
      "qbittorrent-nox.app/Contents/MacOS/qbittorrent-nox",
      "qBittorrent-nox.app/Contents/MacOS/qbittorrent-nox"
    ]
  },
  {
    platform: "darwin",
    arch: "x64",
    dir: "darwin-x64",
    binaries: [
      "qbittorrent-nox",
      "qbittorrent-nox.app/Contents/MacOS/qbittorrent-nox",
      "qBittorrent-nox.app/Contents/MacOS/qbittorrent-nox"
    ]
  },
  {
    platform: "win32",
    arch: "x64",
    dir: "win32-x64",
    binaries: ["qbittorrent-nox.exe"]
  },
  {
    platform: "linux",
    arch: "x64",
    dir: "linux-x64",
    binaries: ["qbittorrent-nox"]
  }
];

const options = parseArgs(process.argv.slice(2));
const selectedTarget = supportedTargets.find(
  (target) => target.platform === options.platform && target.arch === options.arch
);

if (!options.all && !selectedTarget) {
  console.error(`[qbittorrent] unsupported build target: ${options.platform}-${options.arch}`);
  console.error(`[qbittorrent] supported targets: ${supportedTargets.map((target) => target.dir).join(", ")}`);
  process.exit(1);
}

const targetsToPrepare = options.all ? supportedTargets : [selectedTarget];

const availableTargets = [];
const missingTargets = [];

await rm(options.targetRoot, { recursive: true, force: true });

for (const target of targetsToPrepare) {
  const binaryPath = await findBundledBinary(options.sourceRoot, target);
  if (binaryPath) {
    availableTargets.push({ ...target, binaryPath });
  } else {
    missingTargets.push(target);
  }
}

if (options.required && missingTargets.length) {
  for (const target of missingTargets) {
    console.error(`[qbittorrent] missing ${target.dir}: expected one of ${target.binaries.join(", ")}`);
  }
  process.exit(1);
}

if (!availableTargets.length) {
  console.warn(
    `[qbittorrent] no bundled qBittorrent-nox binaries found for ${targetsToPrepare.map((target) => target.dir).join(", ")} under ${options.sourceRoot}; managed nox startup will stay disabled until binaries are added.`
  );
  process.exit(0);
}

await mkdir(options.targetRoot, { recursive: true });

for (const target of availableTargets) {
  await cp(join(options.sourceRoot, target.dir), join(options.targetRoot, target.dir), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true
  });
  console.log(`[qbittorrent] copied ${target.dir} from ${target.binaryPath}`);
}

console.log(`[qbittorrent] resource output: ${options.targetRoot}`);

/** 查找目标平台中可托管启动的 qBittorrent-nox 文件。 */
async function findBundledBinary(sourceRoot, target) {
  const targetDir = join(sourceRoot, target.dir);
  if (!(await exists(targetDir))) {
    return undefined;
  }

  for (const binary of target.binaries) {
    const binaryPath = join(targetDir, binary);
    if (await isFile(binaryPath)) {
      return binaryPath;
    }
  }

  return undefined;
}

/** 判断路径是否为当前主机可使用的可执行文件。 */
async function isFile(path) {
  try {
    const itemStat = await stat(path);
    if (!itemStat.isFile()) {
      return false;
    }

    // Windows 可执行文件不依赖 POSIX 执行权限位。
    if (process.platform === "win32" || path.toLowerCase().endsWith(".exe")) {
      return true;
    }

    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 判断资源路径是否存在。 */
async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 解析资源目录和目标平台参数。 */
function parseArgs(args) {
  const parsed = {
    sourceRoot: defaultSourceRoot,
    targetRoot: defaultTargetRoot,
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
    required: false,
    all: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--required") {
      parsed.required = true;
      continue;
    }

    if (arg === "--all") {
      parsed.all = true;
      continue;
    }

    if (arg === "--source") {
      parsed.sourceRoot = resolve(readValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--target") {
      parsed.targetRoot = resolve(readValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--platform") {
      parsed.platform = readValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--arch") {
      parsed.arch = readValue(args, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

/** 读取命令行参数值。 */
function readValue(args, index, arg) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${arg} requires a value`);
  }

  return value;
}
