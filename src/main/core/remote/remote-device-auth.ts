import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import type { RemoteDeviceInfo, RemotePairingChallenge } from "@shared/contracts";
import { logger as defaultLogger } from "../logger";

const DEFAULT_PAIRING_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_CODE_RANGE = 1_000_000;
const UINT32_RANGE = 0x1_0000_0000;

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
  private readonly devices = new Map<string, RemoteDeviceRecord>();
  private pairingSession: PairingSession | undefined;

  /** 初始化设备配对核心，并允许测试替换时间与安全随机源。 */
  constructor(options: RemoteDeviceAuthOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.pairingTtlMs = toPositiveInteger(options.pairingTtlMs, DEFAULT_PAIRING_TTL_MS);
    this.maxPairingAttempts = toPositiveInteger(options.maxPairingAttempts, DEFAULT_MAX_PAIRING_ATTEMPTS);
    this.logger = options.logger ?? defaultLogger;
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
    return toPublicDevice(authenticated);
  }

  /** 列出可公开的设备元数据，不返回令牌及其摘要。 */
  listDevices(): RemoteDeviceInfo[] {
    return Array.from(this.devices.values(), toPublicDevice);
  }

  /** 吊销指定设备，令其已有令牌立即失效。 */
  revoke(deviceId: string): boolean {
    const revoked = this.devices.delete(deviceId);
    if (revoked) {
      this.logger.info("Remote device revoked", { deviceId });
    }
    return revoked;
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

/** 清理、去重并稳定保存设备权限范围。 */
function normalizeScopes(scopes: string[]): string[] {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
}

/** 将可选数值约束为正整数，否则采用安全默认值。 */
function toPositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
