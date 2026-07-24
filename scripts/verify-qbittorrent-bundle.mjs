#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, lstat, mkdtemp, readFile, readdir, readlink, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const QBITTORRENT_VERSION = "5.2.1.10";
const LIBTORRENT_VERSION = "2.0.13";
const QT_VERSION = "6.8.3";
const SUPPORTED_TARGETS = new Set(["darwin-x64", "darwin-arm64", "linux-x64", "win32-x64"]);
const GUI_RUNTIME_PATTERN = /(?:Qt6?(?:Gui|Widgets)(?:\.framework|\.dll|\.so)|platforms\/(?:lib)?q)/i;
const requiredLicenses = [
  "licenses/qbittorrent-COPYING.txt",
  "licenses/qbittorrent-GPL-2.0.txt",
  "licenses/qbittorrent-GPL-3.0.txt",
  "licenses/libtorrent-BSD-3-Clause.txt",
  "licenses/boost-BSL-1.0.txt",
  "licenses/openssl-Apache-2.0.txt",
  "licenses/zlib-license.txt",
  "licenses/qt-GPL-or-LGPL-3.0.txt"
];

const options = parseArgs(process.argv.slice(2));
const targetName = `${options.platform}-${options.arch}`;
if (!SUPPORTED_TARGETS.has(targetName)) throw new Error(`Unsupported target: ${targetName}`);
const directory = options.directory ?? resolve("artifacts", "qbittorrent", targetName);
const binaryPath = resolveBinary(directory, options.platform);

await verifyManifest(directory, targetName, binaryPath, options.platform);
if (options.platform === process.platform && options.arch === process.arch) {
  const environment = buildRuntimeEnvironment(directory, binaryPath, options.platform);
  await verifyVersion(binaryPath, environment);
  await verifyDependencies(directory, binaryPath, environment, options.platform);
  await smokeTest(binaryPath, environment);
}

console.log(`[qbittorrent] verified ${targetName}`);

/** 校验 manifest、摘要、许可证和目标二进制。 */
async function verifyManifest(bundleDirectory, targetName, executablePath, platform) {
  const manifestPath = join(bundleDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 2
    || manifest.target !== targetName
    || manifest.qbittorrentVersion !== QBITTORRENT_VERSION
    || manifest.libtorrentVersion !== LIBTORRENT_VERSION
    || manifest.qtVersion !== QT_VERSION
    || !Array.isArray(manifest.files)
  ) {
    throw new Error(`Invalid qBittorrent manifest: ${manifestPath}`);
  }

  const declaredFiles = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !["file", "symlink"].includes(file.type)) {
      throw new Error(`Invalid qBittorrent manifest entry: ${manifestPath}`);
    }
    const normalizedPath = file.path.replaceAll("\\", "/");
    if (declaredFiles.has(normalizedPath)) throw new Error(`Duplicate qBittorrent manifest entry: ${file.path}`);
    const path = resolveBundlePath(bundleDirectory, file.path);
    const itemStat = await lstat(path);
    if (file.type === "file") {
      if (
        !Number.isInteger(file.size)
        || typeof file.sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !itemStat.isFile()
        || itemStat.size !== file.size
        || await sha256(path) !== file.sha256
      ) {
        throw new Error(`qBittorrent bundle integrity mismatch: ${path}`);
      }
    } else {
      if (typeof file.target !== "string" || !itemStat.isSymbolicLink() || await readlink(path) !== file.target) {
        throw new Error(`qBittorrent bundle symlink mismatch: ${path}`);
      }
      assertSafeSymlink(bundleDirectory, path, file.target);
      await stat(path);
    }
    declaredFiles.add(normalizedPath);
  }

  const actualFiles = new Set(
    (await listEntries(bundleDirectory))
      .map((path) => path.slice(resolve(bundleDirectory).length + 1).replaceAll("\\", "/"))
      .filter((path) => path !== "manifest.json")
  );
  for (const path of actualFiles) {
    if (!declaredFiles.has(path)) throw new Error(`qBittorrent bundle contains undeclared file: ${path}`);
    if (GUI_RUNTIME_PATTERN.test(path)) throw new Error(`Headless qBittorrent bundle contains GUI runtime: ${path}`);
  }
  for (const path of declaredFiles) {
    if (!actualFiles.has(path)) throw new Error(`qBittorrent manifest declares missing file: ${path}`);
  }

  const executableRelative = executablePath.slice(resolve(bundleDirectory).length + 1).replaceAll("\\", "/");
  const sqlitePlugin = platform === "darwin"
    ? "qbittorrent-nox.app/Contents/PlugIns/sqldrivers/libqsqlite.dylib"
    : platform === "win32"
      ? "sqldrivers/qsqlite.dll"
      : "sqldrivers/libqsqlite.so";
  const tlsPlugin = platform === "darwin"
    ? "qbittorrent-nox.app/Contents/PlugIns/tls/libqsecuretransportbackend.dylib"
    : platform === "win32"
      ? "tls/qschannelbackend.dll"
      : "tls/libqopensslbackend.so";
  for (const required of ["SOURCE.md", executableRelative, sqlitePlugin, tlsPlugin, ...requiredLicenses]) {
    if (!declaredFiles.has(required)) throw new Error(`qBittorrent manifest is missing: ${required}`);
  }
}

/** 执行版本命令，确认产物来自固定 Enhanced Edition。 */
async function verifyVersion(executablePath, environment) {
  const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], {
    env: environment,
    timeout: 15_000,
    windowsHide: true
  });
  const output = `${stdout}\n${stderr}`;
  if (!output.includes(`qBittorrent v${QBITTORRENT_VERSION}`)) {
    throw new Error(`Unexpected qBittorrent version output: ${output.trim()}`);
  }
}

/** 检查当前平台运行库闭合，拒绝构建机绝对依赖。 */
async function verifyDependencies(bundleDirectory, executablePath, environment, platform) {
  if (platform === "darwin") {
    for (const path of await findDynamicLibraries(bundleDirectory, executablePath, platform)) {
      const { stdout } = await execFileAsync("otool", ["-L", path]);
      const dependencies = stdout.split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean);
      const installNames = await readMacInstallNames(path);
      for (const dependency of dependencies) {
        if (
          installNames.has(dependency)
          || (isAbsolute(dependency) && resolve(dependency) === resolve(path))
          || dependency.startsWith("/System/Library/")
          || dependency.startsWith("/usr/lib/")
          || dependency.startsWith("@executable_path/")
          || dependency.startsWith("@loader_path/")
          || dependency.startsWith("@rpath/")
        ) continue;
        throw new Error(`Non-relocatable macOS dependency: ${path} -> ${dependency}`);
      }
    }
    return;
  }

  if (platform === "linux") {
    for (const path of await findDynamicLibraries(bundleDirectory, executablePath, platform)) {
      const { stdout } = await execFileAsync("ldd", [path], { env: environment });
      if (stdout.includes("not found")) throw new Error(`Unresolved Linux dependency for ${path}:\n${stdout}`);
    }
    return;
  }

  await verifyWindowsDependencies(bundleDirectory, executablePath, environment);
}

/** 读取 dylib 自身的 LC_ID_DYLIB，避免把 install name 误判为外部依赖。 */
async function readMacInstallNames(path) {
  try {
    const { stdout } = await execFileAsync("otool", ["-D", path]);
    return new Set(stdout.split("\n").slice(1).map((line) => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** 返回当前平台 bundle 内需要检查的动态二进制。 */
async function findDynamicLibraries(bundleDirectory, executablePath, platform) {
  const candidates = new Set([resolve(executablePath)]);
  for (const path of await listEntries(bundleDirectory)) {
    if (platform === "darwin") {
      if (path.endsWith(".dylib") || /\.framework\/Versions\/[^/]+\/[^/]+$/.test(path)) candidates.add(path);
    } else if (/(?:^|\/)lib[^/]+\.so(?:\.[^/]+)*$/.test(path) || path.endsWith(".so")) {
      candidates.add(path);
    }
  }
  return [...candidates];
}

/** 使用 dumpbin 校验 Windows 可执行文件及 DLL 不依赖 bundle 外第三方运行库。 */
async function verifyWindowsDependencies(bundleDirectory, executablePath, environment) {
  const entries = await listEntries(bundleDirectory);
  const binaries = [executablePath, ...entries.filter((path) => path.toLowerCase().endsWith(".dll"))];
  const bundledNames = new Set(binaries.map((path) => basename(path).toLowerCase()));
  const { stdout: dumpbinLocations } = await execFileAsync("where.exe", ["dumpbin.exe"]);
  const dumpbinPath = dumpbinLocations.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!dumpbinPath) throw new Error("dumpbin.exe was not found");

  for (const path of binaries) {
    const { stdout } = await execFileAsync(dumpbinPath, ["/nologo", "/dependents", path], {
      env: environment,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    for (const dependency of parseWindowsDependencies(stdout)) {
      if (bundledNames.has(dependency.toLowerCase()) || await isWindowsSystemLibrary(dependency, environment)) continue;
      throw new Error(`Unresolved Windows dependency: ${path} -> ${dependency}`);
    }
  }
}

/** 从 dumpbin 输出中提取导入 DLL 名称。 */
function parseWindowsDependencies(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_.+-]+\.dll$/i.test(line));
}

/** 判断 DLL 是否由 Windows 系统目录提供。 */
async function isWindowsSystemLibrary(name, environment) {
  if (/^(?:api|ext)-ms-win-/i.test(name)) return true;
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT;
  if (!systemRoot) return false;
  return await exists(join(systemRoot, "System32", name)) || await exists(join(systemRoot, "SysWOW64", name));
}

/** 启动临时 WebUI，确认 HTTP 服务可用后结束测试进程。 */
async function smokeTest(executablePath, environment) {
  const profileDirectory = await mkdtemp(join(tmpdir(), "ani-qbittorrent-profile-"));
  const port = await reservePort();
  const child = spawn(executablePath, [
    `--webui-port=${port}`,
    `--profile=${profileDirectory}`,
    "--confirm-legal-notice"
  ], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  let launchError;
  child.once("error", (error) => { launchError = error; });
  child.stdout.on("data", (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-8_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-8_000); });

  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null && !launchError) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
        if (response.status >= 200 && response.status < 500) {
          ready = true;
          break;
        }
      } catch {
        // 服务仍在启动，继续等待。
      }
      await sleep(250);
    }
    if (!ready) {
      const detail = launchError instanceof Error ? launchError.message : output.trim();
      throw new Error(`qBittorrent WebUI smoke test failed: ${detail}`);
    }
  } finally {
    if (child.pid) await stopChild(child);
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

/** 递归列出 bundle 内的普通文件和符号链接。 */
async function listEntries(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await listEntries(path));
    if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
  }
  return paths;
}

/** 隔离构建机路径并设置 bundle 自带 Qt 的运行环境。 */
function buildRuntimeEnvironment(bundleDirectory, executablePath, platform) {
  const environment = { ...process.env };
  delete environment.CMAKE_PREFIX_PATH;
  delete environment.QTDIR;
  delete environment.QT_ROOT_DIR;
  delete environment.QT_QPA_PLATFORM_PLUGIN_PATH;
  if (platform === "win32") {
    const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || "C:\\Windows";
    environment.PATH = [bundleDirectory, join(systemRoot, "System32"), systemRoot].join(delimiter);
    environment.QT_PLUGIN_PATH = bundleDirectory;
    delete environment.OPENSSL_MODULES;
    return environment;
  }
  if (platform === "linux") {
    environment.LD_LIBRARY_PATH = join(bundleDirectory, "lib");
    environment.QT_PLUGIN_PATH = bundleDirectory;
    delete environment.OPENSSL_MODULES;
    return environment;
  }

  const contents = dirname(dirname(executablePath));
  environment.QT_PLUGIN_PATH = join(contents, "PlugIns");
  environment.DYLD_FRAMEWORK_PATH = join(contents, "Frameworks");
  environment.DYLD_LIBRARY_PATH = join(contents, "Frameworks");
  delete environment.DYLD_FALLBACK_FRAMEWORK_PATH;
  delete environment.DYLD_FALLBACK_LIBRARY_PATH;
  delete environment.OPENSSL_MODULES;
  return environment;
}

/** 返回空闲本地端口，并立即释放供 qBittorrent 使用。 */
function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

/** 优先温和结束测试进程，超时后强制停止。 */
async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2_000);
}

/** 在限定时间内等待子进程退出。 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) return resolveExit(true);
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

/** 返回目标平台 nox 可执行文件路径。 */
function resolveBinary(directory, platform) {
  if (platform === "win32") return join(directory, "qbittorrent-nox.exe");
  if (platform === "darwin") return join(directory, "qbittorrent-nox.app", "Contents", "MacOS", "qbittorrent-nox");
  return join(directory, "qbittorrent-nox");
}

/** 阻止 manifest 中的绝对路径和目录逃逸。 */
function resolveBundlePath(directory, path) {
  if (!path || isAbsolute(path)) throw new Error(`Invalid qBittorrent bundle path: ${path}`);
  const root = resolve(directory);
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`qBittorrent bundle path escapes target directory: ${path}`);
  }
  return resolved;
}

/** 阻止 bundle 符号链接指向目标目录外部。 */
function assertSafeSymlink(bundleDirectory, linkPath, target) {
  if (!target || isAbsolute(target)) throw new Error(`Invalid qBittorrent bundle symlink: ${linkPath} -> ${target}`);
  const root = resolve(bundleDirectory);
  const resolvedTarget = resolve(dirname(linkPath), target);
  if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) {
    throw new Error(`qBittorrent bundle symlink escapes target directory: ${linkPath} -> ${target}`);
  }
}

/** 判断路径是否存在。 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 等待指定毫秒数。 */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** 计算文件 SHA-256。 */
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** 解析目标平台和 bundle 目录。 */
function parseArgs(args) {
  const parsed = { platform: process.platform, arch: process.arch, directory: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!["--platform", "--arch", "--directory"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = args[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--platform") parsed.platform = value;
    if (arg === "--arch") parsed.arch = value;
    if (arg === "--directory") parsed.directory = resolve(value);
    index += 1;
  }
  return parsed;
}
