import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReleaseSourceConfig } from "@shared/domain";
import { sourceConfigs } from "../../mock-data";
import { parseAcgnxApiResponse, parseAcgnxHtml } from "../acgnx-source";
import { AniBtReleaseSource, createAniBtHeaders, parseAniBtRss } from "../anibt-source";
import { parseDmhyList } from "../dmhy-source";
import { MikanReleaseSource, parseMikanReleaseList, type ReleaseHttpClient } from "../mikan-source";
import { createReleaseSource, ReleaseSourceService } from "../release-source-service";
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

const anibtConfig: ReleaseSourceConfig = {
  id: "anibt",
  name: "AniBT",
  kind: "site_adapter",
  enabled: true,
  baseUrl: "https://anibt.net/"
};

const acgnxConfig: ReleaseSourceConfig = {
  id: "acgnx",
  name: "末日动漫资源库 ACGNX",
  kind: "site_adapter",
  enabled: true,
  baseUrl: "https://share.acgnx.se/"
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

test("默认下载源包含 AniBT 和 ACGNX 且可创建站点适配器", () => {
  const anibt = sourceConfigs.find((source) => source.id === "anibt");
  const acgnx = sourceConfigs.find((source) => source.id === "acgnx");

  assert.ok(anibt);
  assert.ok(acgnx);
  assert.equal(anibt.enabled, false);
  assert.equal(acgnx.enabled, false);
  assert.equal(createReleaseSource(anibt)?.config.id, "anibt");
  assert.equal(createReleaseSource(acgnx)?.config.id, "acgnx");
});

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

test("MikanReleaseSource 使用注入 HTTP client 请求搜索页", async () => {
  const requests: Array<{ url: string; options?: Parameters<ReleaseHttpClient["fetch"]>[1] }> = [];
  const httpClient: ReleaseHttpClient = {
    async fetch(input, options) {
      requests.push({ url: String(input), options });
      return new Response(
        `
          <div>
            <a href="/Home/Episode/901">[字幕组] 代理测试番 - 01 [1080p]</a>
          </div>
        `,
        { status: 200, statusText: "OK" }
      );
    }
  };

  const releases = await new MikanReleaseSource(mikanConfig, httpClient).searchReleases({ keyword: "代理测试番", limit: 5 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://mikanani.me/Home/Search?searchstr=%E4%BB%A3%E7%90%86%E6%B5%8B%E8%AF%95%E7%95%AA");
  assert.equal(requests[0].options?.source, "mikan-release");
  assert.equal(requests[0].options?.timeoutMs, 10_000);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "mikan-site:901");
});

test("parseAniBtRss 解析 AniBT RSS 扩展字段和内嵌 torrent 元数据", () => {
  const releases = parseAniBtRss(
    `
      <rss version="2.0" xmlns:anibt="https://anibt.net/xmlns/rss/1.0/">
        <channel>
          <item>
            <title>[Nix-Raws] 骸骨骑士大人异世界冒险中Ⅱ / Gaikotsu Kishi-sama Tadaima Isekai e Odekakechuu S02E02 [CR WEB-DL 1080p AVC AAC][简繁内封]</title>
            <link>https://anibt.net/release/rel_test</link>
            <guid isPermaLink="false">rel_test</guid>
            <pubDate>Mon, 13 Jul 2026 21:04:04 +0800</pubDate>
            <anibt:releaseId>rel_test</anibt:releaseId>
            <anibt:torrentUrl>https://anibt.net/api/torrent/rel_test.torrent</anibt:torrentUrl>
            <anibt:releaseTitle>[Nix-Raws] 骸骨骑士大人异世界冒险中Ⅱ / Gaikotsu Kishi-sama Tadaima Isekai e Odekakechuu S02E02 [CR WEB-DL 1080p AVC AAC][简繁内封]</anibt:releaseTitle>
            <anibt:groupName>Nix-Raws</anibt:groupName>
            <anibt:episode>2</anibt:episode>
            <anibt:resolution>1080p</anibt:resolution>
            <anibt:language>CHS/CHT</anibt:language>
            <anibt:fileSize>1461298734</anibt:fileSize>
            <anibt:customTag>AVC</anibt:customTag>
            <torrent xmlns="https://anibt.moe/xmlns/0.1/">
              <contentLength>1461298734</contentLength>
              <infohash>A307AE8DBE4B93226197A7D560651457AC9A28D4</infohash>
              <magneturi>magnet:?xt=urn:btih:a307ae8dbe4b93226197a7d560651457ac9a28d4&amp;dn=test</magneturi>
            </torrent>
            <enclosure url="https://anibt.net/api/torrent/rel_test.torrent" length="1461298734" />
          </item>
        </channel>
      </rss>
    `,
    anibtConfig
  );

  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "anibt:rel_test");
  assert.equal(releases[0].torrentUrl, "https://anibt.net/api/torrent/rel_test.torrent");
  assert.equal(releases[0].magnetUrl, "magnet:?xt=urn:btih:a307ae8dbe4b93226197a7d560651457ac9a28d4&dn=test");
  assert.equal(releases[0].infoHash, "a307ae8dbe4b93226197a7d560651457ac9a28d4");
  assert.equal(releases[0].size, 1461298734);
  assert.equal(releases[0].episodeNo, 2);
  assert.equal(releases[0].fansubName, "Nix-Raws");
  assert.equal(releases[0].resolution, "1080p");
  assert.equal(releases[0].declaredVideoCodec, "AVC");
  assert.equal(releases[0].normalizedVideoCodec, "H.264/AVC");
  assert.equal(releases[0].subtitle, "multi");
});

test("AniBT source uses configured token headers", async (t) => {
  const inputs: string[] = [];
  const requestHeaders: Record<string, string>[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    inputs.push(String(input));
    requestHeaders.push(init?.headers as Record<string, string>);

    return new Response(
      `
        <rss>
          <channel>
            <item>
              <title>[AniBT] 测试番 - 01 [1080p]</title>
              <guid>rel_auth_test</guid>
              <pubDate>Mon, 13 Jul 2026 13:30:00 GMT</pubDate>
            </item>
          </channel>
        </rss>
      `,
      { status: 200, statusText: "OK" }
    );
  });

  const source = new AniBtReleaseSource({
    ...anibtConfig,
    apiKey: "test-token"
  });
  const releases = await source.searchReleases({ keyword: "", limit: 1 });

  assert.equal(inputs[0], "https://anibt.net/rss/magnets.xml?limit=50");
  assert.equal(requestHeaders[0].Authorization, "Bearer test-token");
  assert.equal(requestHeaders[0]["X-API-Key"], "test-token");
  assert.equal(releases.length, 1);
});

test("createAniBtHeaders accepts copied Cookie credentials", () => {
  const headers = createAniBtHeaders({ ...anibtConfig, apiKey: "Cookie: anibt.sid=session-value" }, "application/json");

  assert.equal(headers.Cookie, "anibt.sid=session-value");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["X-API-Key"], undefined);
});

test("parseAcgnxApiResponse 兼容 ACGNX JSON/API 风格响应", () => {
  const releases = parseAcgnxApiResponse(
    {
      ok: true,
      data: {
        items: [
          {
            id: "acgnx-100",
            title: "[LoliHouse] 测试番 - 03 [1080p][HEVC][简日]",
            magnet: "magnet:?xt=urn:btih:FACEB00C1234&dn=test",
            torrent_url: "https://share.acgnx.se/down/acgnx-100.torrent",
            size: "1.50 GiB",
            seeders: "18",
            published_at: "2026-07-13T14:00:00+08:00"
          }
        ]
      }
    },
    acgnxConfig
  );

  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "acgnx:acgnx-100");
  assert.equal(releases[0].torrentUrl, "https://share.acgnx.se/down/acgnx-100.torrent");
  assert.equal(releases[0].magnetUrl, "magnet:?xt=urn:btih:FACEB00C1234&dn=test");
  assert.equal(releases[0].infoHash, "faceb00c1234");
  assert.equal(releases[0].size, 1610612736);
  assert.equal(releases[0].seeders, 18);
  assert.equal(releases[0].episodeNo, 3);
  assert.equal(releases[0].resolution, "1080p");
  assert.equal(releases[0].normalizedVideoCodec, "H.265/HEVC");
});

test("parseAcgnxHtml 解析 ACGNX HTML 搜索行中的下载地址和做种数", () => {
  const releases = parseAcgnxHtml(
    `
      <table>
        <tr>
          <td>2026-07-13 15:20</td>
          <td><a href="/show-42.html">[Sakurato] 测试番 - 04 [720p][AVC][简体]</a></td>
          <td><a href="magnet:?xt=urn:btih:ABC123DEF456&dn=test">磁力</a></td>
          <td><a href="/download/42.torrent">下载种子</a></td>
          <td>850 MB</td>
          <td>seeders 9</td>
        </tr>
      </table>
    `,
    acgnxConfig
  );

  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "acgnx:abc123def456");
  assert.equal(releases[0].torrentUrl, "https://share.acgnx.se/download/42.torrent");
  assert.equal(releases[0].magnetUrl, "magnet:?xt=urn:btih:ABC123DEF456&dn=test");
  assert.equal(releases[0].infoHash, "abc123def456");
  assert.equal(releases[0].size, 850000000);
  assert.equal(releases[0].seeders, 9);
  assert.equal(releases[0].episodeNo, 4);
  assert.equal(releases[0].resolution, "720p");
  assert.equal(releases[0].normalizedVideoCodec, "H.264/AVC");
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

test("ReleaseSourceService 在缓存有效期内复用资源搜索结果并支持强制刷新", async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCount += 1;
    return new Response(
      `
        <rss>
          <channel>
            <item>
              <title>[字幕组] 缓存测试番 - 01 [1080p]</title>
              <link>magnet:?xt=urn:btih:CACHE${fetchCount}&amp;dn=test</link>
              <guid>cache-guid-${fetchCount}</guid>
            </item>
          </channel>
        </rss>
      `,
      { status: 200, statusText: "OK" }
    );
  });

  const service = new ReleaseSourceService([{ ...rssConfig, id: "rss-cache-test" }]);
  const first = await service.search({ keyword: "缓存测试番", limit: 10, cacheTtlMs: 24 * 60 * 60 * 1000 });
  const cached = await service.search({ keyword: "缓存测试番", limit: 10, cacheTtlMs: 24 * 60 * 60 * 1000 });
  const refreshed = await service.search({
    keyword: "缓存测试番",
    limit: 10,
    cacheTtlMs: 24 * 60 * 60 * 1000,
    forceRefresh: true
  });

  assert.equal(fetchCount, 2);
  assert.equal(first.releases[0].id, "rss-cache-test:cache-guid-1");
  assert.equal(cached.releases[0].id, "rss-cache-test:cache-guid-1");
  assert.equal(refreshed.releases[0].id, "rss-cache-test:cache-guid-2");
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
