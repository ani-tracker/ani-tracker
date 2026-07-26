#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const directory = resolve(
  process.argv[2] ?? join("out", "qbittorrent", `${process.platform}-${normalizeArch(process.arch)}`)
);
const binaryPath = resolveBinary(directory);
await access(binaryPath);

const profileDirectory = await mkdtemp(join(tmpdir(), "ani-qbittorrent-managed-"));
const port = await reservePort();
const environment = buildRuntimeEnvironment(directory, binaryPath);
const child = spawn(binaryPath, [
  `--webui-port=${port}`,
  `--profile=${profileDirectory}`,
  "--confirm-legal-notice"
], {
  cwd: dirname(binaryPath),
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let output = "";
let launchError;
child.once("error", (error) => { launchError = error; });
child.stdout.on("data", appendOutput);
child.stderr.on("data", appendOutput);

try {
  const temporaryPassword = await waitForStartup(child, port, () => output, () => launchError);
  const baseUrl = `http://localhost:${port}`;
  await sleep(1_000);
  const bootstrapCookie = await login(baseUrl, "admin", temporaryPassword).catch((error) => {
    throw new Error(`${error.message}\n${redactOutput(output)}`);
  });
  const username = "ani-smoke";
  const password = `ani-smoke-${randomBytes(8).toString("hex")}`;
  await postForm(baseUrl, "/api/v2/app/setPreferences", {
    json: JSON.stringify({
      web_ui_username: username,
      web_ui_password: password,
      web_ui_address: "127.0.0.1",
      web_ui_upnp: false,
      bypass_local_auth: false,
      web_ui_csrf_protection_enabled: true,
      web_ui_host_header_validation_enabled: true
    })
  }, bootstrapCookie);
  const applicationCookie = await login(baseUrl, username, password);
  const tasks = await request(baseUrl, "/api/v2/torrents/info", { cookie: applicationCookie });
  if (!Array.isArray(await tasks.json())) throw new Error("qBittorrent 任务接口没有返回数组");
  await request(baseUrl, "/api/v2/app/shutdown", {
    method: "POST",
    cookie: applicationCookie
  });
  if (!await waitForExit(child, 10_000)) throw new Error("qBittorrent 未在优雅关闭超时内退出");
  if (child.exitCode !== 0) throw new Error(`qBittorrent 退出码异常：${child.exitCode}`);
  console.log(`[qbittorrent] managed smoke passed port=${port}`);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    if (!await waitForExit(child, 5_000)) child.kill("SIGKILL");
  }
  await rm(profileDirectory, { recursive: true, force: true });
}

/** 追加启动输出，仅用于内存提取临时密码，不输出凭据。 */
function appendOutput(chunk) {
  // Windows Qt 可能按系统代码页输出；latin1 可无损保留 ASCII 临时密码。
  output = `${output}${chunk.toString("latin1")}`.slice(-16_000);
}

/** 等待 WebUI 和一次性管理员密码同时就绪。 */
async function waitForStartup(processHandle, port, readOutput, readError) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && processHandle.exitCode === null && !readError()) {
    const password = extractTemporaryPassword(readOutput());
    if (password && await isWebUiReady(port)) return password;
    await sleep(200);
  }
  const error = readError();
  const detail = error instanceof Error ? error.message : redactOutput(readOutput());
  throw new Error(`qBittorrent 托管启动失败：${detail || "超时"}`);
}

/** 从 qBittorrent nox 启动日志提取当前会话临时密码。 */
function extractTemporaryPassword(value) {
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  const match = /(?:temporary password|临时密码)[^:\n：]*(?::|：)\s*([A-Za-z0-9]{8,32})/gi;
  const matched = [...decoded.matchAll(match)].at(-1)?.[1];
  if (matched) return matched;
  const ignored = new Set([
    "localhost",
    "qbittorrent",
    "administrator",
    "temporary",
    "password",
    "provided",
    "session"
  ]);
  return [...decoded.matchAll(/[A-Za-z0-9]{8,32}/g)]
    .map((candidate) => candidate[0])
    .filter((candidate) => !ignored.has(candidate.toLowerCase()))
    .at(-1);
}

/** 登录 WebUI 并返回当前会话 Cookie。 */
async function login(baseUrl, username, password) {
  const response = await postForm(baseUrl, "/api/v2/auth/login", { username, password });
  const result = (await response.text()).trim();
  if (response.status !== 204 && result !== "Ok.") {
    throw new Error(`qBittorrent WebUI 登录失败：HTTP ${response.status} ${JSON.stringify(result)}`);
  }
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("qBittorrent WebUI 未返回会话 Cookie");
  return cookie;
}

/** 发送表单请求并执行统一状态检查。 */
function postForm(baseUrl, path, body, cookie) {
  return request(baseUrl, path, {
    method: "POST",
    cookie,
    body: new URLSearchParams(body),
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }
  });
}

/** 调用本地 WebUI，拒绝非成功响应。 */
async function request(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set("cookie", options.cookie);
  headers.set("origin", baseUrl);
  headers.set("referer", `${baseUrl}/`);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    body: options.body,
    headers,
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`qBittorrent API 请求失败：${path} (${response.status})`);
  return response;
}

/** 探测本地 WebUI 是否已监听。 */
async function isWebUiReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500)
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

/** 构造仅使用随包运行库的进程环境。 */
function buildRuntimeEnvironment(bundleDirectory, executablePath) {
  const environment = { ...process.env };
  const executableDirectory = dirname(executablePath);
  environment.PATH = [executableDirectory, environment.PATH].filter(Boolean).join(delimiter);
  if (process.platform === "darwin") {
    const contents = dirname(dirname(executablePath));
    environment.QT_PLUGIN_PATH = join(contents, "PlugIns");
    environment.DYLD_LIBRARY_PATH = join(contents, "Frameworks");
    environment.OPENSSL_MODULES = join(contents, "Frameworks", "ossl-modules");
  } else {
    environment.QT_PLUGIN_PATH = bundleDirectory;
    environment.OPENSSL_MODULES = join(bundleDirectory, "ossl-modules");
  }
  if (process.platform === "linux") environment.LD_LIBRARY_PATH = bundleDirectory;
  return environment;
}

/** 返回当前平台的 qBittorrent nox 可执行路径。 */
function resolveBinary(bundleDirectory) {
  if (process.platform === "win32") return join(bundleDirectory, "qbittorrent-nox.exe");
  if (process.platform === "darwin") {
    return join(bundleDirectory, "qbittorrent-nox.app", "Contents", "MacOS", "qbittorrent-nox");
  }
  return join(bundleDirectory, "qbittorrent-nox");
}

/** 将 Node 架构名称转换为项目 bundle 名称。 */
function normalizeArch(arch) {
  if (arch === "x64" || arch === "arm64") return arch;
  throw new Error(`不支持的 qBittorrent 架构：${arch}`);
}

/** 申请并释放一个本地随机端口。 */
function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

/** 等待子进程结束并返回是否在超时内完成。 */
function waitForExit(processHandle, timeoutMs) {
  return new Promise((resolveExit) => {
    if (processHandle.exitCode !== null) return resolveExit(true);
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

/** 对异常输出做凭据脱敏。 */
function redactOutput(value) {
  return Buffer.from(value, "latin1")
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/[A-Za-z0-9]{8,32}/g, "[credential redacted]"))
    .join("\n")
    .slice(-2_000)
    .trim();
}

/** 等待指定毫秒数。 */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
