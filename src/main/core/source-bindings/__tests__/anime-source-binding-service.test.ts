import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AnimeSourceBinding, AnimeSourceExclusion, MyAnime, ReleaseSourceConfig } from "@shared/domain";
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

test("来源候选不匹配持久化排除并写入诊断日志", async (t) => {
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
  assert.equal(repository.exclusionCount, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /来源番剧候选已确认不匹配/);
  assert.match(lines[0], /"animeTitle":"测试番"/);
  assert.match(lines[0], /"sourceName":"蜜柑计划 RSS"/);
  assert.match(lines[0], /"candidateScore":63/);
});

test("候选和整来源排除可跨重新打开保留并主动恢复", async () => {
  const repository = new FakeBindingRepository("");
  let fetchCount = 0;
  const service = new AnimeSourceBindingService(repository.asAppRepository(), {
    async fetch() {
      fetchCount += 1;
      return new Response(`
        <a href="/Home/Bangumi/4007" title="测试番">测试番</a>
        <a href="/Home/Bangumi/4999" title="其他番剧">其他番剧</a>
      `);
    }
  });

  const discovered = await service.getState("anime-1");
  const candidate = discovered.candidates.find((item) => item.sourceAnimeId === "4007");
  assert.ok(candidate);
  await service.reportMismatch({
    animeId: "anime-1",
    sourceId: candidate.sourceId,
    sourceAnimeId: candidate.sourceAnimeId,
    sourceAnimeTitle: candidate.title,
    score: candidate.score,
    reasons: candidate.reasons
  });

  const reopened = await service.getState("anime-1");
  assert.equal(reopened.candidates.some((item) => item.sourceAnimeId === "4007"), false);
  const restoredCandidate = await service.removeCandidateMismatch({
    animeId: "anime-1",
    sourceId: "mikan",
    sourceAnimeId: "4007"
  });
  assert.equal(restoredCandidate.candidates.some((item) => item.sourceAnimeId === "4007"), true);

  const excluded = await service.setSourceExcluded({ animeId: "anime-1", sourceId: "mikan", excluded: true });
  assert.deepEqual(excluded.candidates, []);
  assert.deepEqual(excluded.excludedSources, [{ sourceId: "mikan", sourceName: "蜜柑计划 RSS" }]);
  const fetchCountAfterExclusion = fetchCount;
  const reopenedExcluded = await service.getState("anime-1");
  assert.deepEqual(reopenedExcluded.excludedSources, excluded.excludedSources);
  assert.equal(fetchCount, fetchCountAfterExclusion);

  const restoredSource = await service.setSourceExcluded({ animeId: "anime-1", sourceId: "mikan", excluded: false });
  assert.deepEqual(restoredSource.excludedSources, []);
  assert.ok(restoredSource.candidates.length > 0);
});

class FakeBindingRepository {
  private readonly item: MyAnime;
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
  private exclusions: AnimeSourceExclusion[] = [];

  constructor(mikanExternalId: string | undefined = "3941") {
    this.item = {
      id: "my-anime-1",
      anime: {
        id: "anime-1",
        title: "测试番",
        aliases: [],
        premiereYear: 2026,
        premiereMonth: 7,
        externalIds: mikanExternalId ? { mikan: mikanExternalId } : {}
      },
      status: "watching",
      autoDownload: false,
      addedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    };
  }

  get bindingCount(): number {
    return this.bindings.length;
  }

  get exclusionCount(): number {
    return this.exclusions.length;
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

  async listAnimeSourceExclusions(): Promise<AnimeSourceExclusion[]> {
    return this.exclusions.map((exclusion) => ({ ...exclusion }));
  }

  async upsertAnimeSourceExclusion(exclusion: AnimeSourceExclusion): Promise<AnimeSourceExclusion[]> {
    const sourceAnimeId = exclusion.sourceAnimeId ?? "";
    const index = this.exclusions.findIndex((item) => (
      item.animeId === exclusion.animeId
      && item.sourceId === exclusion.sourceId
      && (item.sourceAnimeId ?? "") === sourceAnimeId
    ));
    if (index >= 0) this.exclusions[index] = exclusion;
    else this.exclusions.push(exclusion);
    return this.listAnimeSourceExclusions();
  }

  async removeAnimeSourceExclusion(
    animeId: string,
    sourceId: string,
    sourceAnimeId?: string
  ): Promise<AnimeSourceExclusion[]> {
    const normalizedSourceAnimeId = sourceAnimeId ?? "";
    this.exclusions = this.exclusions.filter((item) => !(
      item.animeId === animeId
      && item.sourceId === sourceId
      && (item.sourceAnimeId ?? "") === normalizedSourceAnimeId
    ));
    return this.listAnimeSourceExclusions();
  }
}
