import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../logger";

export interface PlaybackProgressEvent {
  filePath: string;
  percent: number;
}

export type PlaybackProgressListener = (event: PlaybackProgressEvent) => void | Promise<void>;

/** 定义播放器进度监控器的启动参数和监听能力。 */
export interface PlaybackMonitor {
  launchArguments: string[];
  start(listener: PlaybackProgressListener): Promise<void>;
}

/** 通过 mpv JSON IPC 监听 IINA 或 mpv 的 percent-pos 属性。 */
export class MpvJsonIpcPlaybackMonitor implements PlaybackMonitor {
  readonly launchArguments: string[];

  constructor(
    private readonly filePath: string,
    launchArgumentName = "--mpv-input-ipc-server",
    private readonly endpoint = createPlaybackEndpoint(),
    private readonly connectAttempts = 40,
    private readonly retryDelayMs = 250
  ) {
    this.launchArguments = [`${launchArgumentName}=${this.endpoint}`];
  }

  /** 连接播放器 IPC，订阅进度事件并在会话结束后清理端点。 */
  async start(listener: PlaybackProgressListener): Promise<void> {
    try {
      const socket = await this.connect();
      logger.info("mpv JSON IPC playback monitor connected", { endpoint: this.endpoint, filePath: this.filePath });
      await this.observeProgress(socket, listener);
    } finally {
      await unlink(this.endpoint).catch(() => undefined);
    }
  }

  /** 在播放器创建 IPC 端点期间进行有限次数重试。 */
  private async connect(): Promise<Socket> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.connectAttempts; attempt += 1) {
      try {
        return await connectToEndpoint(this.endpoint);
      } catch (error) {
        lastError = error;
        if (attempt < this.connectAttempts) {
          await delay(this.retryDelayMs);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("mpv JSON IPC 播放进度监控连接失败");
  }

  /** 解析换行分隔的 mpv JSON 消息并转发进度变化。 */
  private async observeProgress(socket: Socket, listener: PlaybackProgressListener): Promise<void> {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.write(`${JSON.stringify({ command: ["observe_property", 1, "percent-pos"] })}\n`);

    await new Promise<void>((resolve, reject) => {
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseMpvProgressEvent(line, this.filePath);
          if (event) {
            void Promise.resolve(listener(event)).catch((error) => {
              logger.warn("Playback progress listener failed", {
                message: error instanceof Error ? error.message : String(error),
                filePath: this.filePath
              });
            });
          }
        }
      });
      socket.once("end", resolve);
      socket.once("close", resolve);
      socket.once("error", reject);
    });
  }
}

/** 通过 Windows GSMTC 读取 PotPlayer 的系统媒体时间线。 */
export class WindowsGsmtcPlaybackMonitor implements PlaybackMonitor {
  readonly launchArguments: string[] = [];

  constructor(private readonly filePath: string) {}

  /** 启动 PowerShell WinRT 监听，并转发 PotPlayer 播放百分比。 */
  async start(listener: PlaybackProgressListener): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("GSMTC 播放进度监控仅支持 Windows");
    }

    const encodedScript = Buffer.from(createGsmtcMonitorScript(), "utf16le").toString("base64");
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedScript
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const handleProcessExit = () => child.kill();
    process.once("exit", handleProcessExit);
    logger.info("PotPlayer GSMTC playback monitor started", { filePath: this.filePath });

    try {
      await observeGsmtcProcess(child, this.filePath, listener);
    } finally {
      process.off("exit", handleProcessExit);
      if (!child.killed) {
        child.kill();
      }
    }
  }
}

/** 将 mpv property-change 消息转换为应用播放进度事件。 */
export function parseMpvProgressEvent(line: string, filePath: string): PlaybackProgressEvent | undefined {
  try {
    const message = JSON.parse(line) as { event?: string; name?: string; data?: unknown };
    if (message.event !== "property-change" || message.name !== "percent-pos" || typeof message.data !== "number") {
      return undefined;
    }
    return {
      filePath,
      percent: Math.max(0, Math.min(100, message.data))
    };
  } catch {
    return undefined;
  }
}

/** 将 GSMTC 监控输出转换为应用播放进度事件。 */
export function parseGsmtcProgressEvent(line: string, filePath: string): PlaybackProgressEvent | undefined {
  try {
    const message = JSON.parse(line) as { percent?: unknown };
    if (typeof message.percent !== "number" || !Number.isFinite(message.percent)) {
      return undefined;
    }
    return {
      filePath,
      percent: Math.max(0, Math.min(100, message.percent))
    };
  } catch {
    return undefined;
  }
}

/** 解析 PowerShell 行输出并等待 GSMTC 监控进程结束。 */
function observeGsmtcProcess(
  child: ReturnType<typeof spawn>,
  filePath: string,
  listener: PlaybackProgressListener
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseGsmtcProgressEvent(line.trim(), filePath);
        if (event) {
          void Promise.resolve(listener(event)).catch((error) => {
            logger.warn("PotPlayer playback progress listener failed", {
              filePath,
              message: error instanceof Error ? error.message : String(error)
            });
          });
        }
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || child.killed) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `PotPlayer GSMTC 监控异常退出：${code ?? "unknown"}`));
    });
  });
}

/** 创建使用 WinRT GSMTC API 轮询 PotPlayer 时间线的 PowerShell 脚本。 */
function createGsmtcMonitorScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1
function Await-WinRt($operation, [Type]$resultType) {
  $task = $asTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$seenSession = $false
$missingCount = 0
for ($attempt = 0; $attempt -lt 14400; $attempt++) {
  $session = @($manager.GetSessions()) |
    Where-Object { $_.SourceAppUserModelId -match '(?i)potplayer' } |
    Select-Object -First 1
  if ($null -eq $session) {
    if ($seenSession) {
      $missingCount++
      if ($missingCount -ge 5) { break }
    }
    Start-Sleep -Seconds 2
    continue
  }
  $seenSession = $true
  $missingCount = 0
  $timeline = $session.GetTimelineProperties()
  $duration = ($timeline.EndTime - $timeline.StartTime).TotalSeconds
  if ($duration -gt 0) {
    $position = ($timeline.Position - $timeline.StartTime).TotalSeconds
    $percent = [Math]::Max(0, [Math]::Min(100, $position / $duration * 100))
    [Console]::Out.WriteLine((@{ percent = $percent } | ConvertTo-Json -Compress))
  }
  Start-Sleep -Seconds 2
}
`;
}

/** 创建长度受控的本地 IPC 地址，避免超过 Unix Socket 路径限制。 */
function createPlaybackEndpoint(): string {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  return process.platform === "win32" ? `\\\\.\\pipe\\ani-playback-${id}` : join(tmpdir(), `ani-playback-${id}.sock`);
}

/** 建立到 Unix Socket 或 Windows Named Pipe 的连接。 */
function connectToEndpoint(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const handleError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", handleError);
    socket.once("connect", () => {
      socket.off("error", handleError);
      resolve(socket);
    });
  });
}

/** 等待下一次 IPC 连接重试。 */
function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
