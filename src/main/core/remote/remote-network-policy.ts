import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

type NetworkInterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface TrustedRemoteOrigin {
  origin: string;
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
}

/** 返回可供局域网客户端访问的 RFC1918 IPv4 地址。 */
export function listPrivateIpv4Addresses(interfaces: NetworkInterfaceMap = networkInterfaces()): string[] {
  const addresses = Object.values(interfaces)
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal && isPrivateIpv4Address(item.address))
    .map((item) => item.address);
  return [...new Set(addresses)].sort((left, right) => left.localeCompare(right));
}

/** 过滤并规范化来自网卡或测试注入器的私网 IPv4 地址。 */
export function normalizePrivateIpv4Addresses(addresses: readonly string[]): string[] {
  return [...new Set(addresses.filter(isPrivateIpv4Address))].sort((left, right) => left.localeCompare(right));
}

/** 判断地址是否属于不经公网路由的 RFC1918 IPv4 网段。 */
export function isPrivateIpv4Address(address: string): boolean {
  if (isIP(address) !== 4) {
    return false;
  }
  const [first, second] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** 从 Host 请求头提取主机名，拒绝缺失端口、用户信息和非法格式。 */
export function parseTrustedHost(value: string | undefined, expectedPort: number): string | undefined {
  if (!value || value.includes("@") || value.includes("/")) {
    return undefined;
  }
  try {
    const url = new URL(`https://${value}`);
    if (url.port !== String(expectedPort)) {
      return undefined;
    }
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** 判断 Host 是否位于显式白名单中。 */
export function isTrustedHost(value: string | undefined, expectedPort: number, allowedHosts: ReadonlySet<string>): boolean {
  const hostname = parseTrustedHost(value, expectedPort);
  return Boolean(hostname && allowedHosts.has(hostname));
}

/** 判断 Origin 是否为不含用户信息和路径的规范同源地址。 */
export function isTrustedOrigin(
  value: string | undefined,
  protocol: "http" | "https",
  expectedPort: number,
  allowedHosts: ReadonlySet<string>
): boolean {
  if (!value) {
    return true;
  }
  try {
    const origin = new URL(value);
    return (
      value.toLowerCase() === origin.origin.toLowerCase() &&
      !origin.username &&
      !origin.password &&
      origin.protocol === `${protocol}:` &&
      origin.port === String(expectedPort) &&
      allowedHosts.has(origin.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** 解析逗号分隔的公网 Origin 白名单，忽略非法或带路径的配置项。 */
export function parseTrustedRemoteOrigins(value: string | undefined): TrustedRemoteOrigin[] {
  if (!value?.trim()) {
    return [];
  }

  const origins = new Map<string, TrustedRemoteOrigin>();
  for (const candidate of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    try {
      const url = new URL(candidate);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        continue;
      }
      const origin = url.origin.toLowerCase();
      origins.set(origin, {
        origin,
        protocol: url.protocol as TrustedRemoteOrigin["protocol"],
        hostname: url.hostname.toLowerCase(),
        port: effectiveOriginPort(url)
      });
    } catch {
      // 单个配置错误不应导致远程服务整体无法启动。
    }
  }
  return [...origins.values()];
}

/** 判断反向代理透传的 Host 是否匹配某个显式公网 Origin。 */
export function isTrustedRemoteHost(
  value: string | undefined,
  trustedOrigins: readonly TrustedRemoteOrigin[]
): boolean {
  return trustedOrigins.some((trusted) => matchesTrustedRemoteHost(value, trusted));
}

/** 判断浏览器 Origin 是否精确命中显式公网白名单。 */
export function isTrustedRemoteOrigin(
  value: string | undefined,
  trustedOrigins: readonly TrustedRemoteOrigin[],
  host?: string
): boolean {
  if (!value) {
    return true;
  }
  try {
    const origin = new URL(value);
    return (
      value.toLowerCase() === origin.origin.toLowerCase() &&
      trustedOrigins.some((trusted) =>
        trusted.origin === origin.origin.toLowerCase() &&
        (host === undefined || matchesTrustedRemoteHost(host, trusted))
      )
    );
  } catch {
    return false;
  }
}

/** 判断 Host 是否与单个公网 Origin 的主机和有效端口严格一致。 */
function matchesTrustedRemoteHost(value: string | undefined, trusted: TrustedRemoteOrigin): boolean {
  if (!value || value.includes("@") || value.includes("/") || value.includes("?") || value.includes("#")) {
    return false;
  }
  try {
    const host = new URL(`${trusted.protocol}//${value}`);
    return (
      !host.username &&
      !host.password &&
      host.pathname === "/" &&
      host.hostname.toLowerCase() === trusted.hostname &&
      effectiveOriginPort(host) === trusted.port
    );
  } catch {
    return false;
  }
}

/** 返回 Origin 的有效端口，统一处理 HTTP/HTTPS 默认端口。 */
function effectiveOriginPort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "80";
}
