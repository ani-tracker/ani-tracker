import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Episode, MyAnime, Release } from "@shared/domain";
import type { CachedReleaseQuery, AppRepository } from "../../repositories/app-repository";
import { EpisodeSyncService } from "../episode-sync-service";

test("EpisodeSyncService 根据元数据和缓存资源补齐整季单集", async () => {
  const repository = new FakeEpisodeSyncRepository([
    createRelease(1),
    createRelease(2)
  ]);
  const item = createMyAnime({
    anime: {
      ...createMyAnime({}).anime,
      premiereDate: "2026-07-08",
      detail: {
        episodeCount: 4,
        broadcast: { timezone: "Asia/Tokyo" }
      }
    }
  });

  const result = await new EpisodeSyncService(repository.asAppRepository(), {
    now: () => new Date("2026-07-23T00:00:00.000Z")
  }).sync(item);

  assert.equal(result.createdCount, 4);
  assert.deepEqual(repository.episodes.map((episode) => episode.status), ["aired", "aired", "aired", "upcoming"]);
  assert.equal(repository.episodes[0].airTime, "2026-07-07T15:00:00.000Z");
  assert.equal(repository.episodes[3].airTime, "2026-07-28T15:00:00.000Z");
});

test("EpisodeSyncService 保留人工记录并仅将有资源的未开播单集推进为已开播", async () => {
  const manualAirTime = "2026-08-20T12:00:00.000Z";
  const repository = new FakeEpisodeSyncRepository(
    [createRelease(2)],
    [
      {
        id: "manual-episode-1",
        animeId: "anime-sync",
        episodeNo: 1,
        status: "watched",
        airTime: "2026-07-01T12:00:00.000Z"
      },
      {
        id: "manual-episode-2",
        animeId: "anime-sync",
        episodeNo: 2,
        status: "upcoming",
        airTime: manualAirTime
      }
    ]
  );

  const result = await new EpisodeSyncService(repository.asAppRepository(), {
    now: () => new Date("2026-07-23T00:00:00.000Z")
  }).sync(createMyAnime({}));

  assert.equal(result.createdCount, 0);
  assert.equal(result.promotedCount, 1);
  assert.equal(repository.episodes[0].id, "manual-episode-1");
  assert.equal(repository.episodes[0].status, "watched");
  assert.equal(repository.episodes[1].id, "manual-episode-2");
  assert.equal(repository.episodes[1].status, "aired");
  assert.equal(repository.episodes[1].airTime, manualAirTime);
});

class FakeEpisodeSyncRepository {
  readonly releases: Release[];
  readonly episodes: Episode[];

  constructor(releases: Release[] = [], episodes: Episode[] = []) {
    this.releases = releases;
    this.episodes = episodes;
  }

  /** 将最小测试仓库暴露为业务仓库接口。 */
  asAppRepository(): AppRepository {
    return this as unknown as AppRepository;
  }

  /** 返回指定番剧的现有单集。 */
  async listEpisodes(animeId: string): Promise<Episode[]> {
    return this.episodes.filter((episode) => episode.animeId === animeId);
  }

  /** 写入或更新测试单集。 */
  async upsertEpisode(episode: Episode): Promise<Episode[]> {
    const index = this.episodes.findIndex((item) => item.id === episode.id);
    if (index >= 0) {
      this.episodes[index] = episode;
    } else {
      this.episodes.push(episode);
      this.episodes.sort((left, right) => left.episodeNo - right.episodeNo);
    }
    return this.listEpisodes(episode.animeId);
  }

  /** 返回同步服务需要的本地资源缓存。 */
  async listCachedReleases(query: CachedReleaseQuery = {}): Promise<Release[]> {
    return this.releases.filter((release) => !query.animeId || release.animeId === query.animeId);
  }
}

/** 创建单集同步测试使用的追番。 */
function createMyAnime(overrides: Partial<MyAnime>): MyAnime {
  return {
    id: "my-anime-sync",
    anime: {
      id: "anime-sync",
      title: "同步测试番",
      aliases: [],
      premiereYear: 2026,
      premiereMonth: 7,
      externalIds: {}
    },
    status: "watching",
    autoDownload: true,
    addedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

/** 创建已关联番剧和集数的缓存资源。 */
function createRelease(episodeNo: number): Release {
  return {
    id: `release-${episodeNo}`,
    title: `同步测试番 - ${episodeNo}`,
    animeId: "anime-sync",
    episodeNo,
    sourceId: "source-test",
    sourceName: "测试源",
    magnetUrl: `magnet:?xt=urn:btih:SYNC${episodeNo}`,
    publishedAt: "2026-07-20T00:00:00.000Z"
  };
}
