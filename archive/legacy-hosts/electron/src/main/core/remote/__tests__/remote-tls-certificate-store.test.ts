import { strict as assert } from "node:assert";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RemoteTlsCertificateStore, type SecretProtector } from "../remote-tls-certificate-store";

test("证书仓库加密保存私钥并复用有效证书", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-tls-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const protector = createTestProtector();
  const store = new RemoteTlsCertificateStore(directory, protector, {
    clock: () => new Date("2026-07-17T00:00:00.000Z")
  });

  const first = await store.loadOrCreate(["192.168.1.20"]);
  const second = await store.loadOrCreate(["192.168.1.20"]);
  const encryptedServerKey = await readFile(join(directory, "ani-tracker-server.key.enc"), "utf8");
  const encryptedAuthorityKey = await readFile(join(directory, "ani-tracker-ca.key.enc"), "utf8");
  const serverCertificate = new X509Certificate(first.cert);
  const authorityCertificate = new X509Certificate(first.ca);

  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.ca, first.ca);
  assert.ok(first.authorityCertificatePath.endsWith("ani-tracker-ca.crt"));
  assert.match(serverCertificate.subjectAltName ?? "", /DNS:localhost/);
  assert.match(serverCertificate.subjectAltName ?? "", /IP Address:127\.0\.0\.1/);
  assert.match(serverCertificate.subjectAltName ?? "", /IP Address:192\.168\.1\.20/);
  assert.equal(serverCertificate.fingerprint256.replaceAll(":", "").toLowerCase(), first.fingerprint);
  assert.equal(authorityCertificate.ca, true);
  assert.doesNotMatch(encryptedServerKey, /PRIVATE KEY/);
  assert.doesNotMatch(encryptedAuthorityKey, /PRIVATE KEY/);
});

test("私网地址变化时重签服务端证书但复用本地 CA", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-tls-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RemoteTlsCertificateStore(directory, createTestProtector(), {
    clock: () => new Date("2026-07-17T00:00:00.000Z")
  });

  const first = await store.loadOrCreate(["192.168.1.20"]);
  const second = await store.loadOrCreate(["192.168.1.21"]);

  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(second.ca, first.ca);
});

test("服务端证书与解密私钥不匹配时自动重签", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-tls-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const protector = createTestProtector();
  const store = new RemoteTlsCertificateStore(directory, protector, {
    clock: () => new Date("2026-07-17T00:00:00.000Z")
  });
  const first = await store.loadOrCreate(["192.168.1.20"]);
  const unrelatedKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem"
  }).toString();
  await writeFile(join(directory, "ani-tracker-server.key.enc"), protector.encryptString(unrelatedKey));

  const repaired = await store.loadOrCreate(["192.168.1.20"]);

  assert.notEqual(repaired.fingerprint, first.fingerprint);
  assert.equal(repaired.ca, first.ca);
});

test("服务端证书与 CA 文件不属于同一批次时重建整套凭据", async (context) => {
  const firstDirectory = await mkdtemp(join(tmpdir(), "ani-remote-tls-"));
  const secondDirectory = await mkdtemp(join(tmpdir(), "ani-remote-tls-"));
  context.after(() => Promise.all([
    rm(firstDirectory, { recursive: true, force: true }),
    rm(secondDirectory, { recursive: true, force: true })
  ]));
  const clock = () => new Date("2026-07-17T00:00:00.000Z");
  const firstStore = new RemoteTlsCertificateStore(firstDirectory, createTestProtector(), { clock });
  const secondStore = new RemoteTlsCertificateStore(secondDirectory, createTestProtector(), { clock });
  const first = await firstStore.loadOrCreate(["192.168.1.20"]);
  const unrelated = await secondStore.loadOrCreate(["192.168.1.20"]);
  await writeFile(join(firstDirectory, "ani-tracker-ca.crt"), unrelated.ca);

  const repaired = await firstStore.loadOrCreate(["192.168.1.20"]);

  assert.notEqual(repaired.fingerprint, first.fingerprint);
  assert.notEqual(repaired.ca, unrelated.ca);
});

test("系统安全存储不可用时拒绝生成证书", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-tls-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const protector = createTestProtector();
  protector.isAvailable = () => false;
  const store = new RemoteTlsCertificateStore(directory, protector);

  await assert.rejects(() => store.loadOrCreate(["192.168.1.20"]), /系统安全存储不可用/);
});

function createTestProtector(): SecretProtector {
  return {
    isAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => Buffer.from(value.toString().replace(/^encrypted:/, ""), "base64").toString()
  };
}
