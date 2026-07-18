import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type Socket } from "node:net";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { RemoteDeviceInfo, RemoteGatewayStatus, RemotePairingChallenge } from "@shared/contracts";
import type { RemoteAccessSettings } from "@shared/domain";
import { logger } from "../logger";
import { RemoteDeviceAuth, RemoteDeviceAuthError } from "./remote-device-auth";
import { RemoteRpcDispatcher, RemoteRpcError } from "./remote-rpc-dispatcher";
import { RemoteMediaSessionError, type RemoteMediaSessionService } from "./remote-media-session-service";
import type { RemoteMethodRegistry, RemoteRpcEffect, RemoteRpcScope } from "./remote-method-registry";
import {
  isTrustedHost,
  isTrustedOrigin,
  listPrivateIpv4Addresses,
  normalizePrivateIpv4Addresses
} from "./remote-network-policy";
import type { RemoteTlsCertificateBundle, RemoteTlsCertificateStore } from "./remote-tls-certificate-store";

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
  tlsCertificateStore?: RemoteTlsCertificateStore;
  privateAddressProvider?: () => string[];
  mediaSessionService?: RemoteMediaSessionService;
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
  private host: string;
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
  private protocol: "http" | "https" = "http";
  private lanEnabled = false;
  private addresses: string[] = [];
  private certificate: RemoteTlsCertificateBundle | undefined;
  private lastError: string | undefined;
  private readonly tlsCertificateStore?: RemoteTlsCertificateStore;
  private readonly privateAddressProvider: () => string[];
  private readonly mediaSessionService?: RemoteMediaSessionService;

  /** 创建默认仅监听回环地址的远程网关。 */
  constructor(
    private readonly registry: RemoteMethodRegistry,
    options: RemoteHttpGatewayOptions = {}
  ) {
    this.host = options.host ?? DEFAULT_HOST;
    if (this.host !== DEFAULT_HOST) {
      throw new Error("HTTP 远程网关只允许监听 127.0.0.1");
    }
    this.configuredPort = options.port ?? DEFAULT_PORT;
    this.activePort = this.configuredPort;
    this.rendererDirectory = options.rendererDirectory ? resolve(options.rendererDirectory) : undefined;
    this.auth = options.auth ?? new RemoteDeviceAuth();
    this.clock = options.clock ?? Date.now;
    this.tlsCertificateStore = options.tlsCertificateStore;
    this.privateAddressProvider = options.privateAddressProvider ?? listPrivateIpv4Addresses;
    this.mediaSessionService = options.mediaSessionService;
    this.dispatcher = new RemoteRpcDispatcher(registry);
  }

  /** 启动 HTTP 网关；重复启动直接返回当前状态。 */
  async start(): Promise<RemoteGatewayStatus> {
    return this.startServer({
      host: this.host,
      port: this.configuredPort,
      protocol: "http",
      addresses: []
    });
  }

  /** 按设置切换回环 HTTP 或局域网 HTTPS；失败时恢复回环服务。 */
  async applySettings(settings: RemoteAccessSettings): Promise<RemoteGatewayStatus> {
    const port = normalizeGatewayPort(settings.port);
    await this.stop();
    if (!settings.lanEnabled) {
      return this.startServer({ host: DEFAULT_HOST, port, protocol: "http", addresses: [] });
    }

    try {
      const addresses = normalizePrivateIpv4Addresses(this.privateAddressProvider());
      if (!addresses.length) {
        throw new Error("未发现可用的局域网 IPv4 地址");
      }
      if (!this.tlsCertificateStore) {
        throw new Error("局域网 HTTPS 证书仓库未初始化");
      }
      const certificate = await this.tlsCertificateStore.loadOrCreate(addresses);
      return await this.startServer({
        host: "0.0.0.0",
        port,
        protocol: "https",
        addresses,
        certificate
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "局域网 HTTPS 启动失败";
      logger.warn("Remote LAN HTTPS unavailable; restoring loopback gateway", {
        errorType: error instanceof Error ? error.name : typeof error,
        message
      });
      const fallback = await this.startServer({ host: DEFAULT_HOST, port, protocol: "http", addresses: [] });
      this.lastError = message;
      return { ...fallback, lastError: message };
    }
  }

  /** 使用指定协议和监听地址启动网关。 */
  private async startServer(input: {
    host: string;
    port: number;
    protocol: "http" | "https";
    addresses: string[];
    certificate?: RemoteTlsCertificateBundle;
  }): Promise<RemoteGatewayStatus> {
    if (this.stopping) {
      await this.stopping;
    }
    await this.auth.initialize();
    if (this.server) {
      return this.getStatus();
    }

    const requestHandler = (request: IncomingMessage, response: ServerResponse) => void this.handleRequest(request, response);
    const server = input.protocol === "https" && input.certificate
      ? createHttpsServer({ key: input.certificate.key, cert: input.certificate.cert }, requestHandler)
      : createServer(requestHandler);
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
      server.listen(input.port, input.host);
    });
    const address = server.address();
    this.host = input.host;
    this.activePort = typeof address === "object" && address ? address.port : input.port;
    this.protocol = input.protocol;
    this.lanEnabled = input.protocol === "https";
    this.addresses = input.addresses;
    this.certificate = input.certificate;
    this.server = server;
    this.lastError = undefined;
    logger.info("Remote gateway started", { host: this.host, port: this.activePort, protocol: this.protocol });
    return this.getStatus();
  }

  /** 停止接收远程请求并等待已有连接关闭。 */
  async stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    const server = this.server;
    if (!server) {
      await this.mediaSessionService?.stopAll();
      await this.auth.flush();
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
      await this.mediaSessionService?.stopAll();
      await this.auth.flush();
      this.rateLimits.clear();
      logger.info("Remote gateway stopped", { host: this.host, port: this.activePort, protocol: this.protocol });
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
      protocol: this.protocol,
      lanEnabled: this.lanEnabled,
      baseUrl: this.getBaseUrl(),
      addresses: this.addresses,
      devices: this.auth.listDevices(),
      certificate: this.certificate ? {
        fingerprint: this.certificate.fingerprint,
        expiresAt: this.certificate.expiresAt,
        authorityCertificatePath: this.certificate.authorityCertificatePath
      } : undefined,
      lastError: this.lastError
    };
  }

  /** 创建桌面端展示的两分钟一次性配对码。 */
  createPairingCode(): RemotePairingChallenge {
    return this.auth.createPairingCode();
  }

  /** 吊销设备并返回最新状态。 */
  async revokeDevice(deviceId: string): Promise<RemoteGatewayStatus> {
    this.auth.revoke(deviceId);
    await this.auth.flush();
    return this.getStatus();
  }

  /** 按路径分发健康检查、配对、RPC 与同源 PWA 静态资源。 */
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const startedAt = this.clock();
    const remoteAddress = request.socket.remoteAddress;
    try {
      this.validateHostAndOrigin(request);
      const url = new URL(request.url ?? "/", this.getBaseUrl());
      if (request.method === "GET" && url.pathname === "/api/health") {
        this.writeJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/ani-tracker-ca.crt" && this.certificate) {
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/x-x509-ca-cert");
        response.setHeader("Content-Disposition", "attachment; filename=ani-tracker-ca.crt");
        response.setHeader("Cache-Control", "no-store");
        response.end(this.certificate.ca);
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
      if (request.method === "POST" && url.pathname === "/api/media/sessions") {
        await this.handleMediaSessionCreate(request, response);
        return;
      }
      const mediaRoute = parseMediaRoute(url.pathname);
      if (request.method === "DELETE" && mediaRoute && mediaRoute.assetName === undefined) {
        await this.handleMediaSessionClose(request, response, mediaRoute.sessionId);
        return;
      }
      if ((request.method === "GET" || request.method === "HEAD") && mediaRoute?.assetName) {
        await this.handleMediaAsset(request, response, mediaRoute.sessionId, mediaRoute.assetName);
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
    const allowedHostnames = new Set(["127.0.0.1", "localhost", ...this.addresses]);
    if (!isTrustedHost(request.headers.host, this.activePort, allowedHostnames)) {
      throw new HttpGatewayError(403, "HOST_FORBIDDEN", "请求 Host 不受信任");
    }
    const origin = request.headers.origin;
    if (!isTrustedOrigin(origin, this.protocol, this.activePort, allowedHostnames)) {
      throw new HttpGatewayError(403, "ORIGIN_FORBIDDEN", "请求 Origin 不受信任");
    }
  }

  /** 返回可供本机或局域网客户端使用的规范网关地址。 */
  private getBaseUrl(): string {
    const publicHost = this.lanEnabled ? this.addresses[0] ?? "127.0.0.1" : "127.0.0.1";
    return `${this.protocol}://${publicHost}:${this.activePort}`;
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
    try {
      await this.auth.flush();
    } catch (error) {
      this.auth.revoke(result.device.id);
      await this.auth.flush().catch(() => undefined);
      throw error;
    }
    this.writeJson(response, 200, result);
  }

  /** 验证 Bearer 令牌、限流后调用显式 RPC dispatcher。 */
  private async handleRpc(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const device = this.requireAuthenticatedDevice(request, false);
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

  /** 创建绑定当前设备的短期媒体播放会话。 */
  private async handleMediaSessionCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.mediaSessionService) {
      throw new HttpGatewayError(503, "MEDIA_SERVICE_UNAVAILABLE", "远程媒体服务不可用");
    }
    const device = this.requireAuthenticatedDevice(request, false);
    this.consumeRateLimit(`media:${device.id}:write`, 20, 60 * 1000);
    const body = requireObject(await readJsonBody(request));
    assertOnlyKeys(body, ["taskId", "mode"]);
    if (typeof body.taskId !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(body.taskId)) {
      throw new HttpGatewayError(400, "MEDIA_TASK_INVALID", "下载任务标识无效");
    }
    if (body.mode !== "direct" && body.mode !== "transcode") {
      throw new HttpGatewayError(400, "MEDIA_MODE_INVALID", "播放模式无效");
    }
    const session = await this.mediaSessionService.createSession(body.taskId, device.id, body.mode);
    const token = parseBearerToken(request.headers.authorization);
    if (token) {
      response.setHeader("Set-Cookie", createMediaCookie(token, this.protocol === "https"));
    }
    this.writeJson(response, 200, session);
  }

  /** 关闭当前设备拥有的媒体播放会话。 */
  private async handleMediaSessionClose(
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string
  ): Promise<void> {
    if (!this.mediaSessionService) {
      throw new HttpGatewayError(503, "MEDIA_SERVICE_UNAVAILABLE", "远程媒体服务不可用");
    }
    const device = this.requireAuthenticatedDevice(request, true);
    const closed = await this.mediaSessionService.closeSession(sessionId, device.id);
    if (!closed) {
      throw new HttpGatewayError(404, "MEDIA_SESSION_NOT_FOUND", "播放会话不存在");
    }
    response.statusCode = 204;
    response.end();
  }

  /** 输出会话内的原文件范围或实时 HLS 播放资源。 */
  private async handleMediaAsset(
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string,
    assetName: string
  ): Promise<void> {
    if (!this.mediaSessionService) {
      throw new HttpGatewayError(503, "MEDIA_SERVICE_UNAVAILABLE", "远程媒体服务不可用");
    }
    const device = this.requireAuthenticatedDevice(request, true);
    this.consumeRateLimit(`media:${device.id}:read`, 600, 60 * 1000);
    const asset = await this.mediaSessionService.getAsset(sessionId, device.id, assetName);
    const fileStats = statSync(asset.filePath);
    const range = asset.direct ? parseByteRange(request.headers.range, fileStats.size) : undefined;
    if (asset.direct && request.headers.range && !range) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${fileStats.size}`);
      response.end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? fileStats.size - 1;
    response.statusCode = range ? 206 : 200;
    response.setHeader("Content-Type", asset.contentType);
    response.setHeader("Content-Length", Math.max(0, end - start + 1));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (asset.direct) {
      response.setHeader("Accept-Ranges", "bytes");
    }
    if (range) {
      response.setHeader("Content-Range", `bytes ${start}-${end}/${fileStats.size}`);
    }
    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = createReadStream(asset.filePath, range ? { start, end } : undefined);
    stream.on("error", (error) => {
      logger.warn("Remote media asset read failed", {
        sessionId,
        errorType: error.name,
        statusCode: response.statusCode
      });
      response.destroy(error);
    });
    stream.pipe(response);
  }

  /** 验证 Bearer 或媒体专用 HttpOnly Cookie 中的设备令牌。 */
  private requireAuthenticatedDevice(request: IncomingMessage, allowCookie: boolean): RemoteDeviceInfo {
    const token = parseBearerToken(request.headers.authorization)
      ?? (allowCookie ? parseMediaCookie(request.headers.cookie) : undefined);
    const device = token ? this.auth.authenticate(token) : undefined;
    if (!device) {
      throw new HttpGatewayError(401, "UNAUTHORIZED", "设备未配对或令牌已失效");
    }
    return device;
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
    const candidateExists = existsSync(candidate) && statSync(candidate).isFile();
    if (!candidateExists && extname(relativePath)) {
      throw new HttpGatewayError(404, "ASSET_NOT_FOUND", "静态资源不存在");
    }
    const selectedPath = candidateExists ? candidate : join(rendererRoot, "index.html");
    if (!existsSync(selectedPath) || !statSync(selectedPath).isFile()) {
      throw new HttpGatewayError(404, "PWA_NOT_BUILT", "PWA 静态资源尚未构建");
    }
    const filePath = realpathSync(selectedPath);
    if (!isPathInsideDirectory(rendererRoot, filePath)) {
      throw new HttpGatewayError(403, "PATH_FORBIDDEN", "静态资源路径无效");
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", getContentType(filePath));
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
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
    if (error instanceof RemoteMediaSessionError) {
      this.writeError(response, error.statusCode, error.code, error.message);
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

/** 读取媒体接口专用的同源 HttpOnly Cookie。 */
function parseMediaCookie(value: string | undefined): string | undefined {
  const cookie = value?.split(";").map((item) => item.trim()).find((item) => item.startsWith("ani_media_token="));
  if (!cookie) {
    return undefined;
  }
  try {
    return parseBearerToken(`Bearer ${decodeURIComponent(cookie.slice("ani_media_token=".length))}`);
  } catch {
    return undefined;
  }
}

/** 创建仅供媒体路径使用的持久设备 Cookie。 */
function createMediaCookie(token: string, secure: boolean): string {
  return [
    `ani_media_token=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/api/media",
    "Max-Age=2592000",
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

interface MediaRoute {
  sessionId: string;
  assetName?: string;
}

/** 解析固定格式的媒体会话路由并拒绝额外路径层级。 */
function parseMediaRoute(pathname: string): MediaRoute | undefined {
  const match = pathname.match(
    /^\/api\/media\/sessions\/([A-Za-z0-9_-]{32})(?:\/(file)|\/hls\/(index\.m3u8|segment-\d{6}\.ts))?$/
  );
  if (!match) {
    return undefined;
  }
  return { sessionId: match[1], assetName: match[2] ?? match[3] };
}

export interface ByteRange {
  start: number;
  end: number;
}

/** 解析单段 HTTP Range，拒绝多段、越界和非法范围。 */
export function parseByteRange(value: string | undefined, size: number): ByteRange | undefined {
  if (!value || !Number.isSafeInteger(size) || size <= 0) {
    return undefined;
  }
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    return undefined;
  }
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return undefined;
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** 规范远程网关端口，避免绑定特权端口或无效端口。 */
function normalizeGatewayPort(value: number): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    throw new Error("远程网关端口必须为 1024 至 65535 的整数");
  }
  return value;
}
