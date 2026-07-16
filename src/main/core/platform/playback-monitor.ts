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

/** 通过 mpv JSON IPC 监听 IINA 的 percent-pos 属性。 */
export class MpvJsonIpcPlaybackMonitor implements PlaybackMonitor {
  readonly launchArguments: string[];

  constructor(
    private readonly filePath: string,
    private readonly endpoint = createPlaybackEndpoint(),
    private readonly connectAttempts = 40,
    private readonly retryDelayMs = 250
  ) {
    this.launchArguments = [`--mpv-input-ipc-server=${this.endpoint}`];
  }

  /** 连接播放器 IPC，订阅进度事件并在会话结束后清理端点。 */
  async start(listener: PlaybackProgressListener): Promise<void> {
    try {
      const socket = await this.connect();
      logger.info("IINA playback monitor connected", { endpoint: this.endpoint, filePath: this.filePath });
      await this.observeProgress(socket, listener);
    } finally {
      await unlink(this.endpoint).catch(() => undefined);
    }
  }

  /** 在 IINA 创建 IPC 端点期间进行有限次数重试。 */
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
    throw lastError instanceof Error ? lastError : new Error("IINA 播放进度监控连接失败");
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

/** 创建长度受控的本地 IPC 地址，避免超过 Unix Socket 路径限制。 */
function createPlaybackEndpoint(): string {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  return process.platform === "win32" ? `\\\\.\\pipe\\ani-iina-${id}` : join(tmpdir(), `ani-iina-${id}.sock`);
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
