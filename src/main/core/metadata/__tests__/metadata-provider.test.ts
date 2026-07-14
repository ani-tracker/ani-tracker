import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Anime } from "@shared/domain";
import { buildAnimeReleaseSearchTerms, normalizeReleaseSearchText } from "../../../../shared/anime-release-search";
import { resolveAnimeTitleDisplay } from "../../../../shared/anime-title";
import { BangumiMetadataProvider } from "../bangumi-metadata-provider";
import {
  mergeAnimeMetadataBatches,
  normalizeTitle,
  uniqueByNormalizedTitle
} from "../metadata-provider";
import { parseMikanDetailHtml } from "../mikan-metadata-provider";
import { BANGUMI_USER_AGENT } from "../../http/user-agents";

test("normalizeTitle 忽略常见空白、括号和标点差异", () => {
  assert.equal(normalizeTitle(" 测试番：第 2 季（TV） "), normalizeTitle("测试番 第2季 TV"));
  assert.equal(normalizeTitle("Test_Anime-S2!"), normalizeTitle("test anime s2"));
  assert.equal(normalizeTitle("片田舎のおっさん、剣聖になるⅡ"), normalizeTitle("片田舎のおっさん、剣聖になるII"));
});

test("buildAnimeReleaseSearchTerms 扩展引号标题和去标点标题", () => {
  const terms = buildAnimeReleaseSearchTerms(
    createAnime({
      id: "anime-search-1",
      title: "「きみを愛する気はない」と言った次期公爵様がなぜか溺愛してきます",
      originalTitle: "Kimi wo Aisuru Ki wa nai",
      aliases: [createAlias("anime-search-1", "The Duke's Son Claims He Won't Love Me Yet Showers Me with Adoration", "en", 80)]
    })
  );

  assert.ok(terms.includes("きみを愛する気はない"));
  assert.ok(terms.includes("Kimi wo Aisuru Ki wa nai"));
  assert.ok(terms.some((term) => normalizeReleaseSearchText(term).includes("きみを愛する気はない")));
});

test("uniqueByNormalizedTitle 按标题、原名和别名去重并合并 external id", () => {
  const items = uniqueByNormalizedTitle([
    createAnime({
      id: "bangumi-1",
      title: "测试番 第二季",
      originalTitle: "テストアニメ 2",
      externalIds: { bangumi: "1" }
    }),
    createAnime({
      id: "anilist-10",
      title: "Test Anime 2",
      aliases: [createAlias("anilist-10", "测试番 第二季", "zh", 80)],
      externalIds: { anilist: "10" }
    })
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "测试番 第二季");
  assert.deepEqual(items[0].externalIds, { bangumi: "1", anilist: "10" });
});

test("mergeAnimeMetadataBatches 通过 external id 合并并用更具体的首播日期补全", () => {
  const [merged] = mergeAnimeMetadataBatches([
    {
      source: "bangumi",
      items: [
        createAnime({
          id: "bangumi-1",
          title: "测试番",
          originalTitle: "テストアニメ",
          premiereDate: "2026-07-01",
          externalIds: { bangumi: "1" }
        })
      ]
    },
    {
      source: "mikan",
      items: [
        createAnime({
          id: "mikan-100",
          title: "Test Anime",
          aliases: [createAlias("mikan-100", "测试番", "zh", 80)],
          premiereDate: "2026-07-13",
          summary: "来自 Mikan 的简介",
          coverUrl: "https://mikan.test/cover.jpg",
          externalIds: { bangumi: "1", mikan: "100" }
        })
      ]
    }
  ]);

  assert.equal(merged.id, "bangumi-1");
  assert.equal(merged.title, "测试番");
  assert.equal(merged.premiereDate, "2026-07-13");
  assert.equal(merged.premiereYear, 2026);
  assert.equal(merged.premiereMonth, 7);
  assert.equal(merged.summary, "来自 Mikan 的简介");
  assert.equal(merged.coverUrl, "https://mikan.test/cover.jpg");
  assert.deepEqual(merged.externalIds, { bangumi: "1", mikan: "100" });
  assert.deepEqual(
    merged.aliases.map((alias) => alias.alias),
    ["Test Anime"]
  );
  assert.ok(merged.aliases.every((alias) => alias.animeId === "bangumi-1"));
});

test("mergeAnimeMetadataBatches 优先使用中文标题并保留多语言标题变体", () => {
  const [merged] = mergeAnimeMetadataBatches([
    {
      source: "anilist",
      items: [
        createAnime({
          id: "anilist-30",
          title: "テストアニメ",
          originalTitle: "テストアニメ",
          aliases: [
            createAlias("anilist-30", "Test Anime", "romaji", 90),
            createAlias("anilist-30", "Test Animation", "en", 80)
          ],
          externalIds: { anilist: "30" }
        })
      ]
    },
    {
      source: "mikan",
      items: [
        createAnime({
          id: "mikan-300",
          title: "测试动画",
          originalTitle: "テストアニメ",
          aliases: [createAlias("mikan-300", "测试番", "zh", 85)],
          externalIds: { mikan: "300" }
        })
      ]
    }
  ]);

  assert.equal(merged.title, "测试动画");
  assert.equal(merged.originalTitle, "テストアニメ");
  assert.deepEqual(
    merged.aliases.map((alias) => alias.alias),
    ["Test Anime", "Test Animation", "测试番"]
  );
  assert.ok(merged.aliases.every((alias) => alias.animeId === "anilist-30"));
});

test("mergeAnimeMetadataBatches 通过传递 external id 桥接 AniList、Bangumi 和 Mikan", () => {
  const items = mergeAnimeMetadataBatches([
    {
      source: "bangumi",
      items: [
        createAnime({
          id: "bangumi-638151",
          title: "地狱模式～喜欢挑战特殊成就的玩家在废设定的异世界成为无双～第二季",
          originalTitle: "ヘルモード ～やり込み好きのゲーマーは廃設定の異世界で無双する～ 2nd Season",
          aliases: [
            createAlias(
              "bangumi-638151",
              "HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing Season 2",
              "en",
              78
            )
          ],
          externalIds: { bangumi: "638151", mal: "63817" }
        })
      ]
    },
    {
      source: "anilist",
      items: [
        createAnime({
          id: "anilist-209983",
          title: "ヘルモード ～やり込み好きのゲーマーは廃設定の異世界で無双する～ 2nd Season",
          aliases: [
            createAlias(
              "anilist-209983",
              "HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing Season 2",
              "en",
              80
            )
          ],
          externalIds: { anilist: "209983", mal: "63817" }
        })
      ]
    },
    {
      source: "mikan",
      items: [
        createAnime({
          id: "mikan-3999",
          title: "地狱模式～喜欢挑战特殊成就的玩家在废设定的异世界成为无双～第二季",
          externalIds: { bangumi: "638151", mikan: "3999" }
        })
      ]
    }
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "地狱模式～喜欢挑战特殊成就的玩家在废设定的异世界成为无双～第二季");
  assert.equal(items[0].originalTitle, "ヘルモード ～やり込み好きのゲーマーは廃設定の異世界で無双する～ 2nd Season");
  assert.deepEqual(items[0].externalIds, {
    bangumi: "638151",
    mal: "63817",
    anilist: "209983",
    mikan: "3999"
  });
});

test("BangumiMetadataProvider 分页采集第二页番组并补充详情别名", async () => {
  const httpClient = new FakeBangumiHttpClient();
  const provider = new BangumiMetadataProvider("https://api.bgm.tv/", httpClient as never);

  const items = await provider.getAnimeByMonth(2026, 7);
  const skeletonKnight = items.find((item) => item.externalIds.bangumi === "528828");

  assert.ok(httpClient.requests.some((url) => url.searchParams.get("offset") === "50"));
  assert.ok(httpClient.headers.every((headers) => headers.get("User-Agent") === BANGUMI_USER_AGENT));
  assert.ok(skeletonKnight);
  assert.equal(skeletonKnight.title, "骸骨骑士大人异世界冒险中 第二季");
  assert.equal(skeletonKnight.originalTitle, "骸骨騎士様、只今異世界へお出掛け中Ⅱ");
  assert.ok(skeletonKnight.aliases.some((alias) => alias.alias === "Skeleton Knight in Another World Season 2"));
});

test("mergeAnimeMetadataBatches 用 Bangumi 详情英文别名桥接 AniList 和 Mikan", () => {
  const items = mergeAnimeMetadataBatches([
    {
      source: "bangumi",
      items: [
        createAnime({
          id: "bangumi-528828",
          title: "骸骨骑士大人异世界冒险中 第二季",
          originalTitle: "骸骨騎士様、只今異世界へお出掛け中Ⅱ",
          aliases: [
            createAlias("bangumi-528828", "骸骨騎士様、只今異世界へお出掛け中Ⅱ", "ja", 95),
            createAlias(
              "bangumi-528828",
              "Gaikotsu Kishi-sama, Tadaima Isekai e Odekake-chuu Season 2",
              "romaji",
              78
            ),
            createAlias("bangumi-528828", "Skeleton Knight in Another World Season 2", "en", 78)
          ],
          externalIds: { bangumi: "528828" }
        })
      ]
    },
    {
      source: "anilist",
      items: [
        createAnime({
          id: "anilist-185542",
          title: "骸骨騎士様、只今異世界へお出掛け中Ⅱ",
          originalTitle: "骸骨騎士様、只今異世界へお出掛け中Ⅱ",
          aliases: [
            createAlias("anilist-185542", "Gaikotsu Kishi-sama, Tadaima Isekai e Odekakechuu II", "romaji", 90),
            createAlias("anilist-185542", "Skeleton Knight in Another World Season 2", "en", 80)
          ],
          externalIds: { anilist: "185542", mal: "60522" }
        })
      ]
    },
    {
      source: "mikan",
      items: [
        createAnime({
          id: "mikan-3983",
          title: "骸骨骑士大人异世界冒险中 第二季",
          externalIds: { bangumi: "528828", mikan: "3983" }
        })
      ]
    }
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "骸骨骑士大人异世界冒险中 第二季");
  assert.deepEqual(items[0].externalIds, {
    bangumi: "528828",
    anilist: "185542",
    mal: "60522",
    mikan: "3983"
  });
});

test("resolveAnimeTitleDisplay 展示时中文优先并用原名做副标题", () => {
  const display = resolveAnimeTitleDisplay(
    createAnime({
      id: "anilist-40",
      title: "テストアニメ",
      originalTitle: "テストアニメ",
      aliases: [
        createAlias("anilist-40", "Test Anime", "romaji", 90),
        createAlias("anilist-40", "测试动画", "zh", 80)
      ]
    })
  );

  assert.equal(display.title, "测试动画");
  assert.equal(display.subtitle, "テストアニメ");
  assert.deepEqual(
    display.aliases.map((alias) => alias.alias),
    ["Test Anime"]
  );
});

test("resolveAnimeTitleDisplay 主标题是中文时不让旧中文别名覆盖", () => {
  const display = resolveAnimeTitleDisplay(
    createAnime({
      id: "bangumi-552533",
      title: "穹庐下的魔女",
      originalTitle: "天幕のジャードゥーガル",
      aliases: [createAlias("bangumi-552533", "欺诈游戏", "zh", 100)]
    })
  );

  assert.equal(display.title, "穹庐下的魔女");
  assert.equal(display.subtitle, "天幕のジャードゥーガル");
});

test("parseMikanDetailHtml 忽略站点标题并解析月日年格式日期", () => {
  const detail = parseMikanDetailHtml(
    `
      <html>
        <head><title>Mikan Project</title></head>
        <body>
          <div>放送开始：7/4/2026</div>
          <a href="https://bgm.tv/subject/552533">Bangumi</a>
        </body>
      </html>
    `,
    "https://mikanani.me/Home/Bangumi/4007"
  );

  assert.equal(detail.title, undefined);
  assert.equal(detail.premiereDate, "2026-07-04");
  assert.equal(detail.bangumiId, "552533");
});

test("mergeAnimeMetadataBatches 不用次来源覆盖主来源已有字段", () => {
  const [merged] = mergeAnimeMetadataBatches([
    {
      source: "bangumi",
      items: [
        createAnime({
          id: "bangumi-2",
          title: "主标题",
          summary: "主简介",
          coverUrl: "https://bangumi.test/cover.jpg",
          externalIds: { bangumi: "2" }
        })
      ]
    },
    {
      source: "anilist",
      items: [
        createAnime({
          id: "anilist-20",
          title: "主标题",
          summary: "次简介",
          coverUrl: "https://anilist.test/cover.jpg",
          externalIds: { anilist: "20" }
        })
      ]
    }
  ]);

  assert.equal(merged.title, "主标题");
  assert.equal(merged.summary, "主简介");
  assert.equal(merged.coverUrl, "https://bangumi.test/cover.jpg");
  assert.deepEqual(merged.externalIds, { bangumi: "2", anilist: "20" });
});

function createAnime(overrides: Partial<Anime> & { id: string; title: string }): Anime {
  return {
    id: overrides.id,
    title: overrides.title,
    originalTitle: overrides.originalTitle,
    aliases: overrides.aliases ?? [],
    premiereDate: overrides.premiereDate ?? "2026-07-01",
    premiereYear: overrides.premiereYear ?? 2026,
    premiereMonth: overrides.premiereMonth ?? 7,
    season: overrides.season ?? "summer",
    summary: overrides.summary,
    coverUrl: overrides.coverUrl,
    externalIds: overrides.externalIds ?? {}
  };
}

function createAlias(
  animeId: string,
  alias: string,
  language: Anime["aliases"][number]["language"],
  priority: number
): Anime["aliases"][number] {
  return {
    id: `${animeId}-alias-${priority}`,
    animeId,
    alias,
    language,
    priority
  };
}

class FakeBangumiHttpClient {
  readonly requests: URL[] = [];
  readonly headers: Headers[] = [];

  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(input.toString());
    this.requests.push(url);
    this.headers.push(new Headers(init?.headers));

    if (url.pathname === "/v0/subjects") {
      return jsonResponse(createBangumiPage(Number(url.searchParams.get("offset") ?? 0)));
    }

    const subjectId = url.pathname.match(/\/v0\/subjects\/(\d+)/)?.[1];
    if (subjectId === "528828") {
      return jsonResponse({
        id: 528828,
        type: 2,
        name: "骸骨騎士様、只今異世界へお出掛け中Ⅱ",
        name_cn: "骸骨骑士大人异世界冒险中 第二季",
        date: "2026-07-06",
        infobox: [
          { key: "中文名", value: "骸骨骑士大人异世界冒险中 第二季" },
          {
            key: "别名",
            value: [
              { v: "Gaikotsu Kishi-sama, Tadaima Isekai e Odekake-chuu Season 2" },
              { v: "Skeleton Knight in Another World Season 2" }
            ]
          }
        ]
      });
    }

    return jsonResponse({
      id: 100,
      type: 2,
      name: "Dummy Anime",
      name_cn: "测试动画",
      date: "2026-07-01"
    });
  }
}

function createBangumiPage(offset: number): unknown {
  if (offset === 0) {
    return {
      total: 51,
      limit: 50,
      offset: 0,
      data: [
        {
          id: 100,
          type: 2,
          name: "Dummy Anime",
          name_cn: "测试动画",
          date: "2026-07-01"
        }
      ]
    };
  }

  return {
    total: 51,
    limit: 50,
    offset: 50,
    data: [
      {
        id: 528828,
        type: 2,
        name: "骸骨騎士様、只今異世界へお出掛け中Ⅱ",
        name_cn: "骸骨骑士大人异世界冒险中 第二季",
        date: "2026-07-06"
      }
    ]
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
