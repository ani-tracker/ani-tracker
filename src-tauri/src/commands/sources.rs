use std::sync::{Arc, Mutex};

use ani_contracts::AppCommandError;
use ani_domain::{
    AnimeReleaseQuery, AnimeStatus, AppSettings, Episode, EpisodePreference, FansubGroup, MyAnime,
    ReleaseMatchContext, ReleaseQuery, ReleaseSearchError, ReleaseSearchResult,
    ReleaseSourceConfig, RssSubscriptionReleaseQuery, RssSubscriptionReleaseResult, SourceKind,
};
use ani_repository::{prelude::*, RepositoryError};
use ani_sources::{
    sort_releases_by_rules, ReleaseSearchService, SourceError, COMPLETED_ANIME_RELEASE_CACHE_TTL_MS,
};
use ani_storage::Storage;
use tauri::State;

use crate::sources::{AppSourceState, SharedReleaseSearchStore};
use crate::storage::AppStorageState;

/// 资源搜索需要的只读仓储快照。
struct SearchSnapshot {
    settings: AppSettings,
    sources: Vec<ReleaseSourceConfig>,
    fansubs: Vec<FansubGroup>,
}

/// 番剧级资源搜索需要的追番、单集和偏好快照。
struct AnimeSearchSnapshot {
    search: SearchSnapshot,
    anime: MyAnime,
    episodes: Vec<Episode>,
    preferences: Vec<EpisodePreference>,
}

/// 将来源与仓储错误转换为稳定 Tauri 命令错误。
fn map_source_error(action: &str, error: SourceError) -> AppCommandError {
    log::error!("Tauri 来源命令失败 action={action} error={error}");
    let code = match &error {
        SourceError::InvalidUrl(_)
        | SourceError::UnsupportedScheme(_)
        | SourceError::InvalidProxy(_)
        | SourceError::InvalidHeader(_)
        | SourceError::Parse(_) => "source_invalid_response",
        SourceError::CircuitOpen { .. } => "source_circuit_open",
        SourceError::HttpStatus { .. } | SourceError::Transport(_) => "source_network_failed",
        SourceError::ResponseTooLarge { .. } => "source_response_too_large",
        SourceError::Repository(error) => return map_repository_error(action, error.clone()),
    };
    AppCommandError {
        code: code.to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

/// 将 Repository 错误转换为稳定 Tauri 命令错误。
fn map_repository_error(action: &str, error: RepositoryError) -> AppCommandError {
    let code = match &error {
        RepositoryError::InvalidInput { .. } => "invalid_input",
        RepositoryError::RecordNotFound { .. } => "record_not_found",
        RepositoryError::BackendUnavailable { .. } => "storage_unavailable",
        RepositoryError::Backend { .. } => "storage_operation_failed",
    };
    AppCommandError {
        code: code.to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

/// 将线程池或 SQLite 锁错误转换为稳定命令错误。
fn map_runtime_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    AppCommandError {
        code: "source_runtime_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

/// 在线程池读取来源、字幕组和设置快照。
async fn load_search_snapshot(
    storage: Arc<Mutex<Storage>>,
    defaults: AppSettings,
    anime_id: Option<String>,
) -> Result<SearchSnapshot, AppCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let storage = storage
            .lock()
            .map_err(|error| map_runtime_error("读取资源搜索上下文", error))?;
        let repository = storage.repository();
        Ok(SearchSnapshot {
            settings: repository
                .get_settings(&defaults)
                .map_err(|error| map_repository_error("读取设置", error))?,
            sources: repository
                .list_sources()
                .map_err(|error| map_repository_error("读取下载源", error))?,
            fansubs: repository
                .list_fansubs(anime_id.as_deref())
                .map_err(|error| map_repository_error("读取字幕组", error))?,
        })
    })
    .await
    .map_err(|error| map_runtime_error("读取资源搜索上下文", error))?
}

/// 在线程池读取追番及其单集偏好快照。
async fn load_anime_search_snapshot(
    storage: Arc<Mutex<Storage>>,
    defaults: AppSettings,
    anime_id: String,
) -> Result<AnimeSearchSnapshot, AppCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let storage = storage
            .lock()
            .map_err(|error| map_runtime_error("读取番剧资源上下文", error))?;
        let repository = storage.repository();
        let anime = repository
            .list_my_anime()
            .map_err(|error| map_repository_error("读取我的追番", error))?
            .into_iter()
            .find(|item| item.anime.id == anime_id)
            .ok_or_else(|| AppCommandError {
                code: "record_not_found".to_owned(),
                message: format!("追番不存在：{anime_id}"),
            })?;
        Ok(AnimeSearchSnapshot {
            search: SearchSnapshot {
                settings: repository
                    .get_settings(&defaults)
                    .map_err(|error| map_repository_error("读取设置", error))?,
                sources: repository
                    .list_sources()
                    .map_err(|error| map_repository_error("读取下载源", error))?,
                fansubs: repository
                    .list_fansubs(Some(&anime_id))
                    .map_err(|error| map_repository_error("读取字幕组", error))?,
            },
            episodes: repository
                .list_episodes(&anime_id)
                .map_err(|error| map_repository_error("读取单集", error))?,
            preferences: repository
                .list_episode_preferences(&anime_id)
                .map_err(|error| map_repository_error("读取单集偏好", error))?,
            anime,
        })
    })
    .await
    .map_err(|error| map_runtime_error("读取番剧资源上下文", error))?
}

/// 按任意关键词搜索全部启用下载源。
#[tauri::command]
pub(crate) async fn search_releases(
    query: ReleaseQuery,
    storage_state: State<'_, AppStorageState>,
    source_state: State<'_, AppSourceState>,
) -> Result<ReleaseSearchResult, AppCommandError> {
    let storage = Arc::clone(storage_state.storage());
    let snapshot = load_search_snapshot(
        Arc::clone(&storage),
        storage_state.platform_defaults().clone(),
        query.anime_id.clone(),
    )
    .await?;
    let network = source_state
        .network_service(&snapshot.settings)
        .await
        .map_err(|error| map_source_error("初始化来源网络", error))?;
    let store = SharedReleaseSearchStore::new(storage);
    ReleaseSearchService::new(network)
        .search(&store, &snapshot.sources, &snapshot.fansubs, query)
        .await
        .map_err(|error| map_source_error("搜索资源", error))
}

/// 按追番上下文搜索资源并应用字幕组、清晰度和编码偏好排序。
#[tauri::command]
pub(crate) async fn search_anime_releases(
    mut query: AnimeReleaseQuery,
    storage_state: State<'_, AppStorageState>,
    source_state: State<'_, AppSourceState>,
) -> Result<ReleaseSearchResult, AppCommandError> {
    let storage = Arc::clone(storage_state.storage());
    let snapshot = load_anime_search_snapshot(
        Arc::clone(&storage),
        storage_state.platform_defaults().clone(),
        query.anime_id.clone(),
    )
    .await?;
    if snapshot.anime.status == AnimeStatus::Completed {
        query.cache_ttl_ms = Some(COMPLETED_ANIME_RELEASE_CACHE_TTL_MS);
    }
    let network = source_state
        .network_service(&snapshot.search.settings)
        .await
        .map_err(|error| map_source_error("初始化来源网络", error))?;
    let store = SharedReleaseSearchStore::new(storage);
    let mut result = ReleaseSearchService::new(network)
        .search_anime(
            &store,
            &snapshot.search.sources,
            &snapshot.search.fansubs,
            &snapshot.anime.anime,
            query,
        )
        .await
        .map_err(|error| map_source_error("搜索番剧资源", error))?;
    let episode_overrides = snapshot
        .preferences
        .iter()
        .filter_map(|preference| {
            let episode = snapshot
                .episodes
                .iter()
                .find(|episode| episode.id == preference.episode_id)?;
            preference
                .fansub_group_id
                .as_ref()
                .map(|fansub_id| (episode.episode_no, fansub_id.clone()))
        })
        .collect::<Vec<_>>();
    result.releases = sort_releases_by_rules(
        result.releases,
        |release| ReleaseMatchContext {
            anime: snapshot.anime.clone(),
            episode_no: release.episode_no,
            episode_fansub_override_id: release.episode_no.and_then(|episode_no| {
                episode_overrides
                    .iter()
                    .find(|(candidate, _)| *candidate == episode_no)
                    .map(|(_, fansub_id)| fansub_id.clone())
            }),
            candidate_fansub_group_ids: Vec::new(),
            candidate_fansub_names: Vec::new(),
        },
        &snapshot.search.fansubs,
    );
    Ok(result)
}

/// 搜索一条追番 RSS 订阅，独立于全局来源开关。
#[tauri::command]
pub(crate) async fn search_rss_subscription_releases(
    query: RssSubscriptionReleaseQuery,
    storage_state: State<'_, AppStorageState>,
    source_state: State<'_, AppSourceState>,
) -> Result<RssSubscriptionReleaseResult, AppCommandError> {
    let storage = Arc::clone(storage_state.storage());
    let snapshot = match load_anime_search_snapshot(
        Arc::clone(&storage),
        storage_state.platform_defaults().clone(),
        query.anime_id.clone(),
    )
    .await
    {
        Ok(snapshot) => snapshot,
        Err(error) if error.code == "record_not_found" => {
            return Ok(RssSubscriptionReleaseResult {
                errors: vec![ReleaseSearchError {
                    source_id: query.subscription_id.clone(),
                    message: "追番不存在".to_owned(),
                }],
                query,
                releases: Vec::new(),
            });
        }
        Err(error) => return Err(error),
    };
    let Some(subscription) = snapshot
        .anime
        .rss_subscriptions
        .iter()
        .find(|subscription| subscription.id == query.subscription_id && subscription.enabled)
        .cloned()
    else {
        return Ok(RssSubscriptionReleaseResult {
            errors: vec![ReleaseSearchError {
                source_id: query.subscription_id.clone(),
                message: "RSS 订阅不存在或未启用".to_owned(),
            }],
            query,
            releases: Vec::new(),
        });
    };
    let source = ReleaseSourceConfig {
        id: format!("rss-subscription:{}", subscription.id),
        name: subscription.name,
        kind: SourceKind::Rss,
        enabled: true,
        use_proxy: true,
        request_interval_ms: 1_500,
        base_url: None,
        api_key: None,
        rss_url: Some(subscription.url),
        tags: vec!["anime".to_owned(), "rss".to_owned()],
    };
    let preferred_languages = if !subscription.preferred_subtitle_languages.is_empty() {
        subscription.preferred_subtitle_languages
    } else if !snapshot.anime.preferred_subtitle_languages.is_empty() {
        snapshot.anime.preferred_subtitle_languages.clone()
    } else {
        match subscription
            .preferred_subtitle
            .as_deref()
            .or(snapshot.anime.preferred_subtitle.as_deref())
        {
            Some("multi") => vec!["chs".to_owned(), "cht".to_owned()],
            Some(value) => vec![value.to_owned()],
            None => Vec::new(),
        }
    };
    let network = source_state
        .network_service(&snapshot.search.settings)
        .await
        .map_err(|error| map_source_error("初始化来源网络", error))?;
    let store = SharedReleaseSearchStore::new(storage);
    Ok(ReleaseSearchService::new(network)
        .search_rss_subscription(
            &store,
            &source,
            &snapshot.search.fansubs,
            &snapshot.anime,
            query,
            &preferred_languages,
        )
        .await)
}
