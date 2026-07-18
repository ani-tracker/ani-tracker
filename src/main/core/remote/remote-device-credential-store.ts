import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretProtector } from "./remote-tls-certificate-store";
import { logger as defaultLogger } from "../logger";

export interface StoredRemoteDeviceCredential {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastAccessedAt: string | null;
  tokenHash: string;
}

export interface RemoteDeviceCredentialPersistence {
  load(): Promise<StoredRemoteDeviceCredential[]>;
  save(records: readonly StoredRemoteDeviceCredential[]): Promise<void>;
}

export interface RemoteDeviceCredentialStoreLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

interface StoredRemoteDeviceFile {
  version: 1;
  devices: StoredRemoteDeviceCredential[];
}

export class RemoteDeviceCredentialStore implements RemoteDeviceCredentialPersistence {
  /** 初始化经系统安全存储保护的远程设备凭据仓库。 */
  constructor(
    private readonly directory: string,
    private readonly protector: SecretProtector,
    private readonly logger: RemoteDeviceCredentialStoreLogger = defaultLogger
  ) {}

  /** 解密并校验已配对设备，文件缺失或损坏时安全返回空列表。 */
  async load(): Promise<StoredRemoteDeviceCredential[]> {
    try {
      if (!this.protector.isAvailable()) {
        throw new Error("系统安全存储不可用");
      }
      const encrypted = await readFile(this.filePath);
      const parsed = JSON.parse(this.protector.decryptString(encrypted)) as unknown;
      const records = parseStoredFile(parsed);
      this.logger.info("Remote device credentials loaded", { deviceCount: records.length });
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      this.logger.warn("Remote device credentials unavailable", {
        errorType: error instanceof Error ? error.name : typeof error
      });
      return [];
    }
  }

  /** 加密设备摘要并通过临时文件原子替换现有凭据。 */
  async save(records: readonly StoredRemoteDeviceCredential[]): Promise<void> {
    if (!this.protector.isAvailable()) {
      throw new Error("系统安全存储不可用，无法保存远程设备凭据");
    }
    await mkdir(this.directory, { recursive: true });
    const payload: StoredRemoteDeviceFile = {
      version: 1,
      devices: records.map(copyCredential)
    };
    const encrypted = this.protector.encryptString(JSON.stringify(payload));
    const temporary = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await replaceFile(temporary, this.filePath);
    this.logger.info("Remote device credentials saved", { deviceCount: records.length });
  }

  private get filePath(): string {
    return join(this.directory, "remote-devices.enc");
  }
}

/** 校验解密后的凭据文件，拒绝部分损坏或注入字段。 */
function parseStoredFile(value: unknown): StoredRemoteDeviceCredential[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.devices)) {
    throw new Error("远程设备凭据格式无效");
  }
  return value.devices.map((item) => {
    if (
      !isRecord(item)
      || typeof item.id !== "string"
      || !/^[a-f0-9]{32}$/.test(item.id)
      || typeof item.name !== "string"
      || !item.name.trim()
      || item.name.length > 80
      || !Array.isArray(item.scopes)
      || !item.scopes.every((scope) => typeof scope === "string" && scope.length > 0 && scope.length <= 80)
      || typeof item.createdAt !== "string"
      || !isIsoDate(item.createdAt)
      || !(item.lastAccessedAt === null || (typeof item.lastAccessedAt === "string" && isIsoDate(item.lastAccessedAt)))
      || typeof item.tokenHash !== "string"
      || Buffer.from(item.tokenHash, "base64").length !== 32
    ) {
      throw new Error("远程设备凭据记录无效");
    }
    return {
      id: item.id,
      name: item.name,
      scopes: [...new Set(item.scopes as string[])],
      createdAt: item.createdAt,
      lastAccessedAt: item.lastAccessedAt,
      tokenHash: item.tokenHash
    };
  });
}

/** 复制凭据，避免存储实现持有鉴权核心中的可变数组。 */
function copyCredential(record: StoredRemoteDeviceCredential): StoredRemoteDeviceCredential {
  return { ...record, scopes: [...record.scopes] };
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 校验可往返解析的 ISO 时间。 */
function isIsoDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/** 原子替换凭据文件并兼容 Windows 已存在目标。 */
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
