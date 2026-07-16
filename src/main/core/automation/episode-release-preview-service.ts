import type { EpisodeReleasePreview, ReleaseSearchResult } from "@shared/contracts";
import type { Release } from "@shared/domain";
import { buildAnimeReleaseSearchTerms } from "../../../shared/anime-release-search";
import type { AppRepository } from "../repositories/app-repository";
import { rankReleases } from "../releases/release-matcher";
import { ReleaseSourceService } from "../sources/release-source-service";
import { AnimeSourceBindingService } from "../source-bindings/anime-source-binding-service";

export class EpisodeReleasePreviewService {
  constructor(private readonly repository: AppRepository) {}

  async preview(animeId: string, episodeId: string): Promise<EpisodeReleasePreview> {
    const [myAnimeItems, episodes, preferences, fansubs, sources, settings] = await Promise.all([
      this.repository.listMyAnime(),
      this.repository.listEpisodes(animeId),
      this.repository.listEpisodePreferences(animeId),
      this.repository.listFansubs(animeId),
      this.repository.listSources(),
      this.repository.getSettings()
    ]);
    const anime = myAnimeItems.find((item) => item.anime.id === animeId);
    const episode = episodes.find((item) => item.id === episodeId);

    if (!anime) {
      throw new Error("追番不存在");
    }
    if (!episode) {
      throw new Error("单集不存在");
    }

    const preference = preferences.find((item) => item.episodeId === episodeId);
    const preferredFansubGroupId = preference?.fansubGroupId ?? anime.defaultFansubGroupId;
    const terms = buildAnimeReleaseSearchTerms(anime.anime);
    const bindingState = await new AnimeSourceBindingService(this.repository).getState(animeId, false);
    const sourceService = new ReleaseSourceService(sources, fansubs);
    const searchResults = [await sourceService.searchAnime(anime.anime, {
      animeId,
      episodeNo: episode.episodeNo,
      fansubGroupId: preferredFansubGroupId,
      preferredResolution: anime.preferredResolution,
      limit: 80,
      cacheTtlMs: settings.automation.checkIntervalMinutes * 60 * 1000
    }, bindingState.bindings)];
    const releases = dedupeReleases(searchResults.flatMap((result) => result.releases)).map((release) => ({
      ...release,
      animeId
    }));
    await this.repository.observeAnimeFansubs(animeId, releases);

    return {
      animeId,
      episodeId,
      searchedTerms: terms,
      candidates: rankReleases(
        releases,
        {
          anime,
          episodeNo: episode.episodeNo,
          episodeFansubOverrideId: preference?.fansubGroupId
        },
        fansubs
      ).slice(0, 20),
      errors: mergeErrors(searchResults)
    };
  }
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

function mergeErrors(results: ReleaseSearchResult[]): ReleaseSearchResult["errors"] {
  return results.flatMap((result) => result.errors);
}
