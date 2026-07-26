import { spawnSync } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import process from "node:process";

const VLC_APP_LIBRARY_MARKER = "/VLC.app/Contents/MacOS/lib/";

/** 重写复制后 Mach-O 的 VLC 私有依赖，并重新执行 ad-hoc 签名。 */
export async function patchMacRuntimeInstallNames(root, required) {
  if (process.platform !== "darwin") {
    if (required) throw new Error("[libvlc] macOS install-name patching requires macOS");
    return [];
  }
  for (const command of ["codesign", "install_name_tool", "otool"]) ensureCommand(command);

  const libraryRoot = join(root, "lib");
  const files = [
    ...await listRegularDylibs(libraryRoot),
    ...await listRegularDylibs(join(root, "plugins"))
  ];
  let patchedDependencies = 0;
  let patchedFiles = 0;

  for (const file of files) {
    const dependencies = inspectDependencies(file);
    let changed = false;
    for (const dependency of dependencies) {
      const libraryRelativePath = bundledLibraryRelativePath(dependency);
      if (!libraryRelativePath) continue;
      const target = join(libraryRoot, ...libraryRelativePath.split("/"));
      if (!(await isFile(target))) {
        throw new Error(`[libvlc] bundled macOS dependency is missing: ${dependency} required by ${file}`);
      }
      const replacement = loaderRelativePath(file, target);
      if (replacement === dependency) continue;
      runCommand("install_name_tool", ["-change", dependency, replacement, file]);
      patchedDependencies += 1;
      changed = true;
    }
    if (!changed) continue;
    runCommand("codesign", ["--force", "--sign", "-", "--timestamp=none", file]);
    runCommand("codesign", ["--verify", "--strict", file]);
    patchedFiles += 1;
  }

  if (patchedDependencies === 0 && required) {
    throw new Error("[libvlc] no relocatable macOS VLC dependencies were found");
  }
  console.log(
    `[libvlc] macOS runtime relocated: dependencies=${patchedDependencies} files=${patchedFiles}`
  );
  return patchedDependencies > 0
    ? [`Rewrote ${patchedDependencies} Mach-O dependencies across ${patchedFiles} copied libraries and applied ad-hoc signatures; no VLC source code was modified.`]
    : [];
}

/** 解析 otool -L 输出中的动态库依赖。 */
export function parseOtoolDependencies(output) {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().match(/^(.*?)\s+\(compatibility version /)?.[1])
    .filter(Boolean);
}

/** 将 VLC.app 中的 dylib 依赖转换为打包后 lib 目录内的相对路径。 */
export function bundledLibraryRelativePath(dependency) {
  for (const prefix of ["@rpath/", "@executable_path/lib/"]) {
    if (dependency.startsWith(prefix)) {
      return dylibRelativePath(dependency.slice(prefix.length));
    }
  }
  const markerIndex = dependency.indexOf(VLC_APP_LIBRARY_MARKER);
  return markerIndex >= 0
    ? dylibRelativePath(dependency.slice(markerIndex + VLC_APP_LIBRARY_MARKER.length))
    : undefined;
}

/** 仅接受实际随运行时复制的 dylib，排除 Sparkle 等 Framework 依赖。 */
function dylibRelativePath(value) {
  return value.endsWith(".dylib") && !value.includes(".framework/")
    ? value
    : undefined;
}

/** 生成从当前 Mach-O 文件到目标 dylib 的 @loader_path 引用。 */
export function loaderRelativePath(file, target) {
  const value = relative(dirname(file), target).replaceAll("\\", "/");
  return `@loader_path/${value}`;
}

/** 递归列出真实 dylib 文件，跳过会重复指向同一文件的符号链接。 */
async function listRegularDylibs(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listRegularDylibs(path);
    if (!entry.name.endsWith(".dylib")) return [];
    const value = await lstat(path);
    return value.isFile() ? [path] : [];
  }));
  return nested.flat();
}

/** 调用 otool 并返回动态依赖列表。 */
function inspectDependencies(file) {
  const result = spawnSync("otool", ["-L", file], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[libvlc] otool failed for ${file}: ${result.stderr?.trim()}`);
  }
  return parseOtoolDependencies(result.stdout ?? "");
}

/** 校验 macOS 打包命令存在。 */
function ensureCommand(command) {
  const result = spawnSync(command, ["--help"], { stdio: "ignore" });
  if (result.error?.code === "ENOENT") throw new Error(`[libvlc] required macOS command is missing: ${command}`);
  if (result.error) throw result.error;
}

/** 执行 Mach-O 修改或签名命令。 */
function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[libvlc] ${command} failed (${result.status ?? "unknown"}): ${result.stderr?.trim()}`);
  }
}

/** 判断路径是否可解析为真实文件。 */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
