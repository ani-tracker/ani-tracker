import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Release } from "../domain";
import {
  compareReleaseEpisodeDescending,
  dedupeReleasesByEpisodeContent,
  extractMagnetInfoHash,
  normalizeTorrentInfoHash
} from "../release-identity";

const hexInfoHash = "5448ae0ed36912eb0dfba53c3e495b9988841e68";
const base32InfoHash = "KREK4DWTNEJOWDP3UU6D4SK3TGEIIHTI";

test("十六进制与 Base32 磁链规范为同一 BTIH", () => {
  assert.equal(normalizeTorrentInfoHash(hexInfoHash.toUpperCase()), hexInfoHash);
  assert.equal(normalizeTorrentInfoHash(base32InfoHash), hexInfoHash);
  assert.equal(
    extractMagnetInfoHash(`magnet:?dn=Episode&xt=urn:btih:${base32InfoHash}&tr=https%3A%2F%2Ftracker.example`),
    hexInfoHash
  );
});

test("同集同 BTIH 跨来源合并但不同集保留", () => {
  const releases = dedupeReleasesByEpisodeContent([
    release("source-a", 8, { infoHash: hexInfoHash.toUpperCase() }),
    release("source-b", 8, { magnetUrl: `magnet:?xt=urn:btih:${base32InfoHash}&tr=udp%3A%2F%2Ftracker` }),
    release("source-c", 9, { infoHash: hexInfoHash })
  ]);

  assert.deepEqual(releases.map((item) => [item.sourceId, item.episodeNo]), [["source-a", 8], ["source-c", 9]]);
});

test("资源按集数倒序且未识别集数位于末尾", () => {
  const releases = [release("unknown", undefined), release("episode-8", 8), release("episode-12", 12)];
  releases.sort(compareReleaseEpisodeDescending);
  assert.deepEqual(releases.map((item) => item.episodeNo), [12, 8, undefined]);
});

/** 创建资源身份测试所需的最小发布数据。 */
function release(
  sourceId: string,
  episodeNo: number | undefined,
  overrides: Partial<Release> = {}
): Release {
  return {
    id: `release-${sourceId}`,
    title: `测试番 - ${episodeNo ?? "未知"}`,
    episodeNo,
    contentKind: episodeNo === undefined ? "unknown" : "episode",
    sourceId,
    sourceName: sourceId,
    publishedAt: "2026-08-04T00:00:00.000Z",
    ...overrides
  };
}
