import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import type { RemoteDeviceInfo, RemotePairingChallenge } from "@shared/contracts";
import { logger as defaultLogger } from "../logger";
import type {
  RemoteDeviceCredentialPersistence,
  StoredRemoteDeviceCredential
} from "./remote-device-credential-store";

const DEFAULT_PAIRING_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_CODE_RANGE = 1_000_000;
const UINT32_RANGE = 0x1_0000_0000;
const DEFAULT_ACCESS_PERSISTENCE_INTERVAL_MS = 60 * 1_000;

export interface RemotePairingResult {
  device: RemoteDeviceInfo;
  token: string;
}

export type RemoteDeviceAuthErrorCode =
  | "PAIRING_NOT_ACTIVE"
  | "PAIRING_EXPIRED"
  | "PAIRING_CODE_INVALID"
  | "PAIRING_LOCKED"
  | "DEVICE_NAME_REQUIRED";

export interface RemoteDeviceAuthLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface RemoteDeviceAuthOptions {
  clock?: () => number;
  randomBytes?: (size: number) => Buffer;
  pairingTtlMs?: number;
  maxPairingAttempts?: number;
  logger?: RemoteDeviceAuthLogger;
  credentialStore?: RemoteDeviceCredentialPersistence;
  accessPersistenceIntervalMs?: number;
}

interface RemoteDeviceRecord extends RemoteDeviceInfo {
  tokenHash: Buffer;
}

interface PairingSession {
  codeHash: Buffer;
  expiresAt: number;
  failedAttempts: number;
}

export class RemoteDeviceAuthError extends Error {
  /** 创建可供调用层稳定识别的设备鉴权错误。 */
  constructor(
    public readonly code: RemoteDeviceAuthErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RemoteDeviceAuthError";
  }
}

export class RemoteDeviceAuth {
  private readonly clock: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly pairingTtlMs: number;
  private readonly maxPairingAttempts: number;
  private readonly logger: RemoteDeviceAuthLogger;
  private readonly credentialStore?: RemoteDeviceCredentialPersistence;
  private readonly accessPersistenceIntervalMs: number;
  private readonly devices = new Map<string, RemoteDeviceRecord>();
  private readonly lastPersistedAccess = new Map<string, number>();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private persistenceError: Error | undefined;
  private initialized = false;
  private pairingSession: PairingSession | undefined;

  /** 初始化设备配对核心，并允许测试替换时间与安全随机源。 */
  constructor(options: RemoteDeviceAuthOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.pairingTtlMs = toPositiveInteger(options.pairingTtlMs, DEFAULT_PAIRING_TTL_MS);
    this.maxPairingAttempts = toPositiveInteger(options.maxPairingAttempts, DEFAULT_MAX_PAIRING_ATTEMPTS);
    this.logger = options.logger ?? defaultLogger;
    this.credentialStore = options.credentialStore;
    this.accessPersistenceIntervalMs = toPositiveInteger(
      options.accessPersistenceIntervalMs,
      DEFAULT_ACCESS_PERSISTENCE_INTERVAL_MS
    );
  }

  /** 从加密凭据仓库恢复已配对设备，重复调用不会重复加载。 */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    if (!this.credentialStore) {
      return;
    }
    const records = await this.credentialStore.load();
    for (const stored of records) {
      const tokenHash = Buffer.from(stored.tokenHash, "base64");
      this.devices.set(stored.id, {
        id: stored.id,
        name: stored.name,
        scopes: [...stored.scopes],
        createdAt: stored.createdAt,
        lastAccessedAt: stored.lastAccessedAt,
        tokenHash
      });
    }
    this.logger.info("Remote paired devices restored", { deviceCount: records.length });
  }

  /** 创建新的六位一次性配对码，并立即废止之前未使用的配对码。 */
  createPairingCode(): RemotePairingChallenge {
    const now = this.clock();
    const code = this.generatePairingCode();
    const expiresAt = now + this.pairingTtlMs;
    this.pairingSession = {
      codeHash: hashSecret(code),
      expiresAt,
      failedAttempts: 0
    };
    this.logger.info("Remote device pairing session created", {
      expiresAt: new Date(expiresAt).toISOString()
    });
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  /** 使用一次性配对码登记设备，并仅在本次响应中返回明文令牌。 */
  pairDevice(code: string, name: string, scopes: string[]): RemotePairingResult {
    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new RemoteDeviceAuthError("DEVICE_NAME_REQUIRED", "Device name is required");
    }

    const session = this.requireActivePairingSession();
    if (!isSecretEqual(session.codeHash, code)) {
      this.rejectPairingAttempt(session);
    }

    this.pairingSession = undefined;
    const now = new Date(this.clock()).toISOString();
    const token = this.randomBytes(32).toString("base64url");
    const record: RemoteDeviceRecord = {
      id: this.createDeviceId(),
      name: normalizedName,
      scopes: normalizeScopes(scopes),
      createdAt: now,
      lastAccessedAt: null,
      tokenHash: hashSecret(token)
    };
    this.devices.set(record.id, record);
    this.schedulePersistence();
    this.logger.info("Remote device paired", {
      deviceId: record.id,
      deviceName: record.name,
      scopes: record.scopes
    });
    return {
      device: toPublicDevice(record),
      token
    };
  }

  /** 校验设备令牌；成功时刷新最后访问时间，失败时不暴露设备信息。 */
  authenticate(token: string): RemoteDeviceInfo | undefined {
    const candidateHash = hashSecret(token);
    let authenticated: RemoteDeviceRecord | undefined;
    for (const record of this.devices.values()) {
      if (timingSafeEqual(record.tokenHash, candidateHash)) {
        authenticated = record;
      }
    }

    if (!authenticated) {
      this.logger.warn("Remote device authentication failed");
      return undefined;
    }

    authenticated.lastAccessedAt = new Date(this.clock()).toISOString();
    const lastPersistedAt = this.lastPersistedAccess.get(authenticated.id) ?? 0;
    if (this.clock() - lastPersistedAt >= this.accessPersistenceIntervalMs) {
      this.lastPersistedAccess.set(authenticated.id, this.clock());
      this.schedulePersistence();
    }
    return toPublicDevice(authenticated);
  }

  /** 列出可公开的设备元数据，不返回令牌及其摘要。 */
  listDevices(): RemoteDeviceInfo[] {
    return Array.from(this.devices.values(), toPublicDevice);
  }

  /** 为已配对设备补充服务端批准的权限，用于兼容新增的固定能力。 */
  grantScopes(deviceId: string, scopes: string[]): RemoteDeviceInfo | undefined {
    const record = this.devices.get(deviceId);
    if (!record) {
      return undefined;
    }
    const nextScopes = normalizeScopes([...record.scopes, ...scopes]);
    if (nextScopes.length !== record.scopes.length) {
      record.scopes = nextScopes;
      this.schedulePersistence();
      this.logger.info("Remote device scopes extended", { deviceId, scopes: nextScopes });
    }
    return toPublicDevice(record);
  }

  /** 吊销指定设备，令其已有令牌立即失效。 */
  revoke(deviceId: string): boolean {
    const revoked = this.devices.delete(deviceId);
    if (revoked) {
      this.lastPersistedAccess.delete(deviceId);
      this.schedulePersistence();
      this.logger.info("Remote device revoked", { deviceId });
    }
    return revoked;
  }

  /** 等待已排队的设备凭据写入完成。 */
  async flush(): Promise<void> {
    await this.persistenceQueue;
    if (this.persistenceError) {
      throw this.persistenceError;
    }
  }

  /** 将当前设备快照顺序写入加密仓库，避免并发覆盖较新的状态。 */
  private schedulePersistence(): void {
    if (!this.credentialStore) {
      return;
    }
    const snapshot = [...this.devices.values()].map(toStoredCredential);
    this.persistenceQueue = this.persistenceQueue
      .then(() => this.credentialStore?.save(snapshot))
      .then(() => {
        this.persistenceError = undefined;
      })
      .catch((error: unknown) => {
        this.persistenceError = error instanceof Error ? error : new Error("远程设备凭据保存失败");
        this.logger.warn("Remote device credential persistence failed", {
          errorType: error instanceof Error ? error.name : typeof error
        });
      });
  }

  /** 获取当前有效配对会话，并清理已过期会话。 */
  private requireActivePairingSession(): PairingSession {
    const session = this.pairingSession;
    if (!session) {
      throw new RemoteDeviceAuthError("PAIRING_NOT_ACTIVE", "No active pairing session");
    }
    if (this.clock() >= session.expiresAt) {
      this.pairingSession = undefined;
      this.logger.warn("Remote device pairing session expired");
      throw new RemoteDeviceAuthError("PAIRING_EXPIRED", "Pairing code has expired");
    }
    return session;
  }

  /** 记录错误配对并在达到上限时锁定当前会话。 */
  private rejectPairingAttempt(session: PairingSession): never {
    session.failedAttempts += 1;
    if (session.failedAttempts >= this.maxPairingAttempts) {
      this.pairingSession = undefined;
      this.logger.warn("Remote device pairing session locked after invalid attempts", {
        failedAttempts: session.failedAttempts
      });
      throw new RemoteDeviceAuthError("PAIRING_LOCKED", "Pairing session is locked");
    }
    this.logger.warn("Remote device pairing attempt rejected", {
      failedAttempts: session.failedAttempts,
      remainingAttempts: this.maxPairingAttempts - session.failedAttempts
    });
    throw new RemoteDeviceAuthError("PAIRING_CODE_INVALID", "Pairing code is invalid");
  }

  /** 通过拒绝采样生成无取模偏差的六位数字配对码。 */
  private generatePairingCode(): string {
    const acceptanceLimit = Math.floor(UINT32_RANGE / PAIRING_CODE_RANGE) * PAIRING_CODE_RANGE;
    let value: number;
    do {
      value = this.randomBytes(4).readUInt32BE(0);
    } while (value >= acceptanceLimit);
    return String(value % PAIRING_CODE_RANGE).padStart(6, "0");
  }

  /** 创建不承载身份信息的随机设备标识。 */
  private createDeviceId(): string {
    let deviceId: string;
    do {
      deviceId = this.randomBytes(16).toString("hex");
    } while (this.devices.has(deviceId));
    return deviceId;
  }
}

/** 计算服务端持有的固定长度 SHA-256 摘要。 */
function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** 使用常量时间比较校验敏感值，避免直接比较明文。 */
function isSecretEqual(expectedHash: Buffer, candidate: string): boolean {
  return timingSafeEqual(expectedHash, hashSecret(candidate));
}

/** 生成隔离内部摘要字段和可变数组的公开设备副本。 */
function toPublicDevice(record: RemoteDeviceRecord): RemoteDeviceInfo {
  return {
    id: record.id,
    name: record.name,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    lastAccessedAt: record.lastAccessedAt
  };
}

/** 生成不含明文令牌的持久化凭据快照。 */
function toStoredCredential(record: RemoteDeviceRecord): StoredRemoteDeviceCredential {
  return {
    id: record.id,
    name: record.name,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    lastAccessedAt: record.lastAccessedAt,
    tokenHash: record.tokenHash.toString("base64")
  };
}

/** 清理、去重并稳定保存设备权限范围。 */
function normalizeScopes(scopes: string[]): string[] {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
}

/** 将可选数值约束为正整数，否则采用安全默认值。 */
function toPositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
