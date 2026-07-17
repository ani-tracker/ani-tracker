import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

type NetworkInterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

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
