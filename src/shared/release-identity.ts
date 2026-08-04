import type { Release } from "./domain";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 生成包含集数边界的资源内容键，避免相同 BTIH 跨集误合并。 */
export function getReleaseEpisodeContentKey(release: Release): string {
  return `${getReleaseEpisodeIdentity(release)}|${getReleaseContentIdentity(release)}`;
}

/** 按集数与种子内容去重，输入顺序决定重复项的保留版本。 */
export function dedupeReleasesByEpisodeContent(releases: Release[]): Release[] {
  const seen = new Set<string>();
  return releases.filter((release) => {
    const key = getReleaseEpisodeContentKey(release);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 比较资源集数，较新的单集或连集范围排在前面。 */
export function compareReleaseEpisodeDescending(left: Release, right: Release): number {
  return getReleaseEpisodeOrder(right) - getReleaseEpisodeOrder(left);
}

/** 将十六进制或 Base32 BTIH 统一为小写十六进制。 */
export function normalizeTorrentInfoHash(value?: string): string | undefined {
  const normalized = value?.trim().replace(/^urn:btih:/i, "");
  if (!normalized) return undefined;
  if (/^[a-f0-9]{40}$/i.test(normalized)) return normalized.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(normalized)) return decodeBase32InfoHash(normalized);
  return /^[a-z0-9]{8,64}$/i.test(normalized) ? normalized.toLowerCase() : undefined;
}

/** 从磁力链接的 xt 参数读取并规范化 BTIH。 */
export function extractMagnetInfoHash(magnetUrl?: string): string | undefined {
  if (!magnetUrl) return undefined;
  try {
    const url = new URL(magnetUrl.trim());
    if (url.protocol.toLowerCase() !== "magnet:") return undefined;
    for (const [key, value] of url.searchParams) {
      if (key.toLowerCase() !== "xt") continue;
      const match = /^urn:btih:(.+)$/i.exec(value);
      const infoHash = normalizeTorrentInfoHash(match?.[1]);
      if (infoHash) return infoHash;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 从严格的 40 位十六进制 torrent 文件名提取 BTIH。 */
export function extractTorrentUrlInfoHash(torrentUrl?: string): string | undefined {
  if (!torrentUrl) return undefined;
  try {
    const url = new URL(torrentUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const fileName = url.pathname.split("/").at(-1) ?? "";
    const match = /^([a-f0-9]{40})\.torrent$/i.exec(fileName);
    return match?.[1].toLowerCase();
  } catch {
    return undefined;
  }
}

/** 生成单集、连集和合集均稳定的集数身份。 */
function getReleaseEpisodeIdentity(release: Release): string {
  if (release.episodeRange) {
    return `range:${formatEpisodeIdentityNumber(release.episodeRange.start)}-${formatEpisodeIdentityNumber(release.episodeRange.end)}`;
  }
  if (release.episodeNo !== undefined && Number.isFinite(release.episodeNo)) {
    return `episode:${formatEpisodeIdentityNumber(release.episodeNo)}`;
  }
  if (release.contentKind === "batch") {
    return `batch:${release.seriesSeasonNo ?? "unknown"}`;
  }
  return "unknown";
}

/** 优先按 BTIH 标识内容，缺失时退回原始下载地址或资源 ID。 */
function getReleaseContentIdentity(release: Release): string {
  const infoHash = normalizeTorrentInfoHash(release.infoHash)
    ?? extractMagnetInfoHash(release.magnetUrl)
    ?? extractTorrentUrlInfoHash(release.torrentUrl);
  if (infoHash) return `btih:${infoHash}`;
  if (release.magnetUrl?.trim()) return `magnet:${release.magnetUrl.trim()}`;
  if (release.torrentUrl?.trim()) return `torrent:${release.torrentUrl.trim()}`;
  return `release:${release.sourceId}:${release.id || release.title}`;
}

/** 返回排序使用的集数上界，未识别资源放在普通单集之后。 */
function getReleaseEpisodeOrder(release: Release): number {
  const value = release.episodeRange?.end ?? release.episodeNo;
  return value !== undefined && Number.isFinite(value) ? value : -1;
}

/** 避免 8 与 8.0 形成不同集数身份。 */
function formatEpisodeIdentityNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

/** 将 32 位 Base32 SHA-1 内容解码为 40 位十六进制。 */
function decodeBase32InfoHash(value: string): string | undefined {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) return undefined;
    buffer = (buffer << 5) | index;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
    buffer &= bits === 0 ? 0 : (1 << bits) - 1;
  }
  if (bytes.length !== 20 || bits !== 0) return undefined;
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
