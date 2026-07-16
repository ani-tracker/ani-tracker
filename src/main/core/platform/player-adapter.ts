import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { PlayerProfile } from "@shared/domain";
import { logger } from "../logger";
import {
  MpvJsonIpcPlaybackMonitor,
  type PlaybackMonitor,
  type PlaybackProgressListener
} from "./playback-monitor";

/** 定义单类播放器的匹配、参数构造和启动能力。 */
export interface PlayerAdapter {
  supports(profile: PlayerProfile): boolean;
  buildArguments(profile: PlayerProfile, filePath: string): string[];
  createPlaybackMonitor(profile: PlayerProfile, filePath: string): PlaybackMonitor | undefined;
  play(profile: PlayerProfile, filePath: string, listener?: PlaybackProgressListener): Promise<void>;
}

/** 复用播放器进程启动流程，子类只处理识别和差异化参数。 */
export abstract class BasePlayerAdapter implements PlayerAdapter {
  abstract supports(profile: PlayerProfile): boolean;
  abstract createPlaybackMonitor(profile: PlayerProfile, filePath: string): PlaybackMonitor | undefined;

  /** 按用户配置的参数模板生成进程参数。 */
  buildArguments(profile: PlayerProfile, filePath: string): string[] {
    return parsePlayerArguments(profile.argumentTemplate, filePath);
  }

  /** 启动播放器并等待操作系统确认进程创建成功。 */
  async play(profile: PlayerProfile, filePath: string, listener?: PlaybackProgressListener): Promise<void> {
    const monitor = listener ? this.createPlaybackMonitor(profile, filePath) : undefined;
    const args = [...(monitor?.launchArguments ?? []), ...this.buildArguments(profile, filePath)];
    const child = spawn(profile.executablePath, args, {
      detached: true,
      stdio: "ignore"
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    logger.info("Media player launched", {
      adapter: this.constructor.name,
      profileId: profile.id,
      filePath
    });
    if (monitor && listener) {
      void monitor.start(listener).catch((error) => {
        logger.warn("Playback progress monitor stopped", {
          adapter: this.constructor.name,
          message: error instanceof Error ? error.message : String(error),
          filePath
        });
      });
    } else if (listener) {
      logger.info("Playback progress monitoring unsupported", {
        adapter: this.constructor.name,
        profileId: profile.id
      });
    }
  }
}

/** 适配 IINA CLI，并关闭会干扰本地文件播放的标准输入探测。 */
export class IinaPlayerAdapter extends BasePlayerAdapter {
  supports(profile: PlayerProfile): boolean {
    return profile.id.toLowerCase() === "iina" || executableName(profile) === "iina-cli";
  }

  buildArguments(profile: PlayerProfile, filePath: string): string[] {
    const args = super.buildArguments(profile, filePath);
    return args.some((argument) => argument === "--stdin" || argument === "--no-stdin")
      ? args
      : ["--no-stdin", ...args];
  }

  /** 为 IINA 播放会话创建 mpv JSON IPC 监控器。 */
  createPlaybackMonitor(_profile: PlayerProfile, filePath: string): PlaybackMonitor {
    return new MpvJsonIpcPlaybackMonitor(filePath);
  }
}

/** 适配 Windows PotPlayer 播放器配置。 */
export class PotPlayerAdapter extends BasePlayerAdapter {
  supports(profile: PlayerProfile): boolean {
    return profile.id.toLowerCase() === "potplayer" || executableName(profile).includes("potplayer");
  }

  /** Windows 播放状态监控暂未实现，后续通过相同抽象扩展。 */
  createPlaybackMonitor(): undefined {
    return undefined;
  }
}

/** 适配跨平台 mpv 播放器配置。 */
export class MpvPlayerAdapter extends BasePlayerAdapter {
  supports(profile: PlayerProfile): boolean {
    return profile.id.toLowerCase() === "mpv" || ["mpv", "mpv.exe"].includes(executableName(profile));
  }

  /** 独立 mpv 监控将在后续跨平台阶段接入。 */
  createPlaybackMonitor(): undefined {
    return undefined;
  }
}

/** 承接用户自定义的其他播放器配置。 */
export class GenericPlayerAdapter extends BasePlayerAdapter {
  supports(): boolean {
    return true;
  }

  /** 自定义播放器默认不声明进度监控能力。 */
  createPlaybackMonitor(): undefined {
    return undefined;
  }
}

/** 按顺序选择播放器子类，通用实现始终作为兜底。 */
export class PlayerAdapterFactory {
  constructor(
    private readonly adapters: PlayerAdapter[] = [
      new IinaPlayerAdapter(),
      new PotPlayerAdapter(),
      new MpvPlayerAdapter(),
      new GenericPlayerAdapter()
    ]
  ) {}

  /** 返回首个支持当前播放器配置的实现。 */
  resolve(profile: PlayerProfile): PlayerAdapter {
    const adapter = this.adapters.find((candidate) => candidate.supports(profile));
    if (!adapter) {
      throw new Error(`未找到播放器适配器：${profile.name}`);
    }
    return adapter;
  }
}

/** 将参数模板解析成 spawn 可直接使用的参数数组。 */
export function parsePlayerArguments(template: string, filePath: string): string[] {
  const rendered = template.replaceAll("{file}", filePath);
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(rendered))) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

/** 读取播放器可执行文件名用于适配器匹配。 */
function executableName(profile: PlayerProfile): string {
  return basename(profile.executablePath).toLowerCase();
}
