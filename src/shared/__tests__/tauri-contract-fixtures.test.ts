import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { PlayerSnapshot } from "../player-contract";
import { acceptPlayerSnapshot } from "../player-contract";
import type {
  AnimeWatchProgress,
  PlaybackCheckpoint,
  ReportPlaybackProgressInput,
  SavePlaybackCheckpointInput,
  SetAnimeWatchProgressInput
} from "../contracts";
import type {
  DashboardData,
  Episode,
  EpisodePreference,
  MyAnime,
  NotificationRecord
} from "../domain";

interface ContractFixture<T> {
  schemaVersion: number;
  kind: string;
  payload: T;
}

/** 读取版本化播放器快照金样，验证 TypeScript 与 Rust 共用契约。 */
test("Tauri 播放器快照契约金样可被 TypeScript 接受", () => {
  const fixturePath = resolve("fixtures/contracts/player-snapshot.v1.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ContractFixture<PlayerSnapshot>;

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.kind, "player-snapshot");
  assert.equal(fixture.payload.platform, "tauri-desktop");
  assert.equal(fixture.payload.status, "playing");
  assert.equal(fixture.payload.audioTracks.length, 2);
  assert.equal(fixture.payload.subtitleTracks.length, 1);
  assert.equal(
    acceptPlayerSnapshot(fixture.payload.sessionId, undefined, fixture.payload),
    fixture.payload
  );
});

/** 读取 P2 数据金样，验证 Rust 只读模型与现有 TypeScript 领域契约一致。 */
test("Tauri P2 只读数据契约金样可被 TypeScript 接受", () => {
  const fixturePath = resolve("fixtures/contracts/p2-read-model.v1.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ContractFixture<{
    notification: NotificationRecord;
    myAnime: MyAnime;
    dashboard: DashboardData;
  }>;

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.kind, "p2-read-model");
  assert.equal(fixture.payload.notification.kind, "download");
  assert.equal(fixture.payload.myAnime.anime.externalIds.bangumi, "1");
  assert.deepEqual(fixture.payload.myAnime.preferredSubtitleLanguages, ["chs", "cht"]);
  assert.equal(fixture.payload.dashboard.dailyReminder.total, 0);
});

/** 读取 P3 追番写模型金样，验证 Tauri 命令输入输出与前端契约一致。 */
test("Tauri P3 追番写模型契约金样可被 TypeScript 接受", () => {
  const fixturePath = resolve("fixtures/contracts/p3-following-write-model.v1.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ContractFixture<{
    myAnime: MyAnime;
    episode: Episode;
    preference: EpisodePreference;
    watchProgressInput: SetAnimeWatchProgressInput;
    reportPlaybackProgressInput: ReportPlaybackProgressInput;
    savePlaybackCheckpointInput: SavePlaybackCheckpointInput;
    checkpoint: PlaybackCheckpoint;
  }>;
  const progress: AnimeWatchProgress = {
    animeId: fixture.payload.myAnime.anime.id,
    watchedEpisodeCount: fixture.payload.watchProgressInput.watchedEpisodeCount,
    totalEpisodeCount: fixture.payload.myAnime.anime.detail?.episodeCount ?? 0
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.kind, "p3-following-write-model");
  assert.equal(fixture.payload.episode.animeId, fixture.payload.myAnime.anime.id);
  assert.equal(fixture.payload.preference.episodeId, fixture.payload.episode.id);
  assert.equal(fixture.payload.reportPlaybackProgressInput.percent, 92);
  assert.equal(fixture.payload.savePlaybackCheckpointInput.fileIndex, 0);
  assert.equal(fixture.payload.checkpoint.watchedReported, true);
  assert.equal(progress.totalEpisodeCount, 12);
});
