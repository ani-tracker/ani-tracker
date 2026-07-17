import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RemoteDeviceAuth,
  RemoteDeviceAuthError,
  type RemoteDeviceAuthLogger
} from "../remote-device-auth";

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
