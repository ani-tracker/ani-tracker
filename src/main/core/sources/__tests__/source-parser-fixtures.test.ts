import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReleaseSourceConfig } from "@shared/domain";
import { parseDmhyList } from "../dmhy-source";
import { parseMikanReleaseList } from "../mikan-source";

const dmhyConfig: ReleaseSourceConfig = {
  id: "dmhy",
  name: "动漫花园",
  kind: "site_adapter",
  enabled: true,
  baseUrl: "https://share.dmhy.org/"
};

const mikanConfig: ReleaseSourceConfig = {
  id: "mikan-site",
  name: "蜜柑计划站点",
  kind: "site_adapter",
  enabled: true,
  baseUrl: "https://mikanani.me/"
};

test("parseDmhyList 解析资源行中的标题、下载地址和媒体字段", () => {
  const releases = parseDmhyList(
    `
      <table>
        <tr>
          <td>2026/07/13 12:30</td>
          <td><a href="/topics/view/123456_test.html">[喵萌奶茶屋] 葬送的芙莉莲 - 01 [1080p][HEVC][简日]</a></td>
          <td><a href="magnet:?xt=urn:btih:ABCDEF1234567890&dn=test">磁力</a></td>
          <td><a href="/topics/download/123456.torrent">下载种子</a></td>
          <td>1.25 GiB</td>
        </tr>
      </table>
    `,
    dmhyConfig
  );

  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "dmhy:abcdef1234567890");
  assert.equal(releases[0].title, "[喵萌奶茶屋] 葬送的芙莉莲 - 01 [1080p][HEVC][简日]");
  assert.equal(releases[0].torrentUrl, "https://share.dmhy.org/topics/download/123456.torrent");
  assert.equal(releases[0].infoHash, "abcdef1234567890");
  assert.equal(releases[0].episodeNo, 1);
  assert.equal(releases[0].resolution, "1080p");
  assert.equal(releases[0].normalizedVideoCodec, "H.265/HEVC");
  assert.equal(releases[0].subtitle, "chs");
  assert.equal(releases[0].size, 1342177280);
});

test("parseMikanReleaseList 解析搜索结果中的 Episode、torrent、magnet 和体积", () => {
  const releases = parseMikanReleaseList(
    `
      <table>
        <tr>
          <td>2026/07/13 12:30</td>
          <td><a href="/Home/Episode/456">[桜都字幕组] 测试番 - 02 [1080p][AVC][简体]</a></td>
          <td><a href="/Download/456.torrent">下载种子</a></td>
          <td><a href="magnet:?xt=urn:btih:1234ABCD&dn=test">磁力</a></td>
          <td>512.5 MB</td>
        </tr>
      </table>
    `,
    mikanConfig
  );

  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "mikan-site:456");
  assert.equal(releases[0].title, "[桜都字幕组] 测试番 - 02 [1080p][AVC][简体]");
  assert.equal(releases[0].torrentUrl, "https://mikanani.me/Download/456.torrent");
  assert.equal(releases[0].magnetUrl, "magnet:?xt=urn:btih:1234ABCD&dn=test");
  assert.equal(releases[0].infoHash, "1234abcd");
  assert.equal(releases[0].episodeNo, 2);
  assert.equal(releases[0].resolution, "1080p");
  assert.equal(releases[0].normalizedVideoCodec, "H.264/AVC");
  assert.equal(releases[0].subtitle, "chs");
  assert.equal(releases[0].size, 512500000);
});

test("parseMikanReleaseList 在只有 Episode 链接时兜底生成 torrent 地址", () => {
  const releases = parseMikanReleaseList(
    `
      <div>
        <a href="/Home/Episode/789">[字幕组] 测试番 - 03 [720p]</a>
      </div>
    `,
    mikanConfig
  );

  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "mikan-site:789");
  assert.equal(releases[0].torrentUrl, "https://mikanani.me/Download/789.torrent");
  assert.equal(releases[0].episodeNo, 3);
  assert.equal(releases[0].resolution, "720p");
});
