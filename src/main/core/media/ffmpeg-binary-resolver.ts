import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface FfmpegBinaryResolverOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  resourceRoots?: string[];
}

export interface FfmpegCommandResolverOptions extends FfmpegBinaryResolverOptions {
  ffprobePath: string;
  bundledFfmpegPath?: string | null;
}

export interface FfprobeCommandResolverOptions extends FfmpegBinaryResolverOptions {
  configuredPath: string;
  bundledFfprobePath?: string | null;
}

/** 按应用资源、构建输出和源码资源顺序查找当前平台的内置 FFmpeg。 */
export function resolveBundledFfmpegBinary(
  options: FfmpegBinaryResolverOptions = {}
): string | undefined {
  return resolveBundledMediaBinary("ffmpeg", options);
}

/** 按应用资源、构建输出和源码资源顺序查找当前平台的内置 FFprobe。 */
export function resolveBundledFfprobeBinary(
  options: FfmpegBinaryResolverOptions = {}
): string | undefined {
  return resolveBundledMediaBinary("ffprobe", options);
}

/** 用户显式路径优先，默认命令则优先使用内置 FFprobe。 */
export function resolveFfprobeCommands(options: FfprobeCommandResolverOptions): [string, ...string[]] {
  const platform = options.platform ?? process.platform;
  const configuredPath = options.configuredPath.trim() || "ffprobe";
  const bundledPath = options.bundledFfprobePath === undefined
    ? resolveBundledFfprobeBinary(options)
    : options.bundledFfprobePath ?? undefined;
  const availableBundledPath = bundledPath && existsSync(bundledPath) ? bundledPath : undefined;
  const candidates = isDefaultFfprobeCommand(configuredPath, platform)
    ? [availableBundledPath, configuredPath]
    : [configuredPath, availableBundledPath];

  const commands = uniqueCommands(candidates.filter((item): item is string => Boolean(item)));
  return [commands[0] ?? "ffprobe", ...commands.slice(1)];
}

/** 查找指定媒体工具的内置平台二进制。 */
function resolveBundledMediaBinary(
  tool: "ffmpeg" | "ffprobe",
  options: FfmpegBinaryResolverOptions
): string | undefined {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const roots = options.resourceRoots ?? getDefaultFfmpegResourceRoots();
  const binaryName = platform === "win32" ? `${tool}.exe` : tool;

  for (const root of roots) {
    for (const platformDirectory of [`${platform}-${arch}`, platform]) {
      const binaryPath = join(root, platformDirectory, binaryName);
      if (existsSync(binaryPath)) {
        return binaryPath;
      }
    }
  }

  return undefined;
}

/** 按内置资源、用户配置同目录和系统 PATH 顺序解析 FFmpeg 命令。 */
export function resolveFfmpegCommand(options: FfmpegCommandResolverOptions): string {
  const platform = options.platform ?? process.platform;
  const bundledPath = options.bundledFfmpegPath === undefined
    ? resolveBundledFfmpegBinary(options)
    : options.bundledFfmpegPath ?? undefined;
  if (bundledPath && existsSync(bundledPath)) {
    return bundledPath;
  }

  const normalizedFfprobePath = options.ffprobePath.trim();
  if (normalizedFfprobePath.includes("/") || normalizedFfprobePath.includes("\\")) {
    const configuredPath = join(
      dirname(normalizedFfprobePath),
      platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
    );
    if (existsSync(configuredPath)) {
      return configuredPath;
    }
  }

  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/** 返回开发、预览和正式打包环境可用的 FFmpeg 资源根目录。 */
function getDefaultFfmpegResourceRoots(): string[] {
  const processWithResourcesPath = process as NodeJS.Process & { resourcesPath?: string };
  return unique([
    processWithResourcesPath.resourcesPath
      ? join(processWithResourcesPath.resourcesPath, "ffmpeg")
      : undefined,
    join(process.cwd(), "out", "ffmpeg"),
    join(process.cwd(), "resources", "ffmpeg")
  ].filter((item): item is string => Boolean(item)));
}

/** 保留目录优先级并移除重复路径。 */
function unique(paths: string[]): string[] {
  const normalized = paths.map((path) => isAbsolute(path) ? path : resolve(path));
  return [...new Set(normalized)];
}

/** 判断配置值是否仍是默认系统命令。 */
function isDefaultFfprobeCommand(command: string, platform: NodeJS.Platform): boolean {
  const normalized = command.toLowerCase();
  return normalized === "ffprobe" || (platform === "win32" && normalized === "ffprobe.exe");
}

/** 保留候选命令优先级并移除重复项。 */
function uniqueCommands(commands: string[]): string[] {
  return [...new Set(commands)];
}
