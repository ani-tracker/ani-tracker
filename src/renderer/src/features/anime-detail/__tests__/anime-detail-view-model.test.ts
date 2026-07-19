import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AnimeDetailResult } from "@shared/contracts";
import { buildAnimeDetailViewModel } from "../anime-detail-view-model";

test("详情视图模型只使用真实字段并计算已看进度", () => {
  const result: AnimeDetailResult = {
    anime: {
      id: "anime-1",
      title: "测试番",
      originalTitle: "テストアニメ",
      aliases: [],
      premiereDate: "2026-07-04",
      premiereYear: 2026,
      premiereMonth: 7,
      externalIds: { bangumi: "1" },
      detail: {
        format: "tv",
        airingStatus: "airing",
        episodeCount: 12,
        metadataSources: ["bangumi"]
      }
    },
    episodes: [
      { id: "ep-1", animeId: "anime-1", episodeNo: 1, status: "watched" },
      { id: "ep-2", animeId: "anime-1", episodeNo: 2, status: "downloaded" }
    ],
    fansubGroups: [],
    stale: false,
    partialErrors: []
  };

  const viewModel = buildAnimeDetailViewModel(result);
  assert.equal(viewModel.title, "测试番");
  assert.equal(viewModel.format, "TV 动画");
  assert.equal(viewModel.airingStatus, "放送中");
  assert.equal(viewModel.watchedCount, 1);
  assert.equal(viewModel.downloadedCount, 2);
  assert.equal(viewModel.progress, 1 / 12);
  assert.equal(viewModel.externalLinks[0].url, "https://bgm.tv/subject/1");
});
