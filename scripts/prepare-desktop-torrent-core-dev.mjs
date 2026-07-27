#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import process from "node:process";

const VCPKG_VERSION = "2025.06.13";
const options = parseArgs(process.argv.slice(2));
if (!["darwin", "linux", "win32"].includes(process.platform)) {
  throw new Error(`[torrent-core] desktop development build does not support ${process.platform}`);
}

const targetName = `${process.platform}-${options.arch}`;
const buildDirectory = resolve("native/torrent-core/build/portable-release");
const artifactRoot = resolve("artifacts/torrent-core");
const buildEnvironment = process.platform === "win32"
  ? await prepareWindowsBuildEnvironment(options.arch, !options.checkOnly)
  : process.platform === "darwin"
    ? prepareMacBuildEnvironment()
    : prepareLinuxBuildEnvironment();

if (options.checkOnly) {
  console.log(`[torrent-core] native build prerequisites ready: ${targetName}`);
  process.exit(0);
}

configureCore(buildEnvironment, options.arch);
const buildArgs = ["--build", buildDirectory, "--config", "Release"];
if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
  // WSL 默认按宿主逻辑核心数并行，首次编译 libtorrent 容易耗尽分配给虚拟机的内存。
  buildArgs.push("--parallel", "2");
}
runCommand("cmake", buildArgs, buildEnvironment);
runCommand(process.execPath, [
  resolve("scripts/package-torrent-core-bundle.mjs"),
  "--platform", process.platform,
  "--arch", options.arch,
  "--build-directory", buildDirectory,
  "--output", join(artifactRoot, targetName)
]);
runCommand(process.execPath, [
  resolve("scripts/prepare-torrent-core-resources.mjs"),
  "--source", artifactRoot,
  "--target", resolve("out/torrent-core"),
  "--platform", process.platform,
  "--arch", options.arch,
  "--required"
]);

console.log(`[torrent-core] desktop development bundle ready: ${join("out/torrent-core", targetName)}`);

/** 为 Windows 定位 VS 工具链、CMake、Ninja 和固定版本 vcpkg。 */
async function prepareWindowsBuildEnvironment(arch, installDependencies) {
  if (!["x64", "arm64"].includes(arch)) {
    throw new Error(`[torrent-core] unsupported Windows architecture: ${arch}`);
  }
  const environment = await loadVisualStudioEnvironment(arch);
  ensureWindowsCommand("cmake.exe", environment, "Visual Studio C++ CMake tools or CMake 3.24+");
  ensureWindowsCommand("ninja.exe", environment, "Visual Studio C++ CMake tools or Ninja");
  ensureWindowsCommand("cl.exe", environment, "Visual Studio 2022 C++ Build Tools");
  ensureWindowsCommand("git.exe", environment, "Git for Windows");

  if (!installDependencies) return environment;

  const vcpkgRoot = resolve(".vcpkg");
  const vcpkgExecutable = join(vcpkgRoot, "vcpkg.exe");
  if (!(await exists(vcpkgExecutable))) {
    await bootstrapVcpkg(vcpkgRoot, environment);
  }
  verifyVcpkgVersion(vcpkgRoot, environment);

  const triplet = `${arch}-windows-static`;
  runCommand(vcpkgExecutable, [
    "install",
    `--triplet=${triplet}`,
    `--x-manifest-root=${resolve("native/torrent-dependencies")}`,
    `--x-install-root=${join(vcpkgRoot, "installed")}`
  ], environment);

  return {
    ...environment,
    VCPKG_ROOT: vcpkgRoot,
    ANI_VCPKG_TOOLCHAIN: join(vcpkgRoot, "scripts", "buildsystems", "vcpkg.cmake"),
    ANI_VCPKG_TRIPLET: triplet
  };
}

/** 读取 VS 开发命令环境，使普通 Git Bash 也能使用 MSVC。 */
async function loadVisualStudioEnvironment(arch) {
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!(await exists(vswhere))) {
    throw new Error(
      "[torrent-core] Visual Studio 2022 Build Tools is required. Install the Desktop development with C++ workload and CMake tools, then rerun this script."
    );
  }
  const installation = captureCommand(vswhere, [
    "-latest", "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath"
  ]).trim();
  if (!installation) {
    throw new Error("[torrent-core] Visual Studio 2022 C++ Build Tools installation was not found");
  }

  const vcvars = join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat");
  if (!(await exists(vcvars))) throw new Error(`[torrent-core] vcvarsall.bat was not found: ${vcvars}`);
  const vcvarsArch = arch === "arm64" ? "amd64_arm64" : "x64";
  const environmentOutput = captureWindowsShellCommand(
    `call "${vcvars}" ${vcvarsArch} >nul && set`
  );
  const environment = parseWindowsEnvironment(environmentOutput);

  const cmakeRoot = join(
    installation,
    "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake"
  );
  const extraPaths = [join(cmakeRoot, "CMake", "bin"), join(cmakeRoot, "Ninja")];
  const currentPath = environment.Path ?? environment.PATH ?? process.env.Path;
  delete environment.PATH;
  environment.Path = [...extraPaths, currentPath].filter(Boolean).join(delimiter);
  return environment;
}

/** 将 cmd.exe 输出的环境变量转换为 Node 子进程环境。 */
function parseWindowsEnvironment(output) {
  const environment = { ...process.env };
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

/** 克隆并初始化项目固定版本的 vcpkg。 */
async function bootstrapVcpkg(vcpkgRoot, environment) {
  const bootstrap = join(vcpkgRoot, "bootstrap-vcpkg.bat");
  if (!(await exists(bootstrap))) {
    if (await exists(vcpkgRoot)) {
      throw new Error(`[torrent-core] incomplete vcpkg directory must be repaired manually: ${vcpkgRoot}`);
    }
    runCommand("git.exe", [
      "clone", "--branch", VCPKG_VERSION, "--depth", "1",
      "https://github.com/microsoft/vcpkg.git", vcpkgRoot
    ], environment);
  }
  runWindowsShellCommand(`call "${bootstrap}" -disableMetrics`, environment);
}

/** 校验现有 vcpkg 正好位于项目固定的版本标签。 */
function verifyVcpkgVersion(vcpkgRoot, environment) {
  const version = captureCommand("git.exe", [
    "-C", vcpkgRoot, "describe", "--tags", "--exact-match"
  ], environment).trim();
  if (version !== VCPKG_VERSION) {
    throw new Error(
      `[torrent-core] vcpkg version mismatch: expected ${VCPKG_VERSION}, received ${version || "unknown"}`
    );
  }
}

/** 为 macOS 验证本机工具，并注入 Homebrew 依赖前缀。 */
function prepareMacBuildEnvironment() {
  const environment = { ...process.env };
  ensureCommand("cmake", environment, "CMake 3.24+");
  ensureCommand("ninja", environment, "Ninja");
  ensureCommand("brew", environment, "Homebrew with boost and openssl@3");
  const boostPrefix = captureCommand("brew", ["--prefix", "boost"], environment).trim();
  const opensslPrefix = captureCommand("brew", ["--prefix", "openssl@3"], environment).trim();
  environment.CMAKE_PREFIX_PATH = [
    boostPrefix,
    opensslPrefix,
    environment.CMAKE_PREFIX_PATH
  ].filter(Boolean).join(";");
  return environment;
}

/** 为 Linux 验证 C++、CMake、Ninja 与原生依赖发现工具。 */
function prepareLinuxBuildEnvironment() {
  const environment = { ...process.env };
  ensureCommand("cmake", environment, "CMake 3.24+");
  ensureCommand("ninja", environment, "Ninja");
  ensureCommand("c++", environment, "a C++17 compiler");
  ensureCommand("pkg-config", environment, "pkg-config");
  return environment;
}

/** 使用平台工具链配置 portable torrent-core。 */
function configureCore(environment, arch) {
  const args = ["--preset", "portable-release", "-S", resolve("native/torrent-core")];
  if (process.platform === "win32") {
    args.push(
      `-DCMAKE_TOOLCHAIN_FILE=${environment.ANI_VCPKG_TOOLCHAIN}`,
      `-DVCPKG_TARGET_TRIPLET=${environment.ANI_VCPKG_TRIPLET}`,
      "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"
    );
  }
  if (process.platform === "darwin") {
    const cmakeArchitecture = arch === "x64" ? "x86_64" : arch;
    console.log(`[torrent-core] macOS CMake architecture: ${arch} -> ${cmakeArchitecture}`);
    args.push(`-DCMAKE_OSX_ARCHITECTURES=${cmakeArchitecture}`);
  }
  runCommand("cmake", args, environment);
}

/** 确认外部构建命令可从指定环境启动。 */
function ensureCommand(command, environment, requirement) {
  const result = spawnSync(command, ["--version"], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.error || result.status !== 0) {
    throw new Error(`[torrent-core] ${command} is required; install ${requirement}`);
  }
}

/** 使用 Windows 命令解析规则确认构建工具存在。 */
function ensureWindowsCommand(command, environment, requirement) {
  const result = spawnSync("where.exe", [command], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.error || result.status !== 0) {
    throw new Error(`[torrent-core] ${command} is required; install ${requirement}`);
  }
}

/** 通过 Windows 命令解释器执行命令并返回 UTF-8 标准输出。 */
function captureWindowsShellCommand(shellCommand, environment = process.env) {
  const args = createWindowsShellArgs(shellCommand);
  return captureCommand("cmd.exe", args, environment, { windowsVerbatimArguments: true });
}

/** 通过 Windows 命令解释器执行命令并透传 UTF-8 日志。 */
function runWindowsShellCommand(shellCommand, environment = process.env) {
  const args = createWindowsShellArgs(shellCommand);
  runCommand("cmd.exe", args, environment, { windowsVerbatimArguments: true });
}

/** 生成不会被 Node 二次转义的 Windows 命令解释器参数。 */
function createWindowsShellArgs(shellCommand) {
  return ["/d", "/s", "/c", `"chcp 65001 >nul && ${shellCommand}"`];
}

/** 执行命令并返回标准输出，失败时保留诊断信息。 */
function captureCommand(command, args, environment = process.env, spawnOptions = {}) {
  const result = spawnSync(command, args, {
    ...spawnOptions,
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `[torrent-core] command failed (${result.status ?? "unknown"}): ${command}\n${result.stderr?.trim() ?? ""}`
    );
  }
  return result.stdout ?? "";
}

/** 执行原生构建命令并透传日志。 */
function runCommand(command, args, environment = process.env, spawnOptions = {}) {
  const result = spawnSync(command, args, {
    ...spawnOptions,
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[torrent-core] command failed (${result.status ?? "unknown"}): ${command}`);
  }
}

/** 判断文件或目录是否存在。 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 解析目标架构。 */
function parseArgs(args) {
  const parsed = {
    arch: process.arch,
    checkOnly: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--check-only") {
      parsed.checkOnly = true;
      continue;
    }
    if (arg !== "--arch") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--arch") parsed.arch = value;
    index += 1;
  }
  return parsed;
}
