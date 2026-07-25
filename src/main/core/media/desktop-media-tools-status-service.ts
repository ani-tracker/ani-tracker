import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DesktopMediaToolsStatus, MediaToolStatus } from "@shared/contracts";
import { resolveFfmpegCommand, resolveFfprobeCommands } from "./ffmpeg-binary-resolver";

const execFileAsync = promisify(execFile);

/** 读取 Electron 共存期桌面 FFprobe 与 FFmpeg 的解析和版本状态。 */
export async function getDesktopMediaToolsStatus(ffprobePath: string): Promise<DesktopMediaToolsStatus> {
  const ffprobeCommands = resolveFfprobeCommands({ configuredPath: ffprobePath });
  const ffmpegCommands = [resolveFfmpegCommand({ ffprobePath })];
  const [ffprobe, ffmpeg] = await Promise.all([
    inspectMediaTool(ffprobeCommands),
    inspectMediaTool(ffmpegCommands)
  ]);
  return { ffprobe, ffmpeg };
}

/** 依次检查候选命令，并返回首个有效版本。 */
async function inspectMediaTool(commands: string[]): Promise<MediaToolStatus> {
  let lastError = "没有可用命令";
  for (const command of [...new Set(commands)]) {
    try {
      const { stdout, stderr } = await execFileAsync(command, ["-version"], {
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      const version = String(stdout || stderr).split(/\r?\n/, 1)[0]?.trim();
      return {
        available: true,
        command,
        version: version || undefined
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    available: false,
    error: lastError
  };
}
