import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  RemoteDeviceAuth,
  RemoteDeviceAuthError,
  type RemoteDeviceAuthLogger
} from "../remote-device-auth";
import { RemoteDeviceCredentialStore } from "../remote-device-credential-store";
import type { SecretProtector } from "../remote-tls-certificate-store";

const silentLogger: RemoteDeviceAuthLogger = {
  info: () => undefined,
  warn: () => undefined
};

/** 创建时间和随机数据均可预测的鉴权核心。 */
function createFixture() {
  let now = Date.parse("2026-07-17T00:00:00.000Z");
  const auth = new RemoteDeviceAuth({
    clock: () => now,
    randomBytes: (size) => {
      if (size === 4) return Buffer.alloc(4);
      if (size === 16) return Buffer.alloc(16, 0x11);
      return Buffer.alloc(size, 0x22);
    },
    logger: silentLogger
  });
  return {
    auth,
    advance: (milliseconds: number) => {
      now += milliseconds;
    }
  };
}

/** 断言调用抛出指定的设备鉴权错误。 */
function assertAuthError(callback: () => unknown, code: RemoteDeviceAuthError["code"]): void {
  assert.throws(callback, (error: unknown) => error instanceof RemoteDeviceAuthError && error.code === code);
}

test("authenticate 对未登记令牌保持未鉴权", () => {
  const { auth } = createFixture();

  assert.equal(auth.authenticate("unknown-token"), undefined);
  assert.deepEqual(auth.listDevices(), []);
});

test("pairDevice 拒绝超过两分钟的配对码", () => {
  const { auth, advance } = createFixture();
  const challenge = auth.createPairingCode();
  advance(2 * 60 * 1_000);

  assertAuthError(() => auth.pairDevice(challenge.code, "Android Phone", ["read"]), "PAIRING_EXPIRED");
  assertAuthError(() => auth.pairDevice(challenge.code, "Android Phone", ["read"]), "PAIRING_NOT_ACTIVE");
});

test("pairDevice 在五次错误后锁定配对会话", () => {
  const { auth } = createFixture();
  const challenge = auth.createPairingCode();

  for (let attempt = 1; attempt < 5; attempt += 1) {
    assertAuthError(() => auth.pairDevice("999999", "iPad", ["read"]), "PAIRING_CODE_INVALID");
  }
  assertAuthError(() => auth.pairDevice("999999", "iPad", ["read"]), "PAIRING_LOCKED");
  assertAuthError(() => auth.pairDevice(challenge.code, "iPad", ["read"]), "PAIRING_NOT_ACTIVE");
});

test("pairDevice 成功配对且公开视图不泄露令牌摘要", () => {
  const { auth } = createFixture();
  const challenge = auth.createPairingCode();
  const result = auth.pairDevice(challenge.code, " MacBook ", ["read", "control", "read", " "]);

  assert.match(challenge.code, /^\d{6}$/);
  assert.equal(Buffer.from(result.token, "base64url").byteLength, 32);
  assert.deepEqual(result.device, {
    id: "11111111111111111111111111111111",
    name: "MacBook",
    scopes: ["read", "control"],
    createdAt: "2026-07-17T00:00:00.000Z",
    lastAccessedAt: null
  });
  const listedDevice = auth.listDevices()[0] as unknown as Record<string, unknown>;
  assert.equal("token" in listedDevice, false);
  assert.equal("tokenHash" in listedDevice, false);
  assertAuthError(() => auth.pairDevice(challenge.code, "Other", ["read"]), "PAIRING_NOT_ACTIVE");
});

test("authenticate 成功后更新时间且无效令牌不能更新时间", () => {
  const { auth, advance } = createFixture();
  const challenge = auth.createPairingCode();
  const paired = auth.pairDevice(challenge.code, "Windows PC", ["read"]);
  advance(30_000);

  assert.equal(auth.authenticate("invalid-token"), undefined);
  assert.equal(auth.listDevices()[0].lastAccessedAt, null);
  assert.equal(auth.authenticate(paired.token)?.lastAccessedAt, "2026-07-17T00:00:30.000Z");
  assert.equal(auth.listDevices()[0].lastAccessedAt, "2026-07-17T00:00:30.000Z");
});

test("revoke 吊销后令牌立即失效", () => {
  const { auth } = createFixture();
  const challenge = auth.createPairingCode();
  const paired = auth.pairDevice(challenge.code, "Android Tablet", ["read"]);

  assert.ok(auth.authenticate(paired.token));
  assert.equal(auth.revoke(paired.device.id), true);
  assert.equal(auth.authenticate(paired.token), undefined);
  assert.equal(auth.revoke(paired.device.id), false);
  assert.deepEqual(auth.listDevices(), []);
});

test("已配对设备重启后恢复且吊销状态持久化", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RemoteDeviceCredentialStore(directory, createTestProtector(), silentLogger);
  const first = new RemoteDeviceAuth({
    credentialStore: store,
    randomBytes: (size) => size === 4 ? Buffer.alloc(4) : Buffer.alloc(size, size === 16 ? 0x33 : 0x44),
    logger: silentLogger
  });
  await first.initialize();
  const challenge = first.createPairingCode();
  const paired = first.pairDevice(challenge.code, "Living Room", ["library.read", "downloads.read"]);
  await first.flush();

  const encrypted = await readFile(join(directory, "remote-devices.enc"), "utf8");
  assert.equal(encrypted.includes(paired.token), false);

  const restored = new RemoteDeviceAuth({ credentialStore: store, logger: silentLogger });
  await restored.initialize();
  assert.equal(restored.authenticate(paired.token)?.name, "Living Room");
  assert.equal(restored.revoke(paired.device.id), true);
  await restored.flush();

  const afterRevoke = new RemoteDeviceAuth({ credentialStore: store, logger: silentLogger });
  await afterRevoke.initialize();
  assert.equal(afterRevoke.authenticate(paired.token), undefined);
  assert.deepEqual(afterRevoke.listDevices(), []);
});

test("损坏的设备凭据文件不会阻止远程服务启动", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "remote-devices.enc"), "broken-credential", "utf8");
  const store = new RemoteDeviceCredentialStore(directory, createTestProtector(), silentLogger);

  assert.deepEqual(await store.load(), []);
});

/** 创建可逆但不会在磁盘暴露明文的测试加密器。 */
function createTestProtector(): SecretProtector {
  return {
    isAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => {
      const stored = value.toString();
      if (!stored.startsWith("protected:")) {
        throw new Error("测试密文损坏");
      }
      return Buffer.from(stored.slice("protected:".length), "base64").toString();
    }
  };
}
