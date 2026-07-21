import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReleaseSearchResult } from "@shared/contracts";
import type { Anime, AnimeSourceBinding, ReleaseSourceConfig } from "@shared/domain";
import type { AppRepository } from "../../repositories/app-repository";
import { AcgRipReleaseSource } from "../acgrip-source";
import { defaultSourceConfigs } from "../default-source-configs";
import { parseAcgnxApiResponse, parseAcgnxHtml } from "../acgnx-source";
import { AniBtReleaseSource, createAniBtHeaders, parseAniBtRss } from "../anibt-source";
import { parseDmhyList } from "../dmhy-source";
import { MikanReleaseSource, parseMikanReleaseList, parseMikanSubgroups, type ReleaseHttpClient } from "../mikan-source";
import { NyaaReleaseSource } from "../nyaa-source";
import {
  COMPLETED_ANIME_RELEASE_CACHE_TTL_MS,
  createReleaseSource,
  ReleaseSourceService,
  resolveAnimeReleaseCacheTtlMs
} from "../release-source-service";
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

const nyaaConfig: ReleaseSourceConfig = {
  id: "nyaa",
  name: "Nyaa",
  kind: "site_adapter",
  enabled: true,
  baseUrl: "https://nyaa.si/"
};

const acgRipConfig: ReleaseSourceConfig = {
  id: "acg-rip",
  name: "ACG.RIP",
  kind: "site_adapter",
  enabled: true,
  baseUrl: "https://acg.rip/"
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

test("默认下载源包含 AniBT、ACGNX、Nyaa 和 ACG.RIP 且可创建站点适配器", () => {
  const anibt = defaultSourceConfigs.find((source) => source.id === "anibt");
  const acgnx = defaultSourceConfigs.find((source) => source.id === "acgnx");
  const nyaa = defaultSourceConfigs.find((source) => source.id === "nyaa");
  const acgRip = defaultSourceConfigs.find((source) => source.id === "acg-rip");

  assert.ok(anibt);
  assert.ok(acgnx);
  assert.ok(nyaa);
  assert.ok(acgRip);
  assert.equal(anibt.enabled, true);
  assert.equal(acgnx.enabled, false);
  assert.equal(nyaa.enabled, false);
  assert.equal(acgRip.enabled, false);
  assert.equal(nyaa.useProxy, true);
  assert.equal(acgRip.useProxy, true);
  assert.equal(createReleaseSource(anibt)?.config.id, "anibt");
  assert.equal(createReleaseSource(acgnx)?.config.id, "acgnx");
  assert.ok(createReleaseSource(nyaa) instanceof NyaaReleaseSource);
  assert.ok(createReleaseSource(acgRip) instanceof AcgRipReleaseSource);
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
  assert.equal(releases[0].subtitle, "multi");
  assert.deepEqual(releases[0].subtitleLanguages, ["chs", "jpn"]);
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

test("parseMikanSubgroups 解析番剧页字幕组 RSS 地址", () => {
  const groups = parseMikanSubgroups(
    `
      <p class="bangumi-title">测试番 <a href="/RSS/Bangumi?bangumiId=3941" class="mikan-rss"></a></p>
      <a class="subgroup-name subgroup-370" data-anchor="#370">LoliHouse</a>
      <div class="subgroup-text" id="382">
        <a href="/Home/PublishGroup/233">喵萌奶茶屋</a>
        <a href="/RSS/Bangumi?bangumiId=3941&subgroupid=382" class="mikan-rss"></a>
      </div>
    `,
    mikanConfig,
    "3941"
  );

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.id), ["370", "382"]);
  assert.equal(groups[0].rssUrl, "https://mikanani.me/RSS/Bangumi?bangumiId=3941&subgroupid=370");
  assert.equal(groups[1].name, "喵萌奶茶屋");
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
  assert.equal(requestHeaders[0].Accept, "application/rss+xml,application/xml,text/xml");
  assert.match(requestHeaders[0]["Accept-Language"], /^zh-CN/);
  assert.match(requestHeaders[0]["User-Agent"], /Mozilla\/5\.0/);
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

test("AniBT 按已绑定 Bangumi ID 精确读取番剧 RSS", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    assert.equal(String(input), "https://anibt.net/rss/anime.xml?bgmId=528828&limit=30");
    return new Response("<rss><channel><item><title>凡人修仙传 - 160</title><guid>exact-1</guid></item></channel></rss>");
  });

  const releases = await new AniBtReleaseSource(anibtConfig).listReleasesByAnimeId("528828", 30);
  assert.equal(releases.length, 1);
  assert.match(releases[0].title, /凡人修仙传/);
});

test("AniBT 403 返回单一出口和熔断提示", async () => {
  const httpClient: ReleaseHttpClient = {
    async fetch() {
      return new Response("forbidden", { status: 403, statusText: "Forbidden" });
    }
  };

  await assert.rejects(
    new AniBtReleaseSource(anibtConfig, httpClient).listReleasesByAnimeId("528828", 30),
    /保持单一网络出口并在熔断结束后重试/
  );
});

test("完结作品资源缓存固定为七天", () => {
  assert.equal(resolveAnimeReleaseCacheTtlMs("completed", 60_000), COMPLETED_ANIME_RELEASE_CACHE_TTL_MS);
  assert.equal(resolveAnimeReleaseCacheTtlMs("watching", 60_000), 60_000);
  assert.equal(resolveAnimeReleaseCacheTtlMs("planned"), undefined);
});

test("Mikan 按已绑定番组 ID 精确读取 RSS", async () => {
  const inputs: string[] = [];
  const httpClient: ReleaseHttpClient = {
    async fetch(input) {
      inputs.push(String(input));
      if (String(input).includes("/Home/Bangumi/3941")) {
        return new Response('<a class="subgroup-name subgroup-382" data-anchor="#382">喵萌奶茶屋</a>');
      }
      return new Response("<rss><channel><item><title>[喵萌奶茶屋] 测试番 - 01</title><guid>mikan-exact-1</guid></item></channel></rss>");
    }
  };

  const releases = await new MikanReleaseSource(mikanConfig, httpClient).listReleasesByAnimeId("3941", 25);
  assert.equal(inputs[0], "https://mikanani.me/RSS/Bangumi?bangumiId=3941");
  assert.equal(releases.length, 1);
  assert.equal(releases[0].sourceMeta?.mikanBangumiId, "3941");
  assert.equal(releases[0].sourceMeta?.mikanSubgroupId, "382");
  assert.equal(releases[0].sourceMeta?.rssUrl, "https://mikanani.me/RSS/Bangumi?bangumiId=3941&subgroupid=382");
});

test("ReleaseSourceService 过滤 AniBT BGM 搜索返回的其他番剧", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/bgm/search") {
      return Response.json({ ok: true, data: [{ bgmId: 100 }, { bgmId: 200 }] });
    }

    const bgmId = url.searchParams.get("bgmId");
    const title =
      bgmId === "100"
        ? "[ANi] 凡人修仙传 年番 - 160 [1080p]"
        : "[黑ネズミたち] 出租女友 第五季 / Kanojo, Okarishimasu 5th Season - 60 [1080p]";
    return new Response(
      `<rss><channel><item><title>${title}</title><guid>release-${bgmId}</guid></item></channel></rss>`,
      { status: 200, statusText: "OK" }
    );
  });

  const service = new ReleaseSourceService([anibtConfig]);
  const result = await service.search({
    keyword: "凡人修仙传 第五季",
    animeId: "anime-mortal-cultivation",
    limit: 2
  });

  assert.equal(result.releases.length, 1);
  assert.match(result.releases[0].title, /凡人修仙传/);
});

test("ReleaseSourceService 精确来源绑定也会过滤显式旧季度合集", async () => {
  const httpClient: ReleaseHttpClient = {
    async fetch() {
      return new Response(
        `<rss><channel>
          <item><title>[字幕组] 测试番 S04E02 [1080p]</title><guid>current-season</guid></item>
          <item><title>[字幕组] 测试番 10-bit 1080p [S3 Fin]</title><guid>old-season</guid></item>
        </channel></rss>`
      );
    }
  };
  const anime: Anime = {
    id: "anime-season-4",
    title: "测试番 第四季",
    originalTitle: "Test Anime 4th Season",
    aliases: [],
    premiereYear: 2026,
    premiereMonth: 4,
    externalIds: {}
  };
  const binding: AnimeSourceBinding = {
    id: "binding-rss-season-4",
    animeId: anime.id,
    sourceId: rssConfig.id,
    sourceAnimeId: "season-4",
    sourceAnimeTitle: anime.title,
    matchMethod: "manual",
    confidence: 1,
    confirmed: true,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z"
  };

  const result = await new ReleaseSourceService([rssConfig], [], httpClient).searchAnime(
    anime,
    { animeId: anime.id, limit: 10 },
    [binding]
  );

  assert.deepEqual(result.releases.map((release) => release.id), [`${rssConfig.id}:current-season`]);
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

test("NyaaReleaseSource 使用 Anime RSS 并解析摘要、体积和做种数", async () => {
  const requests: Array<{ url: string; source?: string }> = [];
  const httpClient: ReleaseHttpClient = {
    async fetch(input, options) {
      requests.push({ url: String(input), source: options?.source });
      return new Response(
        `
          <rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa" version="2.0">
            <channel>
              <item>
                <title>[北宇治字幕组] 葬送的芙莉莲 - 38 [1080p][HEVC][简繁日]</title>
                <link>https://nyaa.si/download/2104237.torrent</link>
                <guid isPermaLink="true">https://nyaa.si/view/2104237</guid>
                <pubDate>Wed, 29 Apr 2026 15:23:29 -0000</pubDate>
                <nyaa:seeders>16</nyaa:seeders>
                <nyaa:infoHash>1188285F8B296E1E7E2F622955F214B71E93D2DC</nyaa:infoHash>
                <nyaa:size>663.2 MiB</nyaa:size>
              </item>
            </channel>
          </rss>
        `,
        { status: 200, statusText: "OK" }
      );
    }
  };

  const releases = await new NyaaReleaseSource(nyaaConfig, httpClient).searchReleases({
    keyword: "葬送的芙莉莲",
    limit: 10
  });

  assert.equal(
    requests[0].url,
    "https://nyaa.si/?page=rss&q=%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%99%E8%8E%89%E8%8E%B2&c=1_0&f=0"
  );
  assert.equal(requests[0].source, "nyaa-release");
  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "nyaa:https://nyaa.si/view/2104237");
  assert.equal(releases[0].torrentUrl, "https://nyaa.si/download/2104237.torrent");
  assert.equal(releases[0].infoHash, "1188285f8b296e1e7e2f622955f214b71e93d2dc");
  assert.equal(
    releases[0].magnetUrl,
    `magnet:?xt=urn:btih:1188285f8b296e1e7e2f622955f214b71e93d2dc&dn=${encodeURIComponent(releases[0].title)}`
  );
  assert.equal(releases[0].size, Math.round(663.2 * 1024 ** 2));
  assert.equal(releases[0].seeders, 16);
  assert.equal(releases[0].sourceMeta?.sourceUrl, "https://nyaa.si/view/2104237");
  assert.equal(releases[0].episodeNo, 38);
});

test("AcgRipReleaseSource 使用关键词 RSS 并解析 enclosure 和精确体积", async () => {
  const requests: Array<{ url: string; source?: string }> = [];
  const httpClient: ReleaseHttpClient = {
    async fetch(input, options) {
      requests.push({ url: String(input), source: options?.source });
      return new Response(
        `
          <rss xmlns:torrent="http://xmlns.ezrss.it/0.1/" xmlns:media="http://search.yahoo.com/mrss/">
            <channel>
              <item>
                <title>[绿茶字幕组] 葬送的芙莉莲 第二季 - 38 [1080p][简日]</title>
                <pubDate>Wed, 13 May 2026 08:27:56 -0700</pubDate>
                <link>https://acg.rip/t/354021</link>
                <guid>https://acg.rip/t/354021</guid>
                <enclosure url="https://acg.rip/t/354021.torrent" type="application/x-bittorrent" />
                <torrent:contentLength>652384256</torrent:contentLength>
                <media:content url="https://acg.rip/t/354021.torrent" fileSize="652384256" />
              </item>
            </channel>
          </rss>
        `,
        { status: 200, statusText: "OK" }
      );
    }
  };

  const releases = await new AcgRipReleaseSource(acgRipConfig, httpClient).searchReleases({
    keyword: "葬送的芙莉莲",
    limit: 10
  });

  assert.equal(
    requests[0].url,
    "https://acg.rip/.xml?term=%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%99%E8%8E%89%E8%8E%B2"
  );
  assert.equal(requests[0].source, "acgrip-release");
  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "acg-rip:https://acg.rip/t/354021");
  assert.equal(releases[0].torrentUrl, "https://acg.rip/t/354021.torrent");
  assert.equal(releases[0].size, 652384256);
  assert.equal(releases[0].sourceMeta?.sourceUrl, "https://acg.rip/t/354021");
  assert.equal(releases[0].episodeNo, 38);
});

test("RssReleaseSource 解析 RSS item 的下载地址、体积和媒体字段", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(input), rssConfig.rssUrl);
    const headers = init?.headers as Record<string, string>;
    assert.match(headers.Accept, /application\/rss\+xml/);
    assert.match(headers["Accept-Language"], /^zh-CN/);
    assert.match(headers["User-Agent"], /Mozilla\/5\.0/);

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
  assert.equal(releases[0].torrentUrl, "https://example.test/test.torrent");
  assert.equal(releases[0].size, 2147483648);
  assert.equal(releases[0].publishedAt, "Mon, 13 Jul 2026 12:30:00 GMT");
  assert.equal(releases[0].episodeNo, 4);
  assert.equal(releases[0].resolution, "1080p");
  assert.equal(releases[0].normalizedVideoCodec, "H.265/HEVC");
  assert.equal(releases[0].subtitle, "multi");
  assert.deepEqual(releases[0].subtitleLanguages, ["cht", "jpn"]);
});

test("RssReleaseSource 优先使用 enclosure 作为蜜柑 RSS 下载地址", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      `
        <rss>
          <channel>
            <item>
              <guid isPermaLink="false">[喵萌奶茶屋] 欺诈游戏 - 15 [1080p][简日双语]</guid>
              <link>https://mikanani.me/Home/Episode/d3f8c75b903f438f6e2284aa856d65f092cd5b5f</link>
              <title>[喵萌奶茶屋] 欺诈游戏 - 15 [1080p][简日双语]</title>
              <torrent xmlns="https://mikanani.me/0.1/">
                <contentLength>441031072</contentLength>
                <pubDate>2026-07-15T00:28:00</pubDate>
              </torrent>
              <enclosure type="application/x-bittorrent" length="441031072" url="https://mikanani.me/Download/20260715/d3f8c75b903f438f6e2284aa856d65f092cd5b5f.torrent" />
            </item>
          </channel>
        </rss>
      `,
      { status: 200, statusText: "OK" }
    )
  );

  const releases = await new RssReleaseSource(rssConfig).searchReleases({ keyword: "", limit: 10 });

  assert.equal(releases.length, 1);
  assert.equal(
    releases[0].torrentUrl,
    "https://mikanani.me/Download/20260715/d3f8c75b903f438f6e2284aa856d65f092cd5b5f.torrent"
  );
  assert.equal(releases[0].magnetUrl, undefined);
  assert.equal(releases[0].size, 441031072);
  assert.equal(releases[0].publishedAt, "2026-07-15T00:28:00");
  assert.equal(releases[0].episodeNo, 15);
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

test("ReleaseSourceService 重启后优先复用持久化查询缓存", async () => {
  const query = {
    keyword: "跨重启完结缓存专用查询",
    limit: 10,
    cacheTtlMs: COMPLETED_ANIME_RELEASE_CACHE_TTL_MS
  };
  const persistedResult: ReleaseSearchResult = {
    query,
    releases: [{
      id: "anibt:persisted-search-cache",
      title: "[测试组] 跨重启完结缓存专用查询 - 01 [1080p]",
      sourceId: "anibt",
      sourceName: "AniBT",
      publishedAt: "2026-07-18T00:00:00.000Z"
    }],
    searchedSourceIds: ["anibt"],
    errors: []
  };
  let fetchCount = 0;
  const repository = {
    async getReleaseSearchCache() {
      return { expiresAt: "2099-01-01T00:00:00.000Z", result: persistedResult };
    }
  } as unknown as AppRepository;
  const httpClient: ReleaseHttpClient = {
    async fetch() {
      fetchCount += 1;
      return new Response("unexpected", { status: 500 });
    }
  };
  const service = new ReleaseSourceService(
    [{ ...rssConfig, id: "rss-persisted-cache-test" }],
    [],
    httpClient,
    repository
  );

  const result = await service.search(query);

  assert.equal(fetchCount, 0);
  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0].id, persistedResult.releases[0].id);
  assert.equal(result.releases[0].title, persistedResult.releases[0].title);
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
