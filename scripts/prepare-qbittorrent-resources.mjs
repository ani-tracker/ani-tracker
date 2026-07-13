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
const requiredTargets = options.all
  ? supportedTargets
  : supportedTargets.filter((target) => target.platform === options.platform && target.arch === options.arch);

const availableTargets = [];
const missingTargets = [];

for (const target of supportedTargets) {
  const binaryPath = await findBundledBinary(options.sourceRoot, target);
  if (binaryPath) {
    availableTargets.push({ ...target, binaryPath });
  } else if (requiredTargets.some((required) => required.dir === target.dir)) {
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
    `[qbittorrent] no bundled qBittorrent-nox binaries found under ${options.sourceRoot}; managed nox startup will stay disabled until binaries are added.`
  );
  process.exit(0);
}

await rm(options.targetRoot, { recursive: true, force: true });
await mkdir(options.targetRoot, { recursive: true });

for (const target of availableTargets) {
  await cp(join(options.sourceRoot, target.dir), join(options.targetRoot, target.dir), {
    recursive: true,
    dereference: false
  });
  console.log(`[qbittorrent] copied ${target.dir} from ${target.binaryPath}`);
}

console.log(`[qbittorrent] resource output: ${options.targetRoot}`);

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

async function isFile(path) {
  try {
    const itemStat = await stat(path);
    if (!itemStat.isFile()) {
      return false;
    }

    // Windows .exe files do not rely on POSIX executable bits.
    if (process.platform === "win32" || path.toLowerCase().endsWith(".exe")) {
      return true;
    }

    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(args) {
  const parsed = {
    sourceRoot: defaultSourceRoot,
    targetRoot: defaultTargetRoot,
    platform: process.platform,
    arch: process.arch,
    required: false,
    all: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

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

function readValue(args, index, arg) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${arg} requires a value`);
  }

  return value;
}
