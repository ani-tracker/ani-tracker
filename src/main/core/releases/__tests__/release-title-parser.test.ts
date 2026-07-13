import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { FansubGroup, Release } from "@shared/domain";
import { enrichReleaseFromTitle, parseReleaseTitle } from "../release-title-parser";

const fansubGroups: FansubGroup[] = [
  {
    id: "fansub-lolihouse",
    name: "LoliHouse",
    aliases: ["Loli House"],
    sourceIds: ["nyaa"]
  }
];

test("parseReleaseTitle 解析多季 SxxExx 标题中的集数和媒体字段", () => {
  const parsed = parseReleaseTitle("[LoliHouse] 测试番 S02E03 [1080p][x265][简繁]");

  assert.equal(parsed.fansubName, "LoliHouse");
  assert.equal(parsed.episodeNo, 3);
  assert.equal(parsed.resolution, "1080p");
  assert.equal(parsed.declaredVideoCodec, "x265");
  assert.equal(parsed.normalizedVideoCodec, "H.265/HEVC");
  assert.equal(parsed.subtitle, "multi");
});

test("parseReleaseTitle 解析中文第 N 话和小数集数", () => {
  const parsed = parseReleaseTitle("[字幕组] 测试番 第12.5话 [1920x1080][AVC][简日]");

  assert.equal(parsed.episodeNo, 12.5);
  assert.equal(parsed.resolution, "1080p");
  assert.equal(parsed.normalizedVideoCodec, "H.264/AVC");
  assert.equal(parsed.subtitle, "chs");
});

test("parseReleaseTitle 不把合集范围解析成单集", () => {
  const parsed = parseReleaseTitle("[字幕组] 测试番 [01-12][1080p][HEVC][繁体]");

  assert.equal(parsed.episodeNo, undefined);
  assert.equal(parsed.resolution, "1080p");
  assert.equal(parsed.normalizedVideoCodec, "H.265/HEVC");
  assert.equal(parsed.subtitle, "cht");
});

test("parseReleaseTitle 不把总集篇和 10bit 误判为集数", () => {
  const parsed = parseReleaseTitle("[字幕组] 测试番 总集篇 [1080p][HEVC][10bit][简体]");

  assert.equal(parsed.episodeNo, undefined);
  assert.equal(parsed.resolution, "1080p");
  assert.equal(parsed.normalizedVideoCodec, "H.265/HEVC");
  assert.equal(parsed.subtitle, "chs");
});

test("enrichReleaseFromTitle 保留已有字段并补充字幕组匹配", () => {
  const release: Release = {
    id: "release-1",
    title: "[Loli House] 测试番 S02E04 [4K][AV1][英文]",
    sourceId: "manual",
    sourceName: "Manual",
    publishedAt: "2026-07-13T12:00:00.000Z",
    episodeNo: 99,
    resolution: "720p"
  };

  const enriched = enrichReleaseFromTitle(release, fansubGroups);

  assert.equal(enriched.episodeNo, 99);
  assert.equal(enriched.resolution, "720p");
  assert.equal(enriched.fansubGroupId, "fansub-lolihouse");
  assert.equal(enriched.normalizedVideoCodec, "AV1");
  assert.equal(enriched.subtitle, "eng");
});
