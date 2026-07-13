import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReleaseSourceConfig } from "@shared/domain";
import { parseDmhyList } from "../dmhy-source";
import { parseMikanReleaseList } from "../mikan-source";
import { RssReleaseSource } from "../rss-source";
import { TorznabReleaseSource } from "../torznab-source";
import { parseXml, textValue, toArray } from "../xml";

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

const rssConfig: ReleaseSourceConfig = {
  id: "rss-test",
  name: "RSS 测试源",
  kind: "rss",
  enabled: true,
  rssUrl: "https://example.test/feed.xml"
};

const torznabConfig: ReleaseSourceConfig = {
  id: "torznab-test",
  name: "Torznab 测试源",
  kind: "torznab",
  enabled: true,
  baseUrl: "https://indexer.example.test/",
  apiKey: "test-api-key"
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

test("RssReleaseSource 解析 RSS item 的下载地址、体积和媒体字段", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    assert.equal(String(input), rssConfig.rssUrl);

    return new Response(
      `
        <rss>
          <channel>
            <item>
              <title>[喵萌奶茶屋] 测试番 - 04 [1080p][HEVC][繁日]</title>
              <link>magnet:?xt=urn:btih:FACEB00C&amp;dn=test</link>
              <guid>rss-guid-04</guid>
              <pubDate>Mon, 13 Jul 2026 12:30:00 GMT</pubDate>
              <enclosure url="https://example.test/test.torrent" length="2147483648" />
            </item>
          </channel>
        </rss>
      `,
      { status: 200, statusText: "OK" }
    );
  });

  const releases = await new RssReleaseSource(rssConfig).searchReleases({ keyword: "测试番", limit: 10 });

  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "rss-test:rss-guid-04");
  assert.equal(releases[0].title, "[喵萌奶茶屋] 测试番 - 04 [1080p][HEVC][繁日]");
  assert.equal(releases[0].magnetUrl, "magnet:?xt=urn:btih:FACEB00C&dn=test");
  assert.equal(releases[0].torrentUrl, undefined);
  assert.equal(releases[0].size, 2147483648);
  assert.equal(releases[0].publishedAt, "Mon, 13 Jul 2026 12:30:00 GMT");
  assert.equal(releases[0].episodeNo, 4);
  assert.equal(releases[0].resolution, "1080p");
  assert.equal(releases[0].normalizedVideoCodec, "H.265/HEVC");
  assert.equal(releases[0].subtitle, "cht");
});

test("TorznabReleaseSource 解析 torznab attr、enclosure 和查询参数", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    assert.equal(url.href, "https://indexer.example.test/api?t=search&q=%E6%B5%8B%E8%AF%95%E7%95%AA&apikey=test-api-key");

    return new Response(
      `
        <rss>
          <channel>
            <item>
              <title>[桜都字幕组] 测试番 - 05 [2160p][AV1][简体]</title>
              <guid>torznab-guid-05</guid>
              <link>https://indexer.example.test/download/05.torrent</link>
              <pubDate>Mon, 13 Jul 2026 13:30:00 GMT</pubDate>
              <enclosure url="https://indexer.example.test/download/05.torrent" length="3221225472" />
              <torznab:attr name="seeders" value="42" />
              <torznab:attr name="size" value="4000000000" />
            </item>
          </channel>
        </rss>
      `,
      { status: 200, statusText: "OK" }
    );
  });

  const releases = await new TorznabReleaseSource(torznabConfig).searchReleases({ keyword: "测试番", limit: 5 });

  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "torznab-test:torznab-guid-05");
  assert.equal(releases[0].title, "[桜都字幕组] 测试番 - 05 [2160p][AV1][简体]");
  assert.equal(releases[0].torrentUrl, "https://indexer.example.test/download/05.torrent");
  assert.equal(releases[0].magnetUrl, undefined);
  assert.equal(releases[0].size, 3221225472);
  assert.equal(releases[0].seeders, 42);
  assert.equal(releases[0].publishedAt, "Mon, 13 Jul 2026 13:30:00 GMT");
  assert.equal(releases[0].episodeNo, 5);
  assert.equal(releases[0].resolution, "2160p");
  assert.equal(releases[0].normalizedVideoCodec, "AV1");
  assert.equal(releases[0].subtitle, "chs");
});

test("xml helpers 解析文本节点并把单值转成数组", () => {
  const parsed = parseXml<{
    rss: {
      channel: {
        title: { "#text": string };
        item: Array<{ title: string }> | { title: string };
      };
    };
  }>(`
    <rss>
      <channel>
        <title>Ani Tracker</title>
        <item><title>第一项</title></item>
        <item><title>第二项</title></item>
      </channel>
    </rss>
  `);

  const items = toArray(parsed.rss.channel.item);

  assert.equal(textValue(parsed.rss.channel.title), "Ani Tracker");
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => textValue(item.title)), ["第一项", "第二项"]);
  assert.deepEqual(toArray(undefined), []);
});
