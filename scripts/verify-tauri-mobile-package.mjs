#!/usr/bin/env node
import { open, readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ARCHIVE_EXTENSIONS = {
  android: new Set([".apk", ".aab"]),
  ios: new Set([".ipa"])
};

const DEFAULT_ROOTS = {
  android: ["src-tauri/gen/android/app/build/outputs"],
  ios: ["src-tauri/gen/apple/build"]
};

const FORBIDDEN_ENTRIES = [
  { name: "远程 Web 资源", pattern: /(?:^|\/)(?:\.tauri-remote-pwa|\.remote-pwa|remote-pwa)(?:\/|$)/i },
  { name: "FFmpeg/FFprobe", pattern: /(?:^|\/)(?:ffmpeg|ffprobe)(?:\.exe)?$/i },
  { name: "托管 qBittorrent", pattern: /(?:^|\/)(?:qbittorrent(?:-nox)?)(?:\.exe)?$/i },
  { name: "桌面远程网关证书", pattern: /(?:^|\/)(?:server\.(?:pem|key)|ani-remote-ca\.(?:pem|key))$/i }
];

const REQUIRED_ENTRIES = {
  android: [
    { name: "ARM64 内置 torrent-core", pattern: /^(?:base\/)?lib\/arm64-v8a\/libani_torrent_core\.so$/i },
    { name: "ARM64 LibVLC 核心", pattern: /^(?:base\/)?lib\/arm64-v8a\/libvlc\.so$/i },
    { name: "ARM64 LibVLC JNI", pattern: /^(?:base\/)?lib\/arm64-v8a\/libvlcjni\.so$/i },
    { name: "torrent-core 许可证", pattern: /^(?:base\/)?assets\/licenses\/torrent-core\/libtorrent-BSD-3-Clause\.txt$/i },
    { name: "libVLC 来源说明", pattern: /^(?:base\/)?assets\/licenses\/vlc\/SOURCE\.md$/i },
    { name: "Android TLS 验证器许可证", pattern: /^(?:base\/)?assets\/licenses\/rustls-platform-verifier-MIT\.txt$/i },
    { name: "Ani Tracker 许可证", pattern: /^(?:base\/)?assets\/licenses\/ani-tracker\/LICENSE\.txt$/i }
  ],
  ios: [
    { name: "内置 AniTorrentCore", pattern: /^Payload\/[^/]+\.app\/Frameworks\/AniTorrentCore\.framework\/AniTorrentCore$/i },
    { name: "内置 MobileVLCKit", pattern: /^Payload\/[^/]+\.app\/Frameworks\/MobileVLCKit\.framework\/MobileVLCKit$/i },
    { name: "torrent-core 许可证", pattern: /^Payload\/[^/]+\.app\/assets\/licenses\/torrent-core\/libtorrent-BSD-3-Clause\.txt$/i },
    { name: "libVLC 来源说明", pattern: /^Payload\/[^/]+\.app\/assets\/licenses\/vlc\/SOURCE\.md$/i },
    { name: "Ani Tracker 许可证", pattern: /^Payload\/[^/]+\.app\/assets\/licenses\/ani-tracker-LICENSE\.txt$/i }
  ]
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}

/** 执行移动安装包发现、内容边界和签名策略检查。 */
async function main(args) {
  const options = parseArgs(args);
  const archives = options.archives.length > 0
    ? options.archives
    : await discoverArchives(options.platform, options.roots);

  if (archives.length === 0) {
    throw new Error(`[mobile-package] 未找到 ${options.platform} 安装包；可使用 --archive 指定路径`);
  }

  for (const archive of archives) {
    const entries = await readZipEntryNames(archive);
    verifyEntries(options.platform, archive, entries);
    if (options.requireUnsigned) verifyUnsignedIosPackage(options.platform, archive, entries);
  }

  console.log(`[mobile-package] ${options.platform} 安装包内容检查通过：${archives.length} 个产物`);
}

/** 检查移动安装包必须包含本地原生闭环，同时不得混入桌面专属资源。 */
export function verifyEntries(platform, archive, entries) {
  if (entries.length === 0) {
    throw new Error(`[mobile-package] 安装包为空或 ZIP 目录不可读：${archive}`);
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    const forbidden = FORBIDDEN_ENTRIES.find(({ pattern }) => pattern.test(normalized));
    if (forbidden) {
      throw new Error(`[mobile-package] ${platform} 安装包包含${forbidden.name}：${normalized}`);
    }
  }
  if (platform === "ios" && !entries.some((entry) => /^Payload\/[^/]+\.app\//i.test(entry.replaceAll("\\", "/")))) {
    throw new Error(`[mobile-package] iOS IPA 缺少 Payload/*.app：${archive}`);
  }
  const normalizedEntries = entries.map((entry) => entry.replaceAll("\\", "/"));
  const missing = REQUIRED_ENTRIES[platform].filter(
    ({ pattern }) => !normalizedEntries.some((entry) => pattern.test(entry))
  );
  if (missing.length > 0) {
    throw new Error(`[mobile-package] ${platform} 安装包缺少发布必需能力：${missing.map((item) => item.name).join("、")}`);
  }
}

/** 验证 iOS 用户重签包不携带签名目录或描述文件。 */
export function verifyUnsignedIosPackage(platform, archive, entries) {
  if (platform !== "ios") {
    throw new Error("[mobile-package] --require-unsigned 仅适用于 iOS IPA");
  }
  const signedEntry = entries.find((entry) => {
    const normalized = entry.replaceAll("\\", "/");
    return /(?:^|\/)_CodeSignature(?:\/|$)/i.test(normalized)
      || /(?:^|\/)embedded\.mobileprovision$/i.test(normalized);
  });
  if (signedEntry) {
    throw new Error(`[mobile-package] iOS 用户重签包仍包含签名材料：${signedEntry}`);
  }
}

/** 读取 APK、AAB 或 IPA 的 ZIP 中央目录文件名。 */
export async function readZipEntryNames(path) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    const tailLength = Math.min(metadata.size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await readExactly(handle, tail, metadata.size - tailLength, path);
    const endOffset = findEndOfCentralDirectory(tail);
    const entryCount = tail.readUInt16LE(endOffset + 10);
    const centralSize = tail.readUInt32LE(endOffset + 12);
    const centralOffset = tail.readUInt32LE(endOffset + 16);
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error(`[mobile-package] 暂不支持 ZIP64 安装包：${path}`);
    }
    const central = Buffer.alloc(centralSize);
    await readExactly(handle, central, centralOffset, path);
    return parseCentralDirectory(central, entryCount, path);
  } finally {
    await handle.close();
  }
}

/** 从归档尾部定位 ZIP End of Central Directory。 */
function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new Error("[mobile-package] ZIP 中央目录结尾不存在");
}

/** 将指定文件区间完整读入缓冲区，避免短读导致误判。 */
async function readExactly(handle, buffer, position, path) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error(`[mobile-package] ZIP 文件意外结束：${path}`);
    offset += bytesRead;
  }
}

/** 解析中央目录并拒绝损坏或跨磁盘归档。 */
function parseCentralDirectory(buffer, expectedEntries, archive) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`[mobile-package] ZIP 中央目录损坏：${archive}`);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const disk = buffer.readUInt16LE(offset + 34);
    if (disk !== 0) throw new Error(`[mobile-package] 不支持跨磁盘 ZIP：${archive}`);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new Error(`[mobile-package] ZIP 文件名越界：${archive}`);
    const encoding = (flags & 0x0800) !== 0 ? "utf8" : "latin1";
    entries.push(buffer.toString(encoding, nameStart, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }
  if (entries.length !== expectedEntries) {
    throw new Error(`[mobile-package] ZIP 文件数量不一致：期望 ${expectedEntries}，实际 ${entries.length}`);
  }
  return entries;
}

/** 在默认构建目录中递归发现对应平台的安装包。 */
async function discoverArchives(platform, roots) {
  const extensions = ARCHIVE_EXTENSIONS[platform];
  const archives = [];
  for (const root of roots) {
    archives.push(...await collectFiles(root, extensions));
  }
  return archives.sort();
}

/** 递归收集指定扩展名的文件；不存在的构建目录视为空。 */
async function collectFiles(root, extensions) {
  try {
    if (!(await stat(root)).isDirectory()) return [];
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return collectFiles(path, extensions);
      return entry.isFile() && extensions.has(extname(entry.name).toLowerCase()) ? [path] : [];
    }));
    return nested.flat();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** 解析平台、安装包路径和自定义搜索根目录。 */
function parseArgs(args) {
  const parsed = { platform: "", archives: [], roots: [], requireUnsigned: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--require-unsigned") {
      parsed.requireUnsigned = true;
      continue;
    }
    if (arg === "--platform" || arg === "--archive" || arg === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--platform") parsed.platform = value;
      if (arg === "--archive") parsed.archives.push(resolve(value));
      if (arg === "--root") parsed.roots.push(resolve(value));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!ARCHIVE_EXTENSIONS[parsed.platform]) {
    throw new Error("--platform 必须为 android 或 ios");
  }
  if (parsed.roots.length === 0) {
    parsed.roots = DEFAULT_ROOTS[parsed.platform].map((path) => resolve(path));
  }
  const extensions = ARCHIVE_EXTENSIONS[parsed.platform];
  for (const archive of parsed.archives) {
    if (!extensions.has(extname(archive).toLowerCase())) {
      throw new Error(`[mobile-package] ${parsed.platform} 安装包扩展名不受支持：${archive}`);
    }
  }
  return parsed;
}
