use ani_domain::{Episode, EpisodeStatus, MyAnime, Release};
use ani_repository::{
    AnimeTrackingRepository, CachedReleaseQuery, ReleaseCacheRepository, RepositoryResult,
};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;

const MAX_METADATA_EPISODES: i64 = 2_000;
const MAX_RELEASE_RANGE_EPISODES: i64 = 200;

/// 一次追番单集补齐的计数结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeSyncResult {
    pub anime_id: String,
    pub created_count: usize,
    pub updated_count: usize,
    pub promoted_count: usize,
    pub total_count: usize,
}

#[derive(Debug, Clone)]
struct EpisodeSeed {
    episode_no: f64,
    air_time: Option<String>,
    has_release: bool,
}

/// 单集同步依赖的窄 Repository 端口。
pub trait EpisodeSyncStore {
    /// 读取番剧现有单集。
    fn list_sync_episodes(&self, anime_id: &str) -> RepositoryResult<Vec<Episode>>;

    /// 幂等保存一条单集。
    fn save_sync_episode(&self, episode: &Episode) -> RepositoryResult<Vec<Episode>>;

    /// 读取番剧跨重启资源缓存。
    fn list_sync_cached_releases(&self, anime_id: &str) -> RepositoryResult<Vec<Release>>;
}

impl<T> EpisodeSyncStore for T
where
    T: AnimeTrackingRepository + ReleaseCacheRepository,
{
    /// 将完整 Repository 组合适配为单集同步端口。
    fn list_sync_episodes(&self, anime_id: &str) -> RepositoryResult<Vec<Episode>> {
        AnimeTrackingRepository::list_episodes(self, anime_id)
    }

    /// 将完整 Repository 组合适配为单集同步端口。
    fn save_sync_episode(&self, episode: &Episode) -> RepositoryResult<Vec<Episode>> {
        AnimeTrackingRepository::upsert_episode(self, episode)
    }

    /// 将完整 Repository 组合适配为单集同步端口。
    fn list_sync_cached_releases(&self, anime_id: &str) -> RepositoryResult<Vec<Release>> {
        ReleaseCacheRepository::list_cached_releases(
            self,
            &CachedReleaseQuery {
                source_ids: None,
                anime_id: Some(anime_id.to_owned()),
                limit: Some(2_000),
            },
        )
    }
}

/// 根据番剧元数据与本地资源缓存幂等补齐单集。
pub struct EpisodeSyncService;

impl EpisodeSyncService {
    /// 同步单部追番，并保留已有标识、人工时间和生命周期状态。
    pub fn sync<S>(
        store: &S,
        item: &MyAnime,
        discovered_releases: &[Release],
        now: DateTime<Utc>,
    ) -> RepositoryResult<EpisodeSyncResult>
    where
        S: EpisodeSyncStore,
    {
        let mut episodes = store.list_sync_episodes(&item.anime.id)?;
        let mut releases = store.list_sync_cached_releases(&item.anime.id)?;
        releases.extend_from_slice(discovered_releases);
        let seeds = build_episode_seeds(item, &releases);
        let mut created_count = 0;
        let mut updated_count = 0;
        let mut promoted_count = 0;

        for seed in seeds {
            let existing_index = episodes
                .iter()
                .position(|episode| same_episode_no(episode.episode_no, seed.episode_no));
            let should_be_aired = seed.has_release || is_past_or_now(seed.air_time.as_deref(), now);
            let Some(index) = existing_index else {
                let episode = Episode {
                    id: create_episode_id(&item.anime.id, seed.episode_no),
                    anime_id: item.anime.id.clone(),
                    episode_no: seed.episode_no,
                    title: None,
                    air_time: seed.air_time,
                    status: if should_be_aired {
                        EpisodeStatus::Aired
                    } else {
                        EpisodeStatus::Upcoming
                    },
                };
                store.save_sync_episode(&episode)?;
                episodes.push(episode);
                created_count += 1;
                continue;
            };
            let existing = &episodes[index];
            let next_status = if existing.status == EpisodeStatus::Upcoming && should_be_aired {
                EpisodeStatus::Aired
            } else {
                existing.status.clone()
            };
            let next_air_time = existing.air_time.clone().or(seed.air_time);
            if next_status == existing.status && next_air_time == existing.air_time {
                continue;
            }
            let mut updated = existing.clone();
            let was_upcoming = updated.status == EpisodeStatus::Upcoming;
            updated.status = next_status;
            updated.air_time = next_air_time;
            store.save_sync_episode(&updated)?;
            if was_upcoming && updated.status == EpisodeStatus::Aired {
                promoted_count += 1;
            }
            episodes[index] = updated;
            updated_count += 1;
        }

        let result = EpisodeSyncResult {
            anime_id: item.anime.id.clone(),
            created_count,
            updated_count,
            promoted_count,
            total_count: episodes.len(),
        };
        if created_count > 0 || updated_count > 0 {
            log::info!(
                "Rust 追番单集同步完成：anime_id={}, created={}, updated={}, promoted={}, total={}",
                result.anime_id,
                result.created_count,
                result.updated_count,
                result.promoted_count,
                result.total_count
            );
        }
        Ok(result)
    }
}

/// 汇总元数据集数、播出时间和资源覆盖集数。
fn build_episode_seeds(item: &MyAnime, releases: &[Release]) -> Vec<EpisodeSeed> {
    let mut seeds = Vec::new();
    let episode_count = item
        .anime
        .detail
        .as_ref()
        .and_then(|detail| detail.get("episodeCount"))
        .and_then(serde_json::Value::as_i64)
        .filter(|count| *count > 0)
        .unwrap_or(0)
        .min(MAX_METADATA_EPISODES);
    for episode_no in 1..=episode_count {
        seeds.push(EpisodeSeed {
            episode_no: episode_no as f64,
            air_time: resolve_air_time(item, episode_no as f64),
            has_release: false,
        });
    }
    for release in releases {
        for episode_no in release_episode_numbers(release) {
            if let Some(seed) = seeds
                .iter_mut()
                .find(|seed| same_episode_no(seed.episode_no, episode_no))
            {
                seed.has_release = true;
            } else {
                seeds.push(EpisodeSeed {
                    episode_no,
                    air_time: resolve_air_time(item, episode_no),
                    has_release: true,
                });
            }
        }
    }
    seeds.sort_by(|left, right| left.episode_no.total_cmp(&right.episode_no));
    seeds
}

/// 按周推导指定单集的播出时间。
fn resolve_air_time(item: &MyAnime, episode_no: f64) -> Option<String> {
    let detail = item.anime.detail.as_ref();
    let next_airing_at = detail
        .and_then(|value| value.get("nextAiringAt"))
        .and_then(serde_json::Value::as_str)
        .and_then(parse_datetime);
    let next_episode_no = detail
        .and_then(|value| value.get("nextAiringEpisodeNo"))
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0);
    if let (Some(next_airing_at), Some(next_episode_no)) = (next_airing_at, next_episode_no) {
        let weeks = episode_no - next_episode_no;
        if weeks.fract().abs() < f64::EPSILON {
            return Some(
                (next_airing_at + Duration::weeks(weeks as i64))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            );
        }
    }

    let premiere_date = item
        .anime
        .premiere_date
        .as_deref()
        .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())?;
    if episode_no.fract().abs() >= f64::EPSILON {
        return None;
    }
    let broadcast_time = detail
        .and_then(|value| value.pointer("/broadcast/time"))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| NaiveTime::parse_from_str(value, "%H:%M").ok())
        .unwrap_or(NaiveTime::MIN);
    let local = NaiveDateTime::new(premiere_date, broadcast_time);
    let timezone = detail
        .and_then(|value| value.pointer("/broadcast/timezone"))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.parse::<Tz>().ok());
    let premiere = timezone
        .and_then(|timezone| timezone.from_local_datetime(&local).earliest())
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(|| Utc.from_utc_datetime(&local));
    Some(
        (premiere + Duration::weeks(episode_no as i64 - 1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

/// 读取资源覆盖的单集编号，并限制异常合集展开规模。
fn release_episode_numbers(release: &Release) -> Vec<f64> {
    if let Some(episode_no) = release
        .episode_no
        .filter(|value| value.is_finite() && *value > 0.0)
    {
        return vec![episode_no];
    }
    let Some(range) = release.episode_range.as_ref() else {
        return Vec::new();
    };
    if !range.start.is_finite()
        || !range.end.is_finite()
        || range.start <= 0.0
        || range.end < range.start
        || range.start.fract().abs() >= f64::EPSILON
        || range.end.fract().abs() >= f64::EPSILON
    {
        return Vec::new();
    }
    let start = range.start as i64;
    let end = range.end as i64;
    if end - start + 1 > MAX_RELEASE_RANGE_EPISODES {
        return Vec::new();
    }
    (start..=end).map(|value| value as f64).collect()
}

/// 判断播出时间是否已经到达。
fn is_past_or_now(value: Option<&str>, now: DateTime<Utc>) -> bool {
    value
        .and_then(parse_datetime)
        .is_some_and(|value| value <= now)
}

/// 宽容解析 RFC3339 播出时间。
fn parse_datetime(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

/// 为自动同步的单集生成稳定标识。
fn create_episode_id(anime_id: &str, episode_no: f64) -> String {
    let number = if episode_no.fract().abs() < f64::EPSILON {
        format!("{}", episode_no as i64)
    } else {
        episode_no.to_string().replace('.', "-")
    };
    format!("episode-{anime_id}-{number}")
}

/// 比较含 OVA 小数编号的单集号。
fn same_episode_no(left: f64, right: f64) -> bool {
    (left - right).abs() < 1e-9
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use ani_domain::{Episode, EpisodeStatus, MyAnime, Release};
    use ani_repository::RepositoryResult;
    use chrono::{TimeZone, Utc};

    use super::{EpisodeSyncService, EpisodeSyncStore};

    struct MemoryEpisodeStore {
        episodes: Mutex<Vec<Episode>>,
        releases: Vec<Release>,
    }

    impl EpisodeSyncStore for MemoryEpisodeStore {
        /// 读取测试单集。
        fn list_sync_episodes(&self, _anime_id: &str) -> RepositoryResult<Vec<Episode>> {
            Ok(self.episodes.lock().expect("lock episodes").clone())
        }

        /// 保存测试单集。
        fn save_sync_episode(&self, episode: &Episode) -> RepositoryResult<Vec<Episode>> {
            let mut episodes = self.episodes.lock().expect("lock episodes");
            episodes.retain(|item| item.id != episode.id);
            episodes.push(episode.clone());
            Ok(episodes.clone())
        }

        /// 读取测试资源缓存。
        fn list_sync_cached_releases(&self, _anime_id: &str) -> RepositoryResult<Vec<Release>> {
            Ok(self.releases.clone())
        }
    }

    /// 验证元数据补齐单集，并由缓存资源推进已播状态。
    #[test]
    fn synchronizes_metadata_and_cached_release_episodes() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p3-following-write-model.v1.json"
        )))
        .expect("decode following fixture");
        let mut item: MyAnime =
            serde_json::from_value(fixture["payload"]["myAnime"].clone()).expect("decode my anime");
        item.anime.detail = Some(serde_json::json!({
            "episodeCount": 2,
            "nextAiringAt": "2026-07-25T10:00:00.000Z",
            "nextAiringEpisodeNo": 2
        }));
        let release_fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p3-release-search-model.v1.json"
        )))
        .expect("decode release fixture");
        let mut release: Release = serde_json::from_value(
            release_fixture["payload"]["searchResult"]["releases"][0].clone(),
        )
        .expect("decode release");
        release.anime_id = Some(item.anime.id.clone());
        release.episode_no = Some(1.0);
        let store = MemoryEpisodeStore {
            episodes: Mutex::new(vec![Episode {
                id: format!("episode-{}-1", item.anime.id),
                anime_id: item.anime.id.clone(),
                episode_no: 1.0,
                title: None,
                air_time: None,
                status: EpisodeStatus::Upcoming,
            }]),
            releases: vec![release],
        };

        let result = EpisodeSyncService::sync(
            &store,
            &item,
            &[],
            Utc.with_ymd_and_hms(2026, 7, 25, 9, 0, 0)
                .single()
                .expect("fixed time"),
        )
        .expect("sync episodes");
        assert_eq!(result.created_count, 1);
        assert_eq!(result.updated_count, 1);
        assert_eq!(result.promoted_count, 1);
        let episodes = store.episodes.lock().expect("lock episodes");
        assert_eq!(episodes.len(), 2);
        assert!(episodes
            .iter()
            .any(|episode| episode.episode_no == 1.0 && episode.status == EpisodeStatus::Aired));
        assert!(episodes
            .iter()
            .any(|episode| episode.episode_no == 2.0 && episode.status == EpisodeStatus::Upcoming));
    }
}
