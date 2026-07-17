import { strict as assert } from "node:assert";
import { createServer as createNetServer, connect } from "node:net";
import { test } from "node:test";
import { win32 } from "node:path";
import type { DashboardData } from "@shared/domain";
import { RemoteDeviceAuth } from "../remote-device-auth";
import { RemoteHttpGateway, isPathInsideDirectory } from "../remote-http-gateway";
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

interface GatewayFixtureOptions {
  auth?: RemoteDeviceAuth;
}

/** 在随机端口启动测试网关。 */
async function startGateway(options: GatewayFixtureOptions = {}): Promise<RemoteHttpGateway> {
  const gateway = new RemoteHttpGateway(createRemoteMethodRegistry(createHandlers()), {
    port: 0,
    auth: options.auth
  });
  await gateway.start();
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
