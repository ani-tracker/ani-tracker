import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AnimeSourceBinding, MyAnime, ReleaseSourceConfig } from "@shared/domain";
import type { AppRepository } from "../../repositories/app-repository";
import type { ReleaseHttpClient } from "../../sources/mikan-source";
import { AnimeSourceBindingService } from "../anime-source-binding-service";

test("Mikan 外部 ID 自动绑定，取消后使用站点候选重新匹配", async () => {
  const repository = new FakeBindingRepository();
  const httpClient: ReleaseHttpClient = {
    async fetch(input) {
      assert.match(String(input), /Home\/BangumiCoverFlowByDayOfWeek/);
      return new Response(`
        <a href="/Home/Bangumi/4007" title="测试番">测试番</a>
        <a href="/Home/Bangumi/4999" title="其他番剧">其他番剧</a>
      `);
    }
  };
  const service = new AnimeSourceBindingService(repository.asAppRepository(), httpClient);

  const initial = await service.getState("anime-1", false);
  assert.equal(initial.bindings.length, 1);
  assert.equal(initial.bindings[0].sourceId, "mikan");
  assert.equal(initial.bindings[0].sourceAnimeId, "3941");
  assert.equal(initial.bindings[0].matchMethod, "external_id");
  assert.equal(initial.bindings[0].confirmed, true);

  const rematched = await service.remove("anime-1", "mikan");
  assert.equal(rematched.bindings[0].confirmed, false);
  assert.equal(rematched.bindings[0].sourceAnimeId, "3941");
  assert.equal(rematched.candidates[0].sourceId, "mikan");
  assert.equal(rematched.candidates[0].sourceAnimeId, "4007");
  assert.equal(rematched.candidates[0].title, "测试番");
});

test("来源候选不匹配仅写入包含番名、来源和评分的日志", async (t) => {
  const repository = new FakeBindingRepository();
  const lines: string[] = [];
  t.mock.method(console, "log", (line: unknown) => lines.push(String(line)));
  const service = new AnimeSourceBindingService(repository.asAppRepository());

  await service.reportMismatch({
    animeId: "anime-1",
    sourceId: "mikan",
    sourceAnimeId: "4999",
    sourceAnimeTitle: "其他番剧",
    score: 63,
    reasons: ["标题近似", "首播年月不一致"]
  });

  assert.equal(repository.bindingCount, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /来源番剧候选已确认不匹配/);
  assert.match(lines[0], /"animeTitle":"测试番"/);
  assert.match(lines[0], /"sourceName":"蜜柑计划 RSS"/);
  assert.match(lines[0], /"candidateScore":63/);
});

class FakeBindingRepository {
  private readonly item: MyAnime = {
    id: "my-anime-1",
    anime: {
      id: "anime-1",
      title: "测试番",
      aliases: [],
      premiereYear: 2026,
      premiereMonth: 7,
      externalIds: { mikan: "3941" }
    },
    status: "watching",
    autoDownload: false,
    addedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
  private readonly sources: ReleaseSourceConfig[] = [
    {
      id: "mikan",
      name: "蜜柑计划 RSS",
      kind: "rss",
      enabled: true,
      rssUrl: "https://mikanani.me/RSS/Bangumi"
    },
    {
      id: "mikan-site",
      name: "蜜柑计划站点",
      kind: "site_adapter",
      enabled: true,
      baseUrl: "https://mikanani.me/"
    }
  ];
  private bindings: AnimeSourceBinding[] = [];

  get bindingCount(): number {
    return this.bindings.length;
  }

  asAppRepository(): AppRepository {
    return this as unknown as AppRepository;
  }

  async listMyAnime(): Promise<MyAnime[]> {
    return [this.item];
  }

  async listSources(): Promise<ReleaseSourceConfig[]> {
    return this.sources;
  }

  async listEpisodes(): Promise<[]> {
    return [];
  }

  async listAnimeSourceBindings(): Promise<AnimeSourceBinding[]> {
    return this.bindings.map((binding) => ({ ...binding }));
  }

  async upsertAnimeSourceBinding(binding: AnimeSourceBinding): Promise<AnimeSourceBinding[]> {
    const index = this.bindings.findIndex(
      (item) => item.animeId === binding.animeId && item.sourceId === binding.sourceId
    );
    if (index >= 0) {
      this.bindings[index] = binding;
    } else {
      this.bindings.push(binding);
    }
    return this.listAnimeSourceBindings();
  }
}
