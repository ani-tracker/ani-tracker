import { existsSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { PlayerDetectionCandidate, PlayerDetectionResult, PlayerRuntimePlatform } from "@shared/contracts";
import type { AppSettings, PlayerProfile } from "@shared/domain";
import { logger } from "../logger";

type IsFile = (path: string) => boolean;

export interface PlayerDetectionServiceOptions {
  platform?: NodeJS.Platform;
  pathEntries?: string[];
  isFile?: IsFile;
  knownPaths?: Record<string, string[]>;
}

const WINDOWS_KNOWN_PATHS: Record<string, string[]> = {
  "pure-codec-potplayer": ["C:\\Program Files\\Pure Codec\\x64\\PotPlayerMini64.exe"],
  potplayer: ["C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe"],
  mpv: ["C:\\Program Files\\mpv\\mpv.exe"]
};

/** 按当前操作系统探测播放器路径，并为自动播放选择首个可用项。 */
export class PlayerDetectionService {
  private readonly platform: NodeJS.Platform;
  private readonly pathEntries: string[];
  private readonly isFile: IsFile;
  private readonly knownPaths: Record<string, string[]>;

  constructor(options: PlayerDetectionServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    const pathDelimiter = this.platform === "win32" ? win32.delimiter : posix.delimiter;
    this.pathEntries = options.pathEntries ?? (process.env.PATH ?? "").split(pathDelimiter).filter(Boolean);
    this.isFile = options.isFile ?? isExistingFile;
    this.knownPaths = options.knownPaths ?? WINDOWS_KNOWN_PATHS;
  }

  /** 返回当前平台可配置的播放器及实际可用路径。 */
  detect(profiles: PlayerProfile[]): PlayerDetectionResult {
    const candidates = profiles
      .filter((profile) => supportsPlatform(profile, this.platform))
      .map((profile) => this.detectProfile(profile));
    const detected = candidates.find((candidate) => candidate.available);
    const result: PlayerDetectionResult = {
      platform: toRuntimePlatform(this.platform),
      candidates,
      detectedProfileId: detected?.profileId,
      detectedExecutablePath: detected?.resolvedPath
    };

    logger.info("Player detection completed", {
      platform: result.platform,
      candidateCount: candidates.length,
      detectedProfileId: result.detectedProfileId
    });
    return result;
  }

  /** 解析自动或手动选择的播放器，缺失时返回面向用户的设置提示。 */
  resolve(settings: AppSettings, profileId?: string): PlayerProfile {
    const targetId = profileId ?? settings.defaultPlayerProfileId ?? "auto";
    const result = this.detect(settings.players);
    const candidate = targetId === "auto"
      ? result.candidates.find((item) => item.available)
      : result.candidates.find((item) => item.profileId === targetId);

    if (!candidate?.available || !candidate.resolvedPath) {
      const targetName = targetId === "auto"
        ? "可用播放器"
        : settings.players.find((profile) => profile.id === targetId)?.name ?? targetId;
      throw new Error(`未找到${targetName}，请前往“设置 > 播放器配置”选择播放器或设置可执行文件路径。`);
    }

    const profile = settings.players.find((item) => item.id === candidate.profileId);
    if (!profile) {
      throw new Error("播放器配置不存在，请前往“设置 > 播放器配置”重新选择。");
    }
    return { ...profile, executablePath: candidate.resolvedPath };
  }

  /** 依次检查用户路径、平台已知路径和 PATH 环境变量。 */
  private detectProfile(profile: PlayerProfile): PlayerDetectionCandidate {
    const resolvedPath = uniquePaths([
      ...this.resolveConfiguredPath(profile.executablePath),
      ...(this.platform === "win32" ? this.knownPaths[profile.id] ?? [] : []),
      ...(profile.id === "mpv" ? this.resolveConfiguredPath("mpv") : [])
    ]).find((path) => this.isFile(path));

    return {
      profileId: profile.id,
      name: profile.name,
      configuredPath: profile.executablePath,
      available: Boolean(resolvedPath),
      resolvedPath
    };
  }

  /** 将绝对路径或命令名展开为可验证的文件候选。 */
  private resolveConfiguredPath(executablePath: string): string[] {
    const value = executablePath.trim().replace(/^"|"$/g, "");
    if (!value) {
      return [];
    }
    const pathApi = this.platform === "win32" ? win32 : posix;
    if (pathApi.isAbsolute(value)) {
      return [value];
    }

    const names = this.platform === "win32" && !pathApi.extname(value) ? [value, `${value}.exe`] : [value];
    return this.pathEntries.flatMap((entry) => names.map((name) => pathApi.join(entry, name)));
  }
}

/** 判断路径是否指向普通文件。 */
function isExistingFile(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 判断播放器配置是否适用于当前平台。 */
function supportsPlatform(profile: PlayerProfile, platform: NodeJS.Platform): boolean {
  if (profile.platform === "any") {
    return true;
  }
  return profile.platform === toRuntimePlatform(platform);
}

/** 将 Node 平台标识转换为渲染端稳定枚举。 */
function toRuntimePlatform(platform: NodeJS.Platform): PlayerRuntimePlatform {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "other";
}

/** 去除重复路径并保持探测优先级。 */
function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}
