import { createHash, createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as forgeNamespace from "node-forge";

const forge = (forgeNamespace as unknown as { default?: typeof forgeNamespace }).default ?? forgeNamespace;

const CERTIFICATE_LIFETIME_DAYS = 365;
const AUTHORITY_LIFETIME_DAYS = 3650;
const ROTATE_BEFORE_DAYS = 30;
const ROTATE_AUTHORITY_BEFORE_DAYS = 365;

export interface SecretProtector {
  isAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface RemoteTlsCertificateBundle {
  key: string;
  cert: string;
  ca: string;
  fingerprint: string;
  expiresAt: string;
  authorityCertificatePath: string;
}

interface StoredCertificateMetadata {
  version: 1;
  addresses: string[];
  fingerprint: string;
  expiresAt: string;
  authorityExpiresAt: string;
}

interface CertificateAuthority {
  certificate: forgeNamespace.pki.Certificate;
  privateKey: forgeNamespace.pki.rsa.PrivateKey;
  certificatePem: string;
  privateKeyPem: string;
  expiresAt: string;
}

export interface RemoteTlsCertificateStoreOptions {
  clock?: () => Date;
}

export class RemoteTlsCertificateStore {
  private readonly clock: () => Date;

  constructor(
    private readonly directory: string,
    private readonly protector: SecretProtector,
    options: RemoteTlsCertificateStoreOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** 读取可复用证书；地址变化或临近到期时生成并安全替换证书。 */
  async loadOrCreate(addresses: string[]): Promise<RemoteTlsCertificateBundle> {
    if (!this.protector.isAvailable()) {
      throw new Error("系统安全存储不可用，不能开启局域网 HTTPS");
    }
    const normalizedAddresses = [...new Set(addresses)].sort();
    const current = await this.readCurrent(normalizedAddresses);
    if (current) {
      return current;
    }
    const now = this.clock();
    const authority = await this.readAuthority(now) ?? generateCertificateAuthority(now);
    const generated = generateServerCertificateBundle(normalizedAddresses, now, authority);
    await this.persist(generated, normalizedAddresses, authority);
    return { ...generated, authorityCertificatePath: this.authorityPath };
  }

  /** 读取仍可覆盖下一轮服务端证书有效期的本地 CA。 */
  private async readAuthority(now: Date): Promise<CertificateAuthority | undefined> {
    try {
      const [metadataRaw, certificatePem, encryptedKey] = await Promise.all([
        readFile(this.metadataPath, "utf8"),
        readFile(this.authorityPath, "utf8"),
        readFile(this.encryptedAuthorityKeyPath)
      ]);
      const metadata = JSON.parse(metadataRaw) as StoredCertificateMetadata;
      if (Date.parse(metadata.authorityExpiresAt) - now.getTime() <= ROTATE_AUTHORITY_BEFORE_DAYS * 24 * 60 * 60 * 1000) {
        return undefined;
      }
      const privateKeyPem = this.protector.decryptString(encryptedKey);
      if (!certificateMatchesPrivateKey(certificatePem, privateKeyPem)) {
        return undefined;
      }
      return {
        certificate: forge.pki.certificateFromPem(certificatePem),
        privateKey: forge.pki.privateKeyFromPem(privateKeyPem) as forgeNamespace.pki.rsa.PrivateKey,
        certificatePem,
        privateKeyPem,
        expiresAt: metadata.authorityExpiresAt
      };
    } catch {
      return undefined;
    }
  }

  /** 读取证书元数据和经系统安全存储加密的私钥。 */
  private async readCurrent(addresses: string[]): Promise<RemoteTlsCertificateBundle | undefined> {
    try {
      const [metadataRaw, certificate, authority, encryptedKey] = await Promise.all([
        readFile(this.metadataPath, "utf8"),
        readFile(this.certificatePath, "utf8"),
        readFile(this.authorityPath, "utf8"),
        readFile(this.encryptedKeyPath)
      ]);
      const metadata = JSON.parse(metadataRaw) as StoredCertificateMetadata;
      if (!isReusableMetadata(metadata, addresses, this.clock())) {
        return undefined;
      }
      const privateKey = this.protector.decryptString(encryptedKey);
      if (!isConsistentCertificateBundle(certificate, privateKey, authority, metadata, addresses)) {
        return undefined;
      }
      return {
        key: privateKey,
        cert: certificate,
        ca: authority,
        fingerprint: metadata.fingerprint,
        expiresAt: metadata.expiresAt,
        authorityCertificatePath: this.authorityPath
      };
    } catch {
      return undefined;
    }
  }

  /** 使用临时文件替换证书组，避免中断时留下半套凭据。 */
  private async persist(
    bundle: RemoteTlsCertificateBundle,
    addresses: string[],
    authority: CertificateAuthority
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const metadata: StoredCertificateMetadata = {
      version: 1,
      addresses,
      fingerprint: bundle.fingerprint,
      expiresAt: bundle.expiresAt,
      authorityExpiresAt: authority.expiresAt
    };
    const files: Array<[string, string | Buffer, number]> = [
      [this.authorityPath, authority.certificatePem, 0o644],
      [this.certificatePath, bundle.cert, 0o644],
      [this.encryptedAuthorityKeyPath, this.protector.encryptString(authority.privateKeyPem), 0o600],
      [this.encryptedKeyPath, this.protector.encryptString(bundle.key), 0o600],
      [this.metadataPath, JSON.stringify(metadata, null, 2), 0o600]
    ];
    for (const [target, content, mode] of files) {
      const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, content, { mode });
      await replaceFile(temporary, target);
    }
  }

  private get authorityPath(): string {
    return join(this.directory, "ani-tracker-ca.crt");
  }

  private get certificatePath(): string {
    return join(this.directory, "ani-tracker-server.crt");
  }

  private get encryptedKeyPath(): string {
    return join(this.directory, "ani-tracker-server.key.enc");
  }

  private get encryptedAuthorityKeyPath(): string {
    return join(this.directory, "ani-tracker-ca.key.enc");
  }

  private get metadataPath(): string {
    return join(this.directory, "ani-tracker-certificate.json");
  }
}

/** 生成十年有效的本地 CA，私钥仅交给系统安全存储加密。 */
function generateCertificateAuthority(now: Date): CertificateAuthority {
  const pki = forge.pki;
  const caKeys = pki.rsa.generateKeyPair(2048);
  const caCertificate = pki.createCertificate();
  caCertificate.publicKey = caKeys.publicKey;
  caCertificate.serialNumber = randomSerialNumber();
  caCertificate.validity.notBefore = new Date(now.getTime() - 60_000);
  caCertificate.validity.notAfter = addDays(now, AUTHORITY_LIFETIME_DAYS);
  const caName = [{ name: "commonName", value: "Ani Tracker Local CA" }];
  caCertificate.setSubject(caName);
  caCertificate.setIssuer(caName);
  caCertificate.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: "subjectKeyIdentifier" }
  ]);
  caCertificate.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    certificate: caCertificate,
    privateKey: caKeys.privateKey,
    certificatePem: pki.certificateToPem(caCertificate),
    privateKeyPem: pki.privateKeyToPem(caKeys.privateKey),
    expiresAt: caCertificate.validity.notAfter.toISOString()
  };
}

/** 使用稳定本地 CA 签发包含当前私网地址的服务端证书。 */
function generateServerCertificateBundle(
  addresses: string[],
  now: Date,
  authority: CertificateAuthority
): RemoteTlsCertificateBundle {
  const pki = forge.pki;
  const serverKeys = pki.rsa.generateKeyPair(2048);
  const serverCertificate = pki.createCertificate();
  serverCertificate.publicKey = serverKeys.publicKey;
  serverCertificate.serialNumber = randomSerialNumber();
  serverCertificate.validity.notBefore = new Date(now.getTime() - 60_000);
  serverCertificate.validity.notAfter = addDays(now, CERTIFICATE_LIFETIME_DAYS);
  serverCertificate.setSubject([{ name: "commonName", value: "Ani Tracker" }]);
  serverCertificate.setIssuer(authority.certificate.subject.attributes);
  serverCertificate.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
        ...addresses.map((address) => ({ type: 7, ip: address }))
      ]
    }
  ]);
  serverCertificate.sign(authority.privateKey, forge.md.sha256.create());

  const certificate = pki.certificateToPem(serverCertificate);
  return {
    key: pki.privateKeyToPem(serverKeys.privateKey),
    cert: certificate,
    ca: authority.certificatePem,
    fingerprint: createHash("sha256").update(forge.asn1.toDer(pki.certificateToAsn1(serverCertificate)).getBytes(), "binary").digest("hex"),
    expiresAt: serverCertificate.validity.notAfter.toISOString(),
    authorityCertificatePath: ""
  };
}

/** 原子替换文件；Windows 不允许直接覆盖时先移除旧目标。 */
async function replaceFile(temporary: string, target: string): Promise<void> {
  try {
    await rename(temporary, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") {
      throw error;
    }
    await rm(target, { force: true });
    await rename(temporary, target);
  }
}

function isReusableMetadata(metadata: StoredCertificateMetadata, addresses: string[], now: Date): boolean {
  if (metadata.version !== 1 || metadata.addresses.join("\0") !== addresses.join("\0")) {
    return false;
  }
  return Date.parse(metadata.expiresAt) - now.getTime() > ROTATE_BEFORE_DAYS * 24 * 60 * 60 * 1000;
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function randomSerialNumber(): string {
  return `01${randomBytes(15).toString("hex")}`;
}

/** 校验证书与解密私钥配对，拒绝复用半写入或损坏的凭据。 */
function certificateMatchesPrivateKey(certificatePem: string, privateKeyPem: string): boolean {
  try {
    return new X509Certificate(certificatePem).checkPrivateKey(createPrivateKey(privateKeyPem));
  } catch {
    return false;
  }
}

/** 校验证书、私钥、CA、指纹和 SAN 属于同一套可复用凭据。 */
function isConsistentCertificateBundle(
  certificatePem: string,
  privateKeyPem: string,
  authorityPem: string,
  metadata: StoredCertificateMetadata,
  addresses: string[]
): boolean {
  try {
    const certificate = new X509Certificate(certificatePem);
    const authority = new X509Certificate(authorityPem);
    const actualFingerprint = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
    const forgeCertificate = forge.pki.certificateFromPem(certificatePem);
    const subjectAltName = forgeCertificate.getExtension("subjectAltName") as { altNames?: Array<{ type: number; value?: string; ip?: string }> } | null;
    const dnsNames = new Set(subjectAltName?.altNames?.filter((item) => item.type === 2).map((item) => item.value) ?? []);
    const ipAddresses = new Set(subjectAltName?.altNames?.filter((item) => item.type === 7).map((item) => item.ip) ?? []);
    return (
      certificateMatchesPrivateKey(certificatePem, privateKeyPem) &&
      authority.ca &&
      certificate.checkIssued(authority) &&
      certificate.verify(authority.publicKey) &&
      actualFingerprint === metadata.fingerprint &&
      dnsNames.has("localhost") &&
      ipAddresses.has("127.0.0.1") &&
      addresses.every((address) => ipAddresses.has(address))
    );
  } catch {
    return false;
  }
}
