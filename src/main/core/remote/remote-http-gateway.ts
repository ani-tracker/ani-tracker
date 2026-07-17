import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Socket } from "node:net";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { RemoteGatewayStatus, RemotePairingChallenge } from "@shared/contracts";
import { logger } from "../logger";
import { RemoteDeviceAuth, RemoteDeviceAuthError } from "./remote-device-auth";
import { RemoteRpcDispatcher, RemoteRpcError } from "./remote-rpc-dispatcher";
import type { RemoteMethodRegistry, RemoteRpcEffect, RemoteRpcScope } from "./remote-method-registry";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18_083;
const MAX_BODY_BYTES = 64 * 1024;
const ALL_REMOTE_SCOPES: RemoteRpcScope[] = [
  "dashboard.read",
  "notifications.read",
  "notifications.write",
  "library.read",
  "catalog.read",
  "downloads.read",
  "downloads.control"
];

export interface RemoteHttpGatewayOptions {
  host?: string;
  port?: number;
  rendererDirectory?: string;
  auth?: RemoteDeviceAuth;
  clock?: () => number;
}

interface RateLimitEntry {
  windowStartedAt: number;
  count: number;
}

interface PathBoundaryOperations {
  readonly sep: string;
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
}

export class RemoteHttpGateway {
  private readonly host: string;
  private readonly configuredPort: number;
  private readonly rendererDirectory?: string;
  private readonly auth: RemoteDeviceAuth;
  private readonly clock: () => number;
  private readonly dispatcher: RemoteRpcDispatcher;
  private readonly rateLimits = new Map<string, RateLimitEntry>();
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private stopping: Promise<void> | undefined;
  private activePort: number;
  private lastError: string | undefined;

  /** 创建仅监听回环地址的远程网关，局域网监听留待 HTTPS 阶段。 */
  constructor(
    private readonly registry: RemoteMethodRegistry,
    options: RemoteHttpGatewayOptions = {}
  ) {
    this.host = options.host ?? DEFAULT_HOST;
    if (this.host !== DEFAULT_HOST) {
      throw new Error("当前阶段远程网关只允许监听 127.0.0.1");
    }
    this.configuredPort = options.port ?? DEFAULT_PORT;
    this.activePort = this.configuredPort;
    this.rendererDirectory = options.rendererDirectory ? resolve(options.rendererDirectory) : undefined;
    this.auth = options.auth ?? new RemoteDeviceAuth();
    this.clock = options.clock ?? Date.now;
    this.dispatcher = new RemoteRpcDispatcher(registry);
  }

  /** 启动 HTTP 网关；重复启动直接返回当前状态。 */
  async start(): Promise<RemoteGatewayStatus> {
    if (this.stopping) {
      await this.stopping;
    }
    if (this.server) {
      return this.getStatus();
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      const handleError = (error: Error) => {
        server.off("listening", handleListening);
        rejectStart(error);
      };
      const handleListening = () => {
        server.off("error", handleError);
        resolveStart();
      };
      server.once("error", handleError);
      server.once("listening", handleListening);
      server.listen(this.configuredPort, this.host);
    });
    const address = server.address();
    this.activePort = typeof address === "object" && address ? address.port : this.configuredPort;
    this.server = server;
    this.lastError = undefined;
    logger.info("Remote HTTP gateway started", { host: this.host, port: this.activePort });
    return this.getStatus();
  }

  /** 停止接收远程请求并等待已有连接关闭。 */
  async stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    const stopping = new Promise<void>((resolveStop, rejectStop) => {
      server.close((error) => {
        if (error) {
          rejectStop(error);
          return;
        }
        resolveStop();
      });
      server.closeIdleConnections();
      server.closeAllConnections();
      for (const socket of this.sockets) {
        socket.destroy();
      }
    });
    this.stopping = stopping;
    try {
      await stopping;
      this.rateLimits.clear();
      logger.info("Remote HTTP gateway stopped", { host: this.host, port: this.activePort });
    } finally {
      if (this.stopping === stopping) {
        this.stopping = undefined;
      }
    }
  }

  /** 记录启动失败但不让远程能力拖垮桌面应用。 */
  setStartupError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : "远程服务启动失败";
    logger.warn("Remote HTTP gateway unavailable", { errorType: error instanceof Error ? error.name : typeof error });
  }

  /** 返回桌面设置页可展示的网关与设备状态。 */
  getStatus(): RemoteGatewayStatus {
    return {
      running: Boolean(this.server),
      host: this.host,
      port: this.activePort,
      baseUrl: `http://${this.host}:${this.activePort}`,
      devices: this.auth.listDevices(),
      lastError: this.lastError
    };
  }

  /** 创建桌面端展示的两分钟一次性配对码。 */
  createPairingCode(): RemotePairingChallenge {
    return this.auth.createPairingCode();
  }

  /** 吊销设备并返回最新状态。 */
  revokeDevice(deviceId: string): RemoteGatewayStatus {
    this.auth.revoke(deviceId);
    return this.getStatus();
  }

  /** 按路径分发健康检查、配对、RPC 与同源 PWA 静态资源。 */
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const startedAt = this.clock();
    const remoteAddress = request.socket.remoteAddress;
    try {
      this.validateHostAndOrigin(request);
      const url = new URL(request.url ?? "/", this.getStatus().baseUrl);
      if (request.method === "GET" && url.pathname === "/api/health") {
        this.writeJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/pair") {
        await this.handlePairing(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/rpc") {
        await this.handleRpc(request, response, requestId);
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        this.serveRenderer(url.pathname, request.method === "HEAD", response);
        return;
      }
      this.writeError(response, 404, "NOT_FOUND", "请求路径不存在");
    } catch (error) {
      this.handleError(error, response);
    } finally {
      logger.info("Remote HTTP request completed", {
        requestId,
        method: request.method,
        statusCode: response.statusCode,
        elapsedMs: this.clock() - startedAt,
        remoteAddress
      });
    }
  }

  /** 校验 Host 与同源 Origin，阻止 DNS rebinding 和跨站浏览器调用。 */
  private validateHostAndOrigin(request: IncomingMessage): void {
    const allowedHosts = new Set([`${this.host}:${this.activePort}`, `localhost:${this.activePort}`]);
    const host = request.headers.host;
    if (!host || !allowedHosts.has(host.toLowerCase())) {
      throw new HttpGatewayError(403, "HOST_FORBIDDEN", "请求 Host 不受信任");
    }
    const origin = request.headers.origin;
    if (origin) {
      const allowedOrigins = new Set([...allowedHosts].map((value) => `http://${value}`));
      if (!allowedOrigins.has(origin.toLowerCase())) {
        throw new HttpGatewayError(403, "ORIGIN_FORBIDDEN", "请求 Origin 不受信任");
      }
    }
  }

  /** 使用服务端固定 scopes 完成设备配对，客户端不能自行提权。 */
  private async handlePairing(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const clientKey = `pair:${request.socket.remoteAddress ?? "unknown"}`;
    this.consumeRateLimit(clientKey, 5, 10 * 60 * 1000);
    const body = requireObject(await readJsonBody(request));
    assertOnlyKeys(body, ["code", "deviceName"]);
    if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
      throw new HttpGatewayError(400, "PAIRING_CODE_INVALID", "配对码格式无效");
    }
    if (typeof body.deviceName !== "string" || body.deviceName.trim().length > 80) {
      throw new HttpGatewayError(400, "DEVICE_NAME_INVALID", "设备名称格式无效");
    }
    const result = this.auth.pairDevice(body.code, body.deviceName, ALL_REMOTE_SCOPES);
    this.writeJson(response, 200, result);
  }

  /** 验证 Bearer 令牌、限流后调用显式 RPC dispatcher。 */
  private async handleRpc(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const token = parseBearerToken(request.headers.authorization);
    const device = token ? this.auth.authenticate(token) : undefined;
    if (!device) {
      throw new HttpGatewayError(401, "UNAUTHORIZED", "设备未配对或令牌已失效");
    }
    const body = await readJsonBody(request);
    const method = requireObject(body).method;
    const definition = typeof method === "string" ? this.registry.get(method) : undefined;
    const effect: RemoteRpcEffect = definition?.effect ?? "read";
    this.consumeRateLimit(
      `rpc:${device.id}:${effect}`,
      effect === "write" ? 30 : 120,
      60 * 1000
    );
    const result = await this.dispatcher.dispatch(body, {
      grantedScopes: device.scopes as RemoteRpcScope[],
      clientId: device.id,
      requestId
    });
    this.writeJson(response, 200, { result });
  }

  /** 同源提供构建后的 PWA，所有未知前端路由回退 index.html。 */
  private serveRenderer(pathname: string, headOnly: boolean, response: ServerResponse): void {
    if (!this.rendererDirectory || !existsSync(this.rendererDirectory)) {
      throw new HttpGatewayError(404, "PWA_NOT_BUILT", "PWA 静态资源尚未构建");
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpGatewayError(400, "PATH_INVALID", "静态资源路径编码无效");
    }
    if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) {
      throw new HttpGatewayError(403, "PATH_FORBIDDEN", "静态资源路径无效");
    }
    const rendererRoot = realpathSync(this.rendererDirectory);
    const relativePath = normalize(decoded).replace(/^([/\\])+/, "");
    const candidate = resolve(rendererRoot, relativePath || "index.html");
    if (!isPathInsideDirectory(rendererRoot, candidate)) {
      throw new HttpGatewayError(403, "PATH_FORBIDDEN", "静态资源路径无效");
    }
    const selectedPath = existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(rendererRoot, "index.html");
    if (!existsSync(selectedPath) || !statSync(selectedPath).isFile()) {
      throw new HttpGatewayError(404, "PWA_NOT_BUILT", "PWA 静态资源尚未构建");
    }
    const filePath = realpathSync(selectedPath);
    if (!isPathInsideDirectory(rendererRoot, filePath)) {
      throw new HttpGatewayError(403, "PATH_FORBIDDEN", "静态资源路径无效");
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", getContentType(filePath));
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (headOnly) {
      response.end();
      return;
    }
    const stream = createReadStream(filePath);
    stream.on("error", (error) => {
      logger.warn("Remote PWA asset read failed", {
        errorType: error.name,
        statusCode: response.headersSent ? response.statusCode : 404
      });
      if (!response.headersSent) {
        this.writeError(response, 404, "ASSET_NOT_FOUND", "静态资源不可用");
      } else {
        response.destroy(error);
      }
    });
    stream.pipe(response);
  }

  /** 执行固定窗口限流，并定期替换过期计数。 */
  private consumeRateLimit(key: string, limit: number, windowMs: number): void {
    const now = this.clock();
    const current = this.rateLimits.get(key);
    if (!current || now - current.windowStartedAt >= windowMs) {
      this.rateLimits.set(key, { windowStartedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      throw new HttpGatewayError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试");
    }
  }

  /** 输出 JSON 并统一禁止缓存敏感响应。 */
  private writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(payload));
  }

  /** 输出稳定错误码，不返回内部异常与堆栈。 */
  private writeError(response: ServerResponse, statusCode: number, code: string, message: string): void {
    this.writeJson(response, statusCode, { error: message, code });
  }

  /** 将内部错误转换为有限的远程协议错误。 */
  private handleError(error: unknown, response: ServerResponse): void {
    if (error instanceof HttpGatewayError) {
      this.writeError(response, error.statusCode, error.code, error.message);
      return;
    }
    if (error instanceof RemoteRpcError) {
      this.writeError(response, error.statusCode, error.code, error.message);
      return;
    }
    if (error instanceof RemoteDeviceAuthError) {
      this.writeError(response, 400, error.code, "配对请求失败");
      return;
    }
    logger.error("Remote HTTP request failed", { errorType: error instanceof Error ? error.name : typeof error });
    this.writeError(response, 500, "INTERNAL_ERROR", "远程服务内部错误");
  }
}

class HttpGatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "HttpGatewayError";
  }
}

/** 读取受 64KB 限制的 JSON 请求体。 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpGatewayError(413, "BODY_TOO_LARGE", "请求体超过 64KB 限制");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpGatewayError(400, "INVALID_JSON", "请求体不是有效 JSON");
  }
}

/** 校验请求对象。 */
function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpGatewayError(400, "INVALID_REQUEST", "请求格式无效");
  }
  return value as Record<string, unknown>;
}

/** 拒绝未声明的配对字段。 */
function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): void {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new HttpGatewayError(400, "INVALID_REQUEST", "请求包含未知字段");
  }
}

/** 从 Authorization 请求头提取 Bearer 令牌。 */
function parseBearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]{40,80})$/);
  return match?.[1];
}

/** 返回 PWA 静态资源 MIME 类型。 */
function getContentType(filePath: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
  };
  return types[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** 使用目标平台的路径规则判断文件是否位于静态资源目录内。 */
export function isPathInsideDirectory(
  rootDirectory: string,
  candidatePath: string,
  operations: PathBoundaryOperations = { isAbsolute, relative, sep }
): boolean {
  const relativePath = operations.relative(rootDirectory, candidatePath);
  return (
    relativePath === "" ||
    (!operations.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${operations.sep}`))
  );
}
