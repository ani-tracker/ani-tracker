import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer, connect } from "node:net";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { AppSettings, DashboardData, DownloadTask } from "@shared/domain";
import { RemoteDeviceAuth } from "../remote-device-auth";
import { RemoteHttpGateway, isPathInsideDirectory, parseByteRange } from "../remote-http-gateway";
import { RemoteMediaSessionService } from "../remote-media-session-service";
import { RemoteTlsCertificateStore, type SecretProtector } from "../remote-tls-certificate-store";
import { createRemoteMethodRegistry, type RemoteRpcHandlers } from "../remote-method-registry";

const emptyDashboard: DashboardData = {
  dailyReminder: {
    date: "2026-07-17",
    total: 0,
    upcoming: 0,
    aired: 0,
    downloading: 0,
    downloaded: 0,
    items: []
  },
  todayEpisodes: [],
  pendingActions: [],
  activeDownloads: [],
  recentCompleted: [],
  weeklySchedule: [],
  sourceHealth: []
};

test("健康检查返回可用状态", async (context) => {
  const gateway = await startGateway();
  context.after(() => gateway.stop());

  const response = await fetch(`${gateway.getStatus().baseUrl}/api/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("HTTP 网关拒绝监听非回环地址", () => {
  assert.throws(
    () => new RemoteHttpGateway(createRemoteMethodRegistry(createHandlers()), { host: "0.0.0.0" }),
    /只允许监听 127\.0\.0\.1/
  );
});

test("配对后可携带 Bearer 令牌调用显式 RPC", async (context) => {
  const gateway = await startGateway();
  context.after(() => gateway.stop());
  const token = await pairGateway(gateway, "Android Phone");

  const response = await fetch(`${gateway.getStatus().baseUrl}/api/rpc`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ method: "getUnreadNotificationCount", args: [] })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: 2 });
  assert.equal(gateway.getStatus().devices[0].name, "Android Phone");
});

test("RPC 对缺失令牌返回 401", async (context) => {
  const gateway = await startGateway();
  context.after(() => gateway.stop());

  const response = await fetch(`${gateway.getStatus().baseUrl}/api/rpc`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ method: "listDownloads", args: [] })
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json() as { code: string }).code, "UNAUTHORIZED");
});

test("RPC 对 scope 不足和跨站 Origin 返回 403", async (context) => {
  const auth = createAuth();
  const challenge = auth.createPairingCode();
  const paired = auth.pairDevice(challenge.code, "Read Only", ["library.read"]);
  const gateway = await startGateway({ auth });
  context.after(() => gateway.stop());

  const forbiddenScope = await fetch(`${gateway.getStatus().baseUrl}/api/rpc`, {
    method: "POST",
    headers: jsonHeaders(paired.token),
    body: JSON.stringify({ method: "listDownloads", args: [] })
  });
  assert.equal(forbiddenScope.status, 403);
  assert.equal((await forbiddenScope.json() as { code: string }).code, "FORBIDDEN");

  const forbiddenOrigin = await fetch(`${gateway.getStatus().baseUrl}/api/health`, {
    headers: { Origin: "https://attacker.example" }
  });
  assert.equal(forbiddenOrigin.status, 403);
  assert.equal((await forbiddenOrigin.json() as { code: string }).code, "ORIGIN_FORBIDDEN");
});

test("请求体超过 64KB 返回 413", async (context) => {
  const gateway = await startGateway();
  context.after(() => gateway.stop());

  const response = await fetch(`${gateway.getStatus().baseUrl}/api/pair`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ payload: "x".repeat(64 * 1024) })
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json() as { code: string }).code, "BODY_TOO_LARGE");
});

test("配对请求超过固定窗口上限返回 429", async (context) => {
  const gateway = await startGateway();
  context.after(() => gateway.stop());
  const challenge = gateway.createPairingCode();
  const invalidCode = challenge.code === "999999" ? "000000" : "999999";

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await postPair(gateway, invalidCode, `Attacker ${attempt}`);
    assert.equal(response.status, 400);
  }
  const limited = await postPair(gateway, invalidCode, "Attacker 6");

  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { code: string }).code, "RATE_LIMITED");
});

test("已认证 RPC 对未知方法返回 404 且不动态调用 IPC", async (context) => {
  const gateway = await startGateway();
  context.after(() => gateway.stop());
  const token = await pairGateway(gateway, "iPad");

  const response = await fetch(`${gateway.getStatus().baseUrl}/api/rpc`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ method: "getSettings", args: [] })
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json() as { code: string }).code, "METHOD_NOT_FOUND");
});

test("stop 销毁半开连接并立即释放监听端口", async () => {
  const gateway = await startGateway();
  const { host, port } = gateway.getStatus();
  const socket = connect(port, host);
  await new Promise<void>((resolveConnection, rejectConnection) => {
    socket.once("connect", resolveConnection);
    socket.once("error", rejectConnection);
  });
  socket.write("POST /api/rpc HTTP/1.1\r\nHost: partial");
  const socketClosed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));

  await Promise.race([
    gateway.stop(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("网关停止超时")), 1_000))
  ]);
  await Promise.race([
    socketClosed,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("半开连接关闭超时")), 1_000))
  ]);
  assert.equal(socket.destroyed, true);

  const replacement = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    replacement.once("error", rejectListen);
    replacement.listen(port, host, resolveListen);
  });
  await new Promise<void>((resolveClose, rejectClose) => {
    replacement.close((error) => error ? rejectClose(error) : resolveClose());
  });
});

test("静态目录边界判断兼容 Windows 分隔符", () => {
  const operations = {
    isAbsolute: win32.isAbsolute,
    relative: win32.relative,
    sep: win32.sep
  };

  assert.equal(isPathInsideDirectory("C:\\app\\renderer", "C:\\app\\renderer\\assets\\app.js", operations), true);
  assert.equal(isPathInsideDirectory("C:\\app\\renderer", "C:\\app\\renderer-evil\\secret.js", operations), false);
  assert.equal(isPathInsideDirectory("C:\\app\\renderer", "D:\\secret.js", operations), false);
});

test("parseByteRange 支持开放范围和后缀范围并拒绝越界", () => {
  assert.deepEqual(parseByteRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseByteRange("bytes=7-", 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.equal(parseByteRange("bytes=10-12", 10), undefined);
  assert.equal(parseByteRange("bytes=1-2,4-5", 10), undefined);
});

test("媒体会话使用设备 Cookie 输出 206 范围响应", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-media-gateway-"));
  const filePath = join(directory, "episode.mp4");
  await writeFile(filePath, "0123456789", "utf8");
  const task: DownloadTask = {
    id: "task-media-1",
    engine: "qbittorrent",
    name: "episode.mp4",
    status: "downloading",
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath: directory,
    files: [{
      id: "file-media-1",
      index: 0,
      name: "episode.mp4",
      size: 10,
      progress: 1,
      priority: 1,
      selected: true
    }],
    createdAt: "2026-07-18T00:00:00.000Z"
  };
  const mediaSessionService = new RemoteMediaSessionService({
    getDownloadTask: async (taskId) => taskId === task.id ? task : undefined,
    listMediaFiles: async () => [],
    getSettings: async () => ({
      media: { ffprobePath: "ffprobe", ffprobeTimeoutSeconds: 20, videoExtensions: [".mp4"] }
    } as AppSettings)
  }, {
    durationProbe: async () => 1_445,
    subtitlePreparer: async (_sourcePath, outputDirectory) => {
      await writeFile(join(outputDirectory, "subtitle-000.vtt"), "WEBVTT\n\n", "utf8");
      return {
        subtitles: [{
          assetName: "subtitle-000.vtt",
          id: "subtitle-2",
          label: "简体中文",
          language: "简体中文",
          type: "vtt",
          default: true
        }],
        detectedCount: 1,
        unsupportedCount: 0,
        failedCount: 0
      };
    },
    logger: { info: () => undefined, warn: () => undefined }
  });
  const gateway = await startGateway({ mediaSessionService });
  context.after(async () => {
    await gateway.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const token = await pairGateway(gateway, "Media Client");
  const invalidModeResponse = await fetch(`${gateway.getStatus().baseUrl}/api/media/sessions`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ taskId: task.id, mode: "automatic" })
  });
  assert.equal(invalidModeResponse.status, 400);

  const createResponse = await fetch(`${gateway.getStatus().baseUrl}/api/media/sessions`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ taskId: task.id, mode: "direct" })
  });
  assert.equal(createResponse.status, 200);
  const session = await createResponse.json() as {
    streamUrl: string;
    subtitles: Array<{ url: string }>;
  };
  const cookie = createResponse.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  const rangeResponse = await fetch(`${gateway.getStatus().baseUrl}${session.streamUrl}`, {
    headers: { Cookie: cookie, Range: "bytes=2-5" }
  });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await rangeResponse.text(), "2345");

  const subtitleResponse = await fetch(
    `${gateway.getStatus().baseUrl}${session.subtitles[0].url}`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(subtitleResponse.status, 200);
  assert.match(subtitleResponse.headers.get("content-type") ?? "", /^text\/vtt/);
  assert.equal(await subtitleResponse.text(), "WEBVTT\n\n");

  const unauthorized = await fetch(`${gateway.getStatus().baseUrl}${session.streamUrl}`);
  assert.equal(unauthorized.status, 401);
});

test("缺失静态资源返回 404 且前端路由回退入口页面", async (context) => {
  const rendererDirectory = await mkdtemp(join(tmpdir(), "ani-remote-renderer-"));
  await writeFile(join(rendererDirectory, "index.html"), "<!doctype html><title>Ani Tracker</title>", "utf8");
  const gateway = await startGateway({ rendererDirectory });
  context.after(async () => {
    await gateway.stop();
    await rm(rendererDirectory, { recursive: true, force: true });
  });

  const missingAsset = await fetch(`${gateway.getStatus().baseUrl}/sw.js`);
  assert.equal(missingAsset.status, 404);
  assert.equal((await missingAsset.json() as { code: string }).code, "ASSET_NOT_FOUND");

  const frontendRoute = await fetch(`${gateway.getStatus().baseUrl}/notifications`);
  assert.equal(frontendRoute.status, 200);
  assert.match(frontendRoute.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await frontendRoute.text(), /Ani Tracker/);
});

test("局域网 HTTPS 使用本地 CA 并限制 Host 与 Origin", async (context) => {
  const certificateDirectory = await mkdtemp(join(tmpdir(), "ani-remote-gateway-tls-"));
  const certificateStore = new RemoteTlsCertificateStore(certificateDirectory, createTestProtector());
  const gateway = await startGateway({
    certificateStore,
    privateAddresses: ["192.168.1.20"],
    start: false
  });
  context.after(async () => {
    await gateway.stop();
    await rm(certificateDirectory, { recursive: true, force: true });
  });
  const status = await gateway.applySettings({ lanEnabled: true, port: 18_183 });
  assert.equal(status.protocol, "https");
  assert.equal(status.lanEnabled, true);
  assert.deepEqual(status.addresses, ["192.168.1.20"]);
  assert.ok(status.certificate);

  const health = await requestHttps(18_183, "/api/health", status.certificate?.authorityCertificatePath, {
    host: "192.168.1.20:18183",
    origin: "https://192.168.1.20:18183"
  });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true });

  const authority = await requestHttps(18_183, "/ani-tracker-ca.crt", status.certificate?.authorityCertificatePath, {
    host: "192.168.1.20:18183"
  });
  assert.equal(authority.statusCode, 200);
  assert.match(authority.body, /BEGIN CERTIFICATE/);

  const forbiddenHost = await requestHttps(18_183, "/api/health", status.certificate?.authorityCertificatePath, {
    host: "attacker.test:18183"
  });
  assert.equal(forbiddenHost.statusCode, 403);

  const forbiddenOrigin = await requestHttps(18_183, "/api/health", status.certificate?.authorityCertificatePath, {
    host: "192.168.1.20:18183",
    origin: "https://attacker.test:18183"
  });
  assert.equal(forbiddenOrigin.statusCode, 403);
});

test("局域网 HTTPS 初始化失败时恢复回环 HTTP", async (context) => {
  const certificateDirectory = await mkdtemp(join(tmpdir(), "ani-remote-gateway-tls-"));
  const protector = createTestProtector();
  protector.isAvailable = () => false;
  const gateway = await startGateway({
    certificateStore: new RemoteTlsCertificateStore(certificateDirectory, protector),
    privateAddresses: ["192.168.1.20"],
    start: false
  });
  context.after(async () => {
    await gateway.stop();
    await rm(certificateDirectory, { recursive: true, force: true });
  });

  const status = await gateway.applySettings({ lanEnabled: true, port: 18_184 });
  assert.equal(status.protocol, "http");
  assert.equal(status.lanEnabled, false);
  assert.match(status.lastError ?? "", /系统安全存储不可用/);
  const response = await fetch(status.baseUrl + "/api/health");
  assert.equal(response.status, 200);
});

test("局域网模式拒绝只包含公网地址的监听结果", async (context) => {
  const certificateDirectory = await mkdtemp(join(tmpdir(), "ani-remote-gateway-tls-"));
  const gateway = await startGateway({
    certificateStore: new RemoteTlsCertificateStore(certificateDirectory, createTestProtector()),
    privateAddresses: ["8.8.8.8"],
    start: false
  });
  context.after(async () => {
    await gateway.stop();
    await rm(certificateDirectory, { recursive: true, force: true });
  });

  const status = await gateway.applySettings({ lanEnabled: true, port: 18_185 });

  assert.equal(status.protocol, "http");
  assert.equal(status.host, "127.0.0.1");
  assert.match(status.lastError ?? "", /未发现可用的局域网 IPv4 地址/);
});

interface GatewayFixtureOptions {
  auth?: RemoteDeviceAuth;
  rendererDirectory?: string;
  certificateStore?: RemoteTlsCertificateStore;
  privateAddresses?: string[];
  start?: boolean;
  mediaSessionService?: RemoteMediaSessionService;
}

/** 在随机端口启动测试网关。 */
async function startGateway(options: GatewayFixtureOptions = {}): Promise<RemoteHttpGateway> {
  const gateway = new RemoteHttpGateway(createRemoteMethodRegistry(createHandlers()), {
    port: 0,
    auth: options.auth,
    rendererDirectory: options.rendererDirectory,
    mediaSessionService: options.mediaSessionService,
    tlsCertificateStore: options.certificateStore,
    privateAddressProvider: () => options.privateAddresses ?? []
  });
  if (options.start !== false) {
    await gateway.start();
  }
  return gateway;
}

/** 创建无日志的鉴权核心，避免安全场景污染测试输出。 */
function createAuth(): RemoteDeviceAuth {
  return new RemoteDeviceAuth({
    logger: {
      info: () => undefined,
      warn: () => undefined
    }
  });
}

/** 使用网关生成的一次性配对码取得设备令牌。 */
async function pairGateway(gateway: RemoteHttpGateway, deviceName: string): Promise<string> {
  const challenge = gateway.createPairingCode();
  const response = await postPair(gateway, challenge.code, deviceName);
  assert.equal(response.status, 200);
  return (await response.json() as { token: string }).token;
}

/** 发送配对请求。 */
function postPair(gateway: RemoteHttpGateway, code: string, deviceName: string): Promise<Response> {
  return fetch(`${gateway.getStatus().baseUrl}/api/pair`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ code, deviceName })
  });
}

/** 创建 JSON 与可选 Bearer 令牌请求头。 */
function jsonHeaders(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

/** 使用指定 CA 请求测试 HTTPS 网关并返回完整响应。 */
async function requestHttps(
  port: number,
  path: string,
  authorityCertificatePath: string | undefined,
  headers: { host: string; origin?: string }
): Promise<{ statusCode: number; body: string }> {
  assert.ok(authorityCertificatePath);
  const ca = await import("node:fs/promises").then(({ readFile }) => readFile(authorityCertificatePath, "utf8"));
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: "GET",
      ca,
      servername: "localhost",
      headers: { Host: headers.host, ...(headers.origin ? { Origin: headers.origin } : {}) }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveRequest({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", rejectRequest);
    request.end();
  });
}

function createTestProtector(): SecretProtector {
  return {
    isAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => Buffer.from(value.toString().replace(/^encrypted:/, ""), "base64").toString()
  };
}

/** 创建覆盖所有注册项的显式测试 handler。 */
function createHandlers(): RemoteRpcHandlers {
  return {
    getDashboard: () => emptyDashboard,
    listNotifications: () => [],
    getUnreadNotificationCount: () => 2,
    markNotificationRead: () => [],
    markAllNotificationsRead: () => [],
    listMyAnime: () => [],
    listAnimeCatalog: () => [],
    searchAnimeCatalog: () => [],
    listFansubs: () => [],
    listEpisodes: () => [],
    listEpisodePreferences: () => [],
    listDownloads: () => [],
    refreshDownloads: () => [],
    pauseDownload: () => [],
    resumeDownload: () => []
  };
}
