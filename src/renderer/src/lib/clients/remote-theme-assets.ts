import type {
  ExportThemePackageInput,
  SaveThemeBackgroundInput,
  ThemeBackgroundAsset,
  ThemeBackgroundReference
} from "@shared/contracts";

const DATABASE_NAME = "ani-remote-theme-assets";
const DATABASE_VERSION = 1;
const BACKGROUND_STORE = "backgrounds";
const MAX_BACKGROUND_BYTES = 3 * 1024 * 1024;

interface RemoteThemeBackgroundRecord {
  key: string;
  themeId: string;
  fileName: string;
  contentType: SaveThemeBackgroundInput["contentType"];
  size: number;
  dataBase64: string;
}

/** 将远程设备主题背景保存到当前浏览器，不写入 PC 宿主。 */
export async function saveRemoteThemeBackground(
  input: SaveThemeBackgroundInput
): Promise<ThemeBackgroundAsset> {
  const size = decodeBase64(input.dataBase64).byteLength;
  if (size <= 0 || size > MAX_BACKGROUND_BYTES) {
    throw new Error("主题背景图为空或超过 3 MiB 限制");
  }
  const record: RemoteThemeBackgroundRecord = {
    key: backgroundKey(input.themeId, input.fileName),
    themeId: input.themeId,
    fileName: input.fileName,
    contentType: input.contentType,
    size,
    dataBase64: input.dataBase64
  };
  const database = await openDatabase();
  await runTransaction(database, "readwrite", (store) => store.put(record));
  console.info("[remote] 当前设备主题背景已保存", {
    themeId: input.themeId,
    fileName: input.fileName,
    size
  });
  return toAsset(record);
}

/** 从当前浏览器读取远程设备主题背景。 */
export async function resolveRemoteThemeBackground(
  themeId: string,
  fileName: string
): Promise<ThemeBackgroundAsset | undefined> {
  const database = await openDatabase();
  const record = await runTransaction<RemoteThemeBackgroundRecord | undefined>(
    database,
    "readonly",
    (store) => store.get(backgroundKey(themeId, fileName))
  );
  return record ? toAsset(record) : undefined;
}

/** 清理当前浏览器中已无主题引用的背景文件。 */
export async function pruneRemoteThemeBackgrounds(
  references: ThemeBackgroundReference[]
): Promise<void> {
  const retained = new Set(references.map((item) => backgroundKey(item.themeId, item.fileName)));
  const database = await openDatabase();
  const keys = await runTransaction<IDBValidKey[]>(database, "readonly", (store) => store.getAllKeys());
  const staleKeys = keys.filter((key) => typeof key === "string" && !retained.has(key));
  if (staleKeys.length === 0) return;
  await runTransaction(database, "readwrite", (store) => {
    for (const key of staleKeys) store.delete(key);
    return undefined;
  });
  console.info("[remote] 已清理未引用主题背景", { count: staleKeys.length });
}

/** 使用浏览器下载能力导出远程设备主题包。 */
export async function exportRemoteThemePackage(input: ExportThemePackageInput): Promise<string> {
  const bytes = decodeBase64(input.dataBase64);
  const blob = new Blob([copyToArrayBuffer(bytes)], { type: input.contentType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = input.fileName;
    anchor.rel = "noopener";
    anchor.click();
    console.info("[remote] 当前设备主题包已导出", { fileName: input.fileName, size: bytes.byteLength });
    return input.fileName;
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** 在当前远程设备的新标签页打开 HTTP(S) 地址。 */
export async function openRemoteExternalUrl(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl, window.location.href);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅允许打开 HTTP(S) 地址");
  }
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

/** 生成主题背景在当前浏览器中的稳定复合键。 */
function backgroundKey(themeId: string, fileName: string): string {
  return `${themeId}\u0000${fileName}`;
}

/** 将浏览器主题记录转换为页面可读取的 Data URL 资产。 */
function toAsset(record: RemoteThemeBackgroundRecord): ThemeBackgroundAsset {
  return {
    themeId: record.themeId,
    fileName: record.fileName,
    contentType: record.contentType,
    size: record.size,
    url: `data:${record.contentType};base64,${record.dataBase64}`
  };
}

/** 严格解码主题文件 Base64 数据。 */
function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("主题文件 Base64 数据无效");
  }
}

/** 复制为 Blob 接受的普通 ArrayBuffer。 */
function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** 打开远程主题资产数据库并完成首次建表。 */
function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("当前浏览器不支持主题背景持久化"));
  }
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(BACKGROUND_STORE)) {
        request.result.createObjectStore(BACKGROUND_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("主题背景数据库打开失败"));
  });
}

/** 执行单个 IndexedDB 事务并统一处理完成、失败和取消状态。 */
function runTransaction<T = undefined>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T> | undefined
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(BACKGROUND_STORE, mode);
    const request = operation(transaction.objectStore(BACKGROUND_STORE));
    let result: T;
    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error("主题背景数据库操作失败"));
    }
    transaction.oncomplete = () => resolve(result!);
    transaction.onerror = () => reject(transaction.error ?? new Error("主题背景数据库事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("主题背景数据库事务已取消"));
  });
}
