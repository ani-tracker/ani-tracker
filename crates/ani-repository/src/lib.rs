use ani_domain::{
    Anime, AnimeDetailResult, AnimeDiscoverySearchResult, AnimeSourceBinding, AnimeSourceExclusion,
    AnimeWatchProgress, AppSettings, DashboardData, Episode, EpisodePreference, FansubGroup,
    MyAnime, NotificationRecord, PlaybackCheckpoint, ReleaseSourceConfig, ReleaseSourceSyncState,
    ReportPlaybackProgressInput, RequestCircuitState, SavePlaybackCheckpointInput,
    SetAnimeWatchProgressInput,
};
use serde_json::Value;

/// 公共 Repository 操作结果，不暴露具体数据库驱动错误。
pub type RepositoryResult<T> = Result<T, RepositoryError>;

/// 跨 SQLite、MySQL 和测试替身稳定的存储错误。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RepositoryError {
    #[error("业务输入无效（{field}）：{message}")]
    InvalidInput { field: String, message: String },
    #[error("{entity}不存在：{id}")]
    RecordNotFound { entity: String, id: String },
    #[error("存储后端不可用（{backend}）：{message}")]
    BackendUnavailable { backend: String, message: String },
    #[error("存储后端操作失败（{backend}）：{message}")]
    Backend { backend: String, message: String },
}

/// 番剧目录批量写入后的计数和完整目录。
#[derive(Debug, Clone, PartialEq)]
pub struct AnimeCatalogWriteResult {
    pub items: Vec<Anime>,
    pub added_count: usize,
    pub existing_count: usize,
}

/// 跨重启资源搜索缓存记录。
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseSearchCacheEntry {
    pub result: Value,
    pub expires_at: String,
}

/// 应用设置存储端口。
pub trait SettingsRepository {
    /// 读取设置，并用当前平台默认值补齐新增字段。
    fn get_settings(&self, platform_defaults: &AppSettings) -> RepositoryResult<AppSettings>;

    /// 将部分设置递归合并到当前平台设置。
    fn update_settings(
        &self,
        patch: &Value,
        platform_defaults: &AppSettings,
    ) -> RepositoryResult<AppSettings>;

    /// 恢复当前平台默认设置。
    fn reset_settings(&self, platform_defaults: &AppSettings) -> RepositoryResult<AppSettings>;
}

/// 提醒中心存储端口。
pub trait NotificationRepository {
    /// 按创建时间倒序读取通知。
    fn list_notifications(&self) -> RepositoryResult<Vec<NotificationRecord>>;

    /// 统计未读通知数量。
    fn get_unread_notification_count(&self) -> RepositoryResult<u64>;
}

/// 番剧目录与详情存储端口。
pub trait AnimeCatalogRepository {
    /// 按可选年月读取本地番剧目录。
    fn list_anime_catalog(
        &self,
        year: Option<i64>,
        month: Option<i64>,
    ) -> RepositoryResult<Vec<Anime>>;

    /// 按标识读取番剧目录记录。
    fn get_anime_catalog_by_id(&self, anime_id: &str) -> RepositoryResult<Option<Anime>>;

    /// 按标题、原名和别名搜索本地番剧目录。
    fn search_anime_catalog(&self, keyword: &str) -> RepositoryResult<AnimeDiscoverySearchResult>;

    /// 合并并原子保存一批番剧目录记录。
    fn upsert_anime_catalog(&self, items: &[Anime]) -> RepositoryResult<AnimeCatalogWriteResult>;

    /// 原子替换指定月份的未引用目录缓存。
    fn replace_anime_catalog_month(
        &self,
        year: i64,
        month: i64,
        items: &[Anime],
    ) -> RepositoryResult<AnimeCatalogWriteResult>;

    /// 聚合番剧详情页需要的本地数据。
    fn get_anime_detail(&self, anime_id: &str) -> RepositoryResult<AnimeDetailResult>;

    /// 读取全部或指定番剧已观察到的字幕组。
    fn list_fansubs(&self, anime_id: Option<&str>) -> RepositoryResult<Vec<FansubGroup>>;
}

/// 下载源配置、游标、缓存和熔断存储端口。
pub trait ReleaseSourceRepository {
    /// 读取全部下载源配置。
    fn list_sources(&self) -> RepositoryResult<Vec<ReleaseSourceConfig>>;

    /// 启用或停用一个下载源。
    fn set_source_enabled(
        &self,
        source_id: &str,
        enabled: bool,
    ) -> RepositoryResult<Vec<ReleaseSourceConfig>>;

    /// 新增或更新下载源配置。
    fn upsert_source(
        &self,
        source: &ReleaseSourceConfig,
    ) -> RepositoryResult<Vec<ReleaseSourceConfig>>;

    /// 读取全部来源同步与条件请求游标。
    fn list_source_sync_states(&self) -> RepositoryResult<Vec<ReleaseSourceSyncState>>;

    /// 保存单个来源同步与条件请求游标。
    fn upsert_source_sync_state(&self, state: &ReleaseSourceSyncState) -> RepositoryResult<()>;

    /// 读取一个通用网络熔断状态。
    fn get_request_circuit_state(&self, key: &str)
        -> RepositoryResult<Option<RequestCircuitState>>;

    /// 保存通用网络熔断状态。
    fn upsert_request_circuit_state(&self, state: &RequestCircuitState) -> RepositoryResult<()>;

    /// 删除一个已恢复的通用网络熔断状态。
    fn clear_request_circuit_state(&self, key: &str) -> RepositoryResult<()>;

    /// 读取尚未过期的资源搜索缓存。
    fn get_release_search_cache(
        &self,
        cache_key: &str,
        current_time: &str,
    ) -> RepositoryResult<Option<ReleaseSearchCacheEntry>>;

    /// 保存资源搜索结果并清理过期缓存。
    fn upsert_release_search_cache(
        &self,
        cache_key: &str,
        entry: &ReleaseSearchCacheEntry,
    ) -> RepositoryResult<()>;
}

/// 番剧来源绑定与人工排除存储端口。
pub trait AnimeSourceBindingRepository {
    /// 读取指定番剧的全部来源绑定。
    fn list_anime_source_bindings(
        &self,
        anime_id: &str,
    ) -> RepositoryResult<Vec<AnimeSourceBinding>>;

    /// 新增或更新一条来源绑定。
    fn upsert_anime_source_binding(
        &self,
        binding: &AnimeSourceBinding,
    ) -> RepositoryResult<Vec<AnimeSourceBinding>>;

    /// 删除指定番剧和来源的绑定。
    fn remove_anime_source_binding(
        &self,
        anime_id: &str,
        source_id: &str,
    ) -> RepositoryResult<Vec<AnimeSourceBinding>>;

    /// 读取指定番剧的候选与整来源排除记录。
    fn list_anime_source_exclusions(
        &self,
        anime_id: &str,
    ) -> RepositoryResult<Vec<AnimeSourceExclusion>>;

    /// 新增或更新一条来源排除记录。
    fn upsert_anime_source_exclusion(
        &self,
        exclusion: &AnimeSourceExclusion,
    ) -> RepositoryResult<Vec<AnimeSourceExclusion>>;

    /// 删除一条候选或整来源排除记录。
    fn remove_anime_source_exclusion(
        &self,
        anime_id: &str,
        source_id: &str,
        source_anime_id: Option<&str>,
    ) -> RepositoryResult<Vec<AnimeSourceExclusion>>;
}

/// 追番、单集、偏好和观看进度存储端口。
pub trait AnimeTrackingRepository {
    /// 读取我的追番列表。
    fn list_my_anime(&self) -> RepositoryResult<Vec<MyAnime>>;

    /// 新增或更新追番规则。
    fn upsert_my_anime(&self, item: MyAnime) -> RepositoryResult<Vec<MyAnime>>;

    /// 删除追番及其单集业务数据。
    fn remove_my_anime(&self, item_id: &str) -> RepositoryResult<Vec<MyAnime>>;

    /// 读取指定番剧的全部单集。
    fn list_episodes(&self, anime_id: &str) -> RepositoryResult<Vec<Episode>>;

    /// 新增或更新一条单集。
    fn upsert_episode(&self, episode: &Episode) -> RepositoryResult<Vec<Episode>>;

    /// 汇总全部追番的连续观看进度。
    fn list_my_anime_watch_progress(&self) -> RepositoryResult<Vec<AnimeWatchProgress>>;

    /// 原子更新单部追番观看进度。
    fn set_anime_watch_progress(
        &self,
        input: &SetAnimeWatchProgressInput,
    ) -> RepositoryResult<AnimeWatchProgress>;

    /// 读取指定番剧的单集级偏好。
    fn list_episode_preferences(&self, anime_id: &str) -> RepositoryResult<Vec<EpisodePreference>>;

    /// 新增或更新一条单集级偏好。
    fn upsert_episode_preference(
        &self,
        preference: &EpisodePreference,
    ) -> RepositoryResult<Vec<EpisodePreference>>;

    /// 删除一条单集级偏好。
    fn remove_episode_preference(
        &self,
        episode_id: &str,
    ) -> RepositoryResult<Vec<EpisodePreference>>;
}

/// 播放进度和续播检查点存储端口。
pub trait PlaybackRepository {
    /// 达到阈值时将关联单集标记为已看。
    fn report_playback_progress(
        &self,
        input: &ReportPlaybackProgressInput,
    ) -> RepositoryResult<bool>;

    /// 读取指定下载文件最近一次可靠播放位置。
    fn get_playback_checkpoint(
        &self,
        task_id: &str,
        file_index: Option<i64>,
    ) -> RepositoryResult<Option<PlaybackCheckpoint>>;

    /// 保存续播位置并同步已看状态。
    fn save_playback_checkpoint(
        &self,
        input: &SavePlaybackCheckpointInput,
    ) -> RepositoryResult<PlaybackCheckpoint>;
}

/// 首页聚合查询存储端口。
pub trait DashboardRepository {
    /// 从业务数据生成首页实时聚合结果。
    fn get_dashboard(&self) -> RepositoryResult<DashboardData>;
}

/// 应用业务可依赖的完整 Repository 端口集合。
pub trait ApplicationRepository:
    SettingsRepository
    + NotificationRepository
    + AnimeCatalogRepository
    + ReleaseSourceRepository
    + AnimeSourceBindingRepository
    + AnimeTrackingRepository
    + PlaybackRepository
    + DashboardRepository
{
}

impl<T> ApplicationRepository for T where
    T: SettingsRepository
        + NotificationRepository
        + AnimeCatalogRepository
        + ReleaseSourceRepository
        + AnimeSourceBindingRepository
        + AnimeTrackingRepository
        + PlaybackRepository
        + DashboardRepository
{
}

/// 一组 Repository 共用的显式事务边界。
pub trait UnitOfWork: Sized {
    type Repositories<'repository>: ApplicationRepository
    where
        Self: 'repository;

    /// 返回绑定当前事务的 Repository 集合。
    fn repositories(&self) -> Self::Repositories<'_>;

    /// 原子提交当前工作单元。
    fn commit(self) -> RepositoryResult<()>;

    /// 显式回滚当前工作单元。
    fn rollback(self) -> RepositoryResult<()>;
}

/// 由具体存储适配器创建工作单元。
pub trait UnitOfWorkFactory {
    type Work<'work>: UnitOfWork
    where
        Self: 'work;

    /// 开始一个新的工作单元。
    fn begin_unit_of_work(&mut self) -> RepositoryResult<Self::Work<'_>>;
}

/// 常用 Repository traits 的统一导入入口。
pub mod prelude {
    pub use super::{
        AnimeCatalogRepository, AnimeSourceBindingRepository, AnimeTrackingRepository,
        ApplicationRepository, DashboardRepository, NotificationRepository, PlaybackRepository,
        ReleaseSourceRepository, SettingsRepository, UnitOfWork, UnitOfWorkFactory,
    };
}
