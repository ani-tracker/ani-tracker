import type { AutomationRunResult, ReleaseSearchResult } from "@shared/contracts";
import type { Episode, MyAnime, Release } from "@shared/domain";
import { createTorrentEngine } from "../downloads/torrent-engine-factory";
import type { AppRepository } from "../repositories/app-repository";
import { rankReleases } from "../releases/release-matcher";
import { ReleaseSourceService } from "../sources/release-source-service";

export class AutomationRunService {
  constructor(private readonly repository: AppRepository) {}

  async runOnce(): Promise<AutomationRunResult> {
    const startedAt = new Date().toISOString();
    const result: AutomationRunResult = {
      startedAt,
      finishedAt: startedAt,
      checkedEpisodes: 0,
      downloaded: [],
      skipped: [],
      errors: []
    };

    const settings = await this.repository.getSettings();
    const myAnimeItems = await this.repository.listMyAnime();

    if (!settings.automation.autoDownloadEnabledGlobally) {
      result.skipped.push({
        animeId: "",
        animeTitle: "全局自动下载",
        reason: "全局自动下载未开启"
      });
      result.finishedAt = new Date().toISOString();
      return result;
    }

    const [downloads, fansubs, sources] = await Promise.all([
      this.repository.listDownloads(),
      this.repository.listFansubs(),
      this.repository.listSources()
    ]);
    const sourceService = new ReleaseSourceService(sources);
    const engine = createTorrentEngine(settings);

    for (const anime of myAnimeItems) {
      if (!anime.autoDownload) {
        result.skipped.push({
          animeId: anime.anime.id,
          animeTitle: anime.anime.title,
          reason: "番剧未开启自动下载"
        });
        continue;
      }

      const [episodes, preferences] = await Promise.all([
        this.repository.listEpisodes(anime.anime.id),
        this.repository.listEpisodePreferences(anime.anime.id)
      ]);
      const actionableEpisodes = episodes.filter(isActionableEpisode);

      if (!actionableEpisodes.length) {
        result.skipped.push({
          animeId: anime.anime.id,
          animeTitle: anime.anime.title,
          reason: "没有需要自动处理的单集"
        });
        continue;
      }

      for (const episode of actionableEpisodes) {
        result.checkedEpisodes += 1;

        if (downloads.some((task) => task.animeId === anime.anime.id && task.episodeId === episode.id)) {
          result.skipped.push({
            animeId: anime.anime.id,
            animeTitle: anime.anime.title,
            episodeId: episode.id,
            episodeNo: episode.episodeNo,
            reason: "已有下载任务"
          });
          continue;
        }

        try {
          const preference = preferences.find((item) => item.episodeId === episode.id);
          const searchResults = await searchEpisodeReleases(sourceService, anime, episode, preference?.fansubGroupId);
          const ranked = rankReleases(
            dedupeReleases(searchResults.flatMap((item) => item.releases)),
            {
              anime,
              episodeNo: episode.episodeNo,
              episodeFansubOverrideId: preference?.fansubGroupId
            },
            fansubs
          );
          const best = ranked[0]?.release;

          if (!best) {
            result.skipped.push({
              animeId: anime.anime.id,
              animeTitle: anime.anime.title,
              episodeId: episode.id,
              episodeNo: episode.episodeNo,
              reason: "未找到匹配资源"
            });
            await this.repository.upsertEpisode({
              ...episode,
              status: "aired"
            });
            continue;
          }

          const url = best.magnetUrl ?? best.torrentUrl;
          if (!url) {
            result.skipped.push({
              animeId: anime.anime.id,
              animeTitle: anime.anime.title,
              episodeId: episode.id,
              episodeNo: episode.episodeNo,
              reason: "最佳资源没有下载地址"
            });
            continue;
          }

          const task = await engine.addMagnet(url, {
            savePath: anime.downloadDir ?? settings.download.defaultDownloadDir
          });
          const savedTasks = await this.repository.upsertDownloadTask({
            ...task,
            releaseId: best.id,
            animeId: anime.anime.id,
            episodeId: episode.id,
            name: best.title
          });
          await this.repository.upsertEpisode({
            ...episode,
            status: "downloading"
          });
          downloads.push(savedTasks[0]);
          result.downloaded.push({
            animeId: anime.anime.id,
            animeTitle: anime.anime.title,
            episodeId: episode.id,
            episodeNo: episode.episodeNo,
            releaseId: best.id,
            releaseTitle: best.title,
            downloadTaskId: task.id
          });
        } catch (error) {
          result.errors.push({
            animeId: anime.anime.id,
            animeTitle: anime.anime.title,
            episodeId: episode.id,
            episodeNo: episode.episodeNo,
            message: error instanceof Error ? error.message : "自动下载失败"
          });
        }
      }
    }

    result.finishedAt = new Date().toISOString();
    return result;
  }
}

async function searchEpisodeReleases(
  sourceService: ReleaseSourceService,
  anime: MyAnime,
  episode: Episode,
  fansubGroupId?: string
): Promise<ReleaseSearchResult[]> {
  const terms = buildSearchTerms(anime);
  return Promise.all(
    terms.map((term) =>
      sourceService.search({
        keyword: term,
        animeId: anime.anime.id,
        episodeNo: episode.episodeNo,
        fansubGroupId: fansubGroupId ?? anime.defaultFansubGroupId,
        preferredResolution: anime.preferredResolution,
        limit: 80
      })
    )
  );
}

function buildSearchTerms(anime: MyAnime): string[] {
  return unique(
    [
      anime.anime.title,
      anime.anime.originalTitle ?? "",
      ...anime.anime.aliases.map((alias) => alias.alias)
    ]
      .map((term) => term.trim())
      .filter(Boolean)
  ).slice(0, 8);
}

function isActionableEpisode(episode: Episode): boolean {
  if (["downloading", "downloaded", "watched"].includes(episode.status)) {
    return false;
  }

  if (episode.status === "aired" || episode.status === "matched") {
    return true;
  }

  return episode.airTime ? new Date(episode.airTime).getTime() <= Date.now() : false;
}

function dedupeReleases(releases: Release[]): Release[] {
  const seen = new Set<string>();

  return releases.filter((release) => {
    const key = release.infoHash ?? release.magnetUrl ?? release.torrentUrl ?? release.title;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
