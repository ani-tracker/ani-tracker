import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isPrivateIpv4Address,
  isTrustedHost,
  isTrustedOrigin,
  isTrustedRemoteHost,
  isTrustedRemoteOrigin,
  listPrivateIpv4Addresses,
  normalizePrivateIpv4Addresses,
  parseTrustedHost,
  parseTrustedRemoteOrigins
} from "../remote-network-policy";

test("私网地址策略只接受 RFC1918 IPv4", () => {
  assert.equal(isPrivateIpv4Address("10.1.2.3"), true);
  assert.equal(isPrivateIpv4Address("172.16.0.1"), true);
  assert.equal(isPrivateIpv4Address("172.31.255.254"), true);
  assert.equal(isPrivateIpv4Address("192.168.1.10"), true);
  assert.equal(isPrivateIpv4Address("172.32.0.1"), false);
  assert.equal(isPrivateIpv4Address("8.8.8.8"), false);
  assert.equal(isPrivateIpv4Address("127.0.0.1"), false);
});

test("注入地址仍会去重并过滤非私网 IPv4", () => {
  assert.deepEqual(
    normalizePrivateIpv4Addresses(["8.8.8.8", "192.168.1.20", "192.168.1.20", "127.0.0.1"]),
    ["192.168.1.20"]
  );
});

test("网卡地址列表去重并过滤公网、回环和 IPv6", () => {
  const result = listPrivateIpv4Addresses({
    Ethernet: [
      createAddress("192.168.1.20"),
      createAddress("192.168.1.20"),
      createAddress("8.8.8.8"),
      { ...createAddress("127.0.0.1"), internal: true },
      { ...createAddress("fe80::1"), family: "IPv6", scopeid: 0 }
    ]
  });
  assert.deepEqual(result, ["192.168.1.20"]);
});

test("Host 白名单要求显式端口并拒绝用户信息和伪造后缀", () => {
  const allowed = new Set(["localhost", "127.0.0.1", "192.168.1.20"]);
  assert.equal(parseTrustedHost("192.168.1.20:18083", 18083), "192.168.1.20");
  assert.equal(isTrustedHost("localhost:18083", 18083, allowed), true);
  assert.equal(isTrustedHost("192.168.1.20:18083", 18083, allowed), true);
  assert.equal(isTrustedHost("192.168.1.20:18084", 18083, allowed), false);
  assert.equal(isTrustedHost("192.168.1.20.attacker.test:18083", 18083, allowed), false);
  assert.equal(isTrustedHost("user@192.168.1.20:18083", 18083, allowed), false);
});

test("Origin 白名单拒绝用户信息、路径和跨协议来源", () => {
  const allowed = new Set(["localhost", "127.0.0.1", "192.168.1.20"]);
  assert.equal(isTrustedOrigin(undefined, "https", 18083, allowed), true);
  assert.equal(isTrustedOrigin("https://192.168.1.20:18083", "https", 18083, allowed), true);
  assert.equal(isTrustedOrigin("https://user@192.168.1.20:18083", "https", 18083, allowed), false);
  assert.equal(isTrustedOrigin("https://192.168.1.20:18083/path", "https", 18083, allowed), false);
  assert.equal(isTrustedOrigin("http://192.168.1.20:18083", "https", 18083, allowed), false);
});

test("公网 Origin 白名单只接受规范完整来源并精确校验 Host", () => {
  const origins = parseTrustedRemoteOrigins(
    "https://ani.momoc.top, HTTPS://ANI.MOMOC.TOP/,http://preview.example.test:8080,https://bad.test/path"
  );
  assert.deepEqual(origins.map((item) => item.origin), [
    "https://ani.momoc.top",
    "http://preview.example.test:8080"
  ]);
  assert.equal(isTrustedRemoteHost("ani.momoc.top", origins), true);
  assert.equal(isTrustedRemoteHost("ani.momoc.top:443", origins), true);
  assert.equal(isTrustedRemoteHost("ani.momoc.top.attacker.test", origins), false);
  assert.equal(isTrustedRemoteHost("preview.example.test:8080", origins), true);
  assert.equal(isTrustedRemoteHost("preview.example.test", origins), false);
  assert.equal(isTrustedRemoteOrigin("https://ani.momoc.top", origins), true);
  assert.equal(isTrustedRemoteOrigin("https://ani.momoc.top", origins, "ani.momoc.top"), true);
  assert.equal(isTrustedRemoteOrigin("http://preview.example.test:8080", origins, "ani.momoc.top"), false);
  assert.equal(isTrustedRemoteOrigin("https://ani.momoc.top/", origins), false);
  assert.equal(isTrustedRemoteOrigin("http://ani.momoc.top", origins), false);
});

function createAddress(address: string) {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`
  };
}
