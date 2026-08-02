use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use ani_contracts::{
    LocalMediaImportAssociation, LocalMediaImportCandidate, LocalMediaImportJobStatus,
    LocalMediaImportPhase, LocalMediaImportSelection, LocalMediaSourceSummary,
};
use ani_domain::{
    Anime, AnimeAlias, AnimeAliasLanguage, AnimeStatus, Episode, EpisodeStatus, MediaAvailability,
    MediaFile, MediaOrigin, MyAnime,
};
use ani_media::MediaProbeContext;
use ani_repository::{
    AnimeCatalogRepository, AnimeTrackingRepository, MediaRepository, UnitOfWork, UnitOfWorkFactory,
};
use ani_sources::{
    build_anime_release_search_terms, matches_anime_release_title, merge_anime_metadata_batches,
    normalize_release_search_text, parse_release_title, AnimeMetadataBatch, AnimeMetadataService,
    ParsedReleaseTitle,
};
use chrono::{DateTime, Datelike, SecondsFormat, Utc};
use regex::Regex;
use tauri::Emitter;

use crate::media::AppMediaState;
use crate::sources::SharedReleaseSearchStore;

const LOCAL_MEDIA_STATUS_EVENT: &str = "local-media-import-status-changed";
const MAX_SCAN_DEPTH: usize = 16;
const MAX_VIDEO_FILES: usize = 10_000;
const ONLINE_MATCH_LIMIT: usize = 50;

/// 本地媒体后台任务共享的状态、取消信号和待确认快照。
pub(super) struct LocalMediaRuntime {
    status: Mutex<LocalMediaImportJobStatus>,
    pending: Mutex<Option<PendingImport>>,
    in_flight: AtomicBool,
    cancel: Arc<AtomicBool>,
    sequence: AtomicU64,
}

impl LocalMediaRuntime {
    /// 创建空闲的本地媒体任务运行时。
    pub(super) fn new() -> Self {
        Self {
            status: Mutex::new(LocalMediaImportJobStatus::default()),
            pending: Mutex::new(None),
            in_flight: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
            sequence: AtomicU64::new(0),
        }
    }
}

#[derive(Clone)]
struct ScannedFile {
    path: PathBuf,
    episode_no: Option<f64>,
    parsed: ParsedReleaseTitle,
    size: i64,
    modified_at: Option<String>,
    fingerprint: String,
}

#[derive(Clone)]
struct PendingCandidate {
    summary: LocalMediaImportCandidate,
    files: Vec<ScannedFile>,
    automatic_match: bool,
}

struct PendingImport {
    job_id: String,
    source_root: PathBuf,
    candidates: Vec<PendingCandidate>,
}

#[derive(Clone)]
struct ResolvedCandidate {
    candidate: PendingCandidate,
    anime: Anime,
}

impl AppMediaState {
    /// 返回当前本地媒体后台任务状态。
    pub(crate) fn local_media_import_status(&self) -> LocalMediaImportJobStatus {
        self.local_import
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// 汇总全部原地导入目录及其媒体可用状态。
    pub(crate) fn list_local_media_sources(&self) -> Result<Vec<LocalMediaSourceSummary>, String> {
        let media_files = self.list_media_files()?;
        let mut sources = BTreeMap::<String, LocalMediaSourceSummary>::new();
        for media in media_files
            .into_iter()
            .filter(|media| media.origin == MediaOrigin::Imported)
        {
            let Some(root) = media.source_root.filter(|value| !value.trim().is_empty()) else {
                continue;
            };
            let source = sources
                .entry(root.clone())
                .or_insert_with(|| LocalMediaSourceSummary {
                    root_path: root,
                    media_count: 0,
                    available_count: 0,
                    problem_count: 0,
                    last_scanned_at: None,
                });
            source.media_count += 1;
            if media.availability == MediaAvailability::Available {
                source.available_count += 1;
            } else {
                source.problem_count += 1;
            }
            if media.last_verified_at > source.last_scanned_at {
                source.last_scanned_at = media.last_verified_at;
            }
        }
        Ok(sources.into_values().collect())
    }

    /// 请求正在运行的本地媒体任务尽快取消。
    pub(crate) fn cancel_local_media_import(&self) -> LocalMediaImportJobStatus {
        if self.local_media_import_status().phase == LocalMediaImportPhase::AwaitingReview {
            *self
                .local_import
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            self.local_import.cancel.store(false, Ordering::Release);
            return self.update_local_media_status(|status| {
                status.phase = LocalMediaImportPhase::Cancelled;
                status.candidates.clear();
                status.completed_at = Some(now_iso());
                status.message = Some("已放弃待确认的扫描结果".to_owned());
                status.error = None;
            });
        }
        self.local_import.cancel.store(true, Ordering::Release);
        self.update_local_media_status(|status| {
            status.message = Some("正在取消后台任务".to_owned());
        })
    }

    /// 将目录扫描和高置信度导入加入 Tauri 后台任务。
    #[cfg(desktop)]
    pub(crate) fn start_local_media_import(
        &self,
        source_root: PathBuf,
    ) -> Result<LocalMediaImportJobStatus, String> {
        let source_root = crate::path_utils::canonicalize(&source_root)
            .map_err(|error| format!("无法访问扫描目录 {}：{error}", source_root.display()))?;
        if !source_root.is_dir() {
            return Err(format!("扫描路径不是目录：{}", source_root.display()));
        }
        self.ensure_no_pending_review()?;
        self.reserve_local_media_job()?;
        let job_id = self.next_local_media_job_id("scan");
        self.local_import.cancel.store(false, Ordering::Release);
        self.replace_local_media_status(LocalMediaImportJobStatus {
            job_id: Some(job_id.clone()),
            phase: LocalMediaImportPhase::Scanning,
            source_root: Some(source_root.to_string_lossy().into_owned()),
            message: Some("正在扫描视频文件".to_owned()),
            started_at: Some(now_iso()),
            ..LocalMediaImportJobStatus::default()
        });
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = state
                .run_local_media_scan(job_id.clone(), source_root)
                .await;
            if let Err(error) = result {
                state.fail_local_media_job(&job_id, error);
            }
            state.local_import.in_flight.store(false, Ordering::Release);
        });
        Ok(self.local_media_import_status())
    }

    /// 按用户确认结果继续导入低置信度候选。
    #[cfg(desktop)]
    pub(crate) fn confirm_local_media_import(
        &self,
        job_id: &str,
        selections: Vec<LocalMediaImportSelection>,
    ) -> Result<LocalMediaImportJobStatus, String> {
        self.reserve_local_media_job()?;
        let pending = {
            let mut pending = self
                .local_import
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if pending.as_ref().map(|item| item.job_id.as_str()) != Some(job_id) {
                self.local_import.in_flight.store(false, Ordering::Release);
                return Err("待确认扫描结果不存在或已经失效".to_owned());
            }
            pending.take().expect("已校验待确认扫描结果")
        };
        let resolved = match resolve_review_selections(&pending.candidates, &selections) {
            Ok(resolved) => resolved,
            Err(error) => {
                *self
                    .local_import
                    .pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(pending);
                self.local_import.in_flight.store(false, Ordering::Release);
                return Err(error);
            }
        };
        self.local_import.cancel.store(false, Ordering::Release);
        self.update_local_media_status(|status| {
            status.phase = LocalMediaImportPhase::Importing;
            status.candidates.clear();
            status.total_files = resolved
                .iter()
                .map(|candidate| candidate.candidate.files.len())
                .sum();
            status.processed_files = 0;
            status.message = Some("正在后台导入已确认媒体".to_owned());
            status.error = None;
        });
        let state = self.clone();
        let job_id = job_id.to_owned();
        tauri::async_runtime::spawn(async move {
            let result = state
                .import_resolved_candidates(&job_id, &pending.source_root, resolved)
                .await;
            match result {
                Ok((anime_count, media_count)) => {
                    state.complete_local_media_job(&job_id, anime_count, media_count)
                }
                Err(error) => state.fail_local_media_job(&job_id, error),
            }
            state.local_import.in_flight.store(false, Ordering::Release);
        });
        Ok(self.local_media_import_status())
    }

    /// 将全部已登记媒体的路径校验加入后台任务。
    pub(crate) fn start_media_availability_check(
        &self,
    ) -> Result<LocalMediaImportJobStatus, String> {
        self.ensure_no_pending_review()?;
        self.reserve_local_media_job()?;
        let job_id = self.next_local_media_job_id("verify");
        self.local_import.cancel.store(false, Ordering::Release);
        self.replace_local_media_status(LocalMediaImportJobStatus {
            job_id: Some(job_id.clone()),
            phase: LocalMediaImportPhase::Verifying,
            message: Some("正在校验已登记媒体".to_owned()),
            started_at: Some(now_iso()),
            ..LocalMediaImportJobStatus::default()
        });
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = state.run_media_availability_check(&job_id).await;
            if let Err(error) = result {
                state.fail_local_media_job(&job_id, error);
            }
            state.local_import.in_flight.store(false, Ordering::Release);
        });
        Ok(self.local_media_import_status())
    }

    /// 执行目录枚举、番剧匹配和高置信度自动导入。
    #[cfg(desktop)]
    async fn run_local_media_scan(
        &self,
        job_id: String,
        source_root: PathBuf,
    ) -> Result<(), String> {
        let settings = self.settings()?;
        let extensions = media_extensions(&settings);
        let cancel = Arc::clone(&self.local_import.cancel);
        let progress_state = self.clone();
        let root_for_scan = source_root.clone();
        let files = tauri::async_runtime::spawn_blocking(move || {
            discover_video_files(&root_for_scan, &extensions, &cancel, |count| {
                if count == 1 || count % 25 == 0 {
                    progress_state.update_local_media_status(|status| {
                        status.discovered_files = count;
                        status.message = Some(format!("已发现 {count} 个视频文件"));
                    });
                }
            })
        })
        .await
        .map_err(|error| format!("本地媒体扫描线程失败：{error}"))??;
        self.ensure_not_cancelled(&job_id)?;
        self.remove_ignored_imported_media(&source_root)?;
        if files.is_empty() {
            self.complete_local_media_job(&job_id, 0, 0);
            self.update_local_media_status(|status| {
                status.message = Some("目录中没有找到支持的视频文件".to_owned());
            });
            return Ok(());
        }
        let (catalog, tracked) = self.load_anime_match_context()?;
        let catalog = merge_anime_metadata_batches(&[
            AnimeMetadataBatch {
                source: "tracking".to_owned(),
                items: tracked.into_iter().map(|item| item.anime).collect(),
            },
            AnimeMetadataBatch {
                source: "catalog".to_owned(),
                items: catalog,
            },
        ]);
        let groups = group_scanned_files(&source_root, files, &catalog);
        log::info!(
            "Tauri 本地媒体扫描完成枚举 source_root={} candidate_count={} file_count={}",
            source_root.display(),
            groups.len(),
            groups
                .values()
                .map(|candidate| candidate.files.len())
                .sum::<usize>()
        );
        self.update_local_media_status(|status| {
            status.phase = LocalMediaImportPhase::Matching;
            status.discovered_files = status
                .discovered_files
                .max(groups.values().map(|candidate| candidate.files.len()).sum());
            status.total_files = groups.len();
            status.processed_files = 0;
            status.message = Some("正在匹配番剧目录与在线元数据".to_owned());
        });
        let existing_media_by_path = self
            .list_media_files()?
            .into_iter()
            .map(|media| (media.file_path.clone(), media))
            .collect::<HashMap<_, _>>();
        let metadata = match self.source_state.network_service(&settings).await {
            Ok(network) => Some(AnimeMetadataService::new(network)),
            Err(error) => {
                log::warn!("初始化本地媒体在线元数据服务失败，继续使用本地匹配 error={error}");
                None
            }
        };
        let search_store = SharedReleaseSearchStore::new(Arc::clone(&self.storage));
        let mut online_searches = 0usize;
        let mut candidates = Vec::new();
        for (index, group) in groups.into_values().enumerate() {
            self.ensure_not_cancelled(&job_id)?;
            let local_matches = rank_anime_matches(&group.title_hint, &group.files, &catalog);
            let local_exact = local_matches.first().is_some_and(|match_| match_.0 >= 95);
            let mut alternatives = local_matches
                .into_iter()
                .map(|(_, anime)| anime)
                .take(5)
                .collect::<Vec<_>>();
            if !local_exact && online_searches < ONLINE_MATCH_LIMIT {
                if let Some(metadata) = metadata.as_ref() {
                    online_searches += 1;
                    let online = metadata.search(&search_store, &group.title_hint).await;
                    for error in &online.errors {
                        log::warn!(
                            "本地媒体在线元数据匹配部分失败 title_hint={} error={error}",
                            group.title_hint
                        );
                    }
                    alternatives = merge_alternatives(alternatives, online.items);
                }
            }
            let ranked_alternatives =
                rank_alternatives(&group.title_hint, &group.files, alternatives);
            let confidence = ranked_alternatives
                .first()
                .map(|(score, _)| *score)
                .unwrap_or(0);
            let alternatives = ranked_alternatives
                .iter()
                .map(|(_, anime)| anime.clone())
                .collect::<Vec<_>>();
            let suggested_anime_id = alternatives.first().map(|anime| anime.id.clone());
            let current_associations =
                collect_current_associations(&group.files, &existing_media_by_path, &catalog);
            let changes_existing_association = suggested_anime_id.as_deref().is_some_and(|id| {
                current_associations
                    .iter()
                    .any(|association| association.anime_id != id)
            });
            let conflicting_file_match = alternatives
                .first()
                .is_some_and(|anime| has_conflicting_file_match(&group.files, anime, &catalog));
            let unique_exact_match = is_unique_exact_match(&ranked_alternatives);
            let automatic_match = unique_exact_match
                && group.file_title_consensus >= 80
                && !changes_existing_association
                && !conflicting_file_match;
            if !automatic_match {
                let mut reasons = Vec::new();
                if !unique_exact_match {
                    reasons.push("候选不唯一");
                }
                if group.file_title_consensus < 80 {
                    reasons.push("文件标题一致率不足");
                }
                if changes_existing_association {
                    reasons.push("需要迁移现有关联");
                }
                if conflicting_file_match {
                    reasons.push("文件名命中其他番剧");
                }
                log::info!(
                    "Tauri 本地媒体候选需要确认 title_hint={} relative_directory={} confidence={} consensus={} suggested_anime_id={} reasons={}",
                    group.title_hint,
                    group.relative_directory,
                    confidence,
                    group.file_title_consensus,
                    suggested_anime_id.as_deref().unwrap_or("none"),
                    reasons.join(",")
                );
            }
            let summary = LocalMediaImportCandidate {
                id: group.id,
                title_hint: group.title_hint,
                relative_directory: group.relative_directory,
                file_count: group.files.len(),
                episode_numbers: group_episode_numbers(&group.files),
                confidence,
                file_title_consensus: group.file_title_consensus,
                suggested_anime_id,
                alternatives,
                current_associations,
            };
            candidates.push(PendingCandidate {
                summary,
                files: group.files,
                automatic_match,
            });
            self.update_local_media_status(|status| {
                status.processed_files = index + 1;
            });
        }

        let (automatic, review): (Vec<_>, Vec<_>) = candidates
            .into_iter()
            .partition(|candidate| candidate.automatic_match);
        let automatic = automatic
            .into_iter()
            .filter_map(|candidate| {
                let anime = candidate.summary.alternatives.first()?.clone();
                Some(ResolvedCandidate { candidate, anime })
            })
            .collect::<Vec<_>>();
        let mut imported = (0, 0);
        if !automatic.is_empty() {
            self.update_local_media_status(|status| {
                status.phase = LocalMediaImportPhase::Importing;
                status.total_files = automatic
                    .iter()
                    .map(|candidate| candidate.candidate.files.len())
                    .sum();
                status.processed_files = 0;
                status.message = Some("正在后台导入高置信度媒体".to_owned());
            });
            imported = self
                .import_resolved_candidates(&job_id, &source_root, automatic)
                .await?;
        }
        self.ensure_not_cancelled(&job_id)?;
        if review.is_empty() {
            self.complete_local_media_job(&job_id, imported.0, imported.1);
            return Ok(());
        }
        let summaries = review
            .iter()
            .map(|candidate| candidate.summary.clone())
            .collect::<Vec<_>>();
        let review_count = summaries.len();
        *self
            .local_import
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(PendingImport {
            job_id: job_id.clone(),
            source_root,
            candidates: review,
        });
        self.update_local_media_status(|status| {
            status.phase = LocalMediaImportPhase::AwaitingReview;
            status.imported_anime_count += imported.0;
            status.imported_media_count += imported.1;
            status.candidates = summaries;
            status.message = Some("部分番剧需要确认匹配结果".to_owned());
            status.completed_at = Some(now_iso());
        });
        log::info!(
            "Tauri 本地媒体扫描等待确认 job_id={} candidate_count={}",
            job_id,
            review_count
        );
        Ok(())
    }

    /// 探测并在一个工作单元中写入追番、单集和媒体索引。
    #[cfg(desktop)]
    async fn import_resolved_candidates(
        &self,
        job_id: &str,
        source_root: &Path,
        candidates: Vec<ResolvedCandidate>,
    ) -> Result<(usize, usize), String> {
        let mut prepared = Vec::new();
        let mut previous_anime_ids = HashSet::new();
        let total_files = candidates
            .iter()
            .map(|candidate| candidate.candidate.files.len())
            .sum::<usize>();
        let mut processed = 0usize;
        for resolved in candidates {
            let mut media_files = Vec::new();
            let mut anime = resolved.anime;
            append_local_title_alias(&mut anime, &resolved.candidate.summary.title_hint);
            let anime_id = anime.id.clone();
            previous_anime_ids.extend(
                resolved
                    .candidate
                    .summary
                    .current_associations
                    .iter()
                    .filter(|association| association.anime_id != anime_id)
                    .map(|association| association.anime_id.clone()),
            );
            for file in &resolved.candidate.files {
                self.ensure_not_cancelled(job_id)?;
                let episode_id = file
                    .episode_no
                    .map(|episode_no| create_episode_id(&anime_id, episode_no));
                let context = MediaProbeContext {
                    anime_id: Some(anime_id.clone()),
                    episode_id,
                    download_task_id: None,
                    declared_video_codec: file.parsed.declared_video_codec.clone(),
                    normalized_video_codec: None,
                    size: Some(file.size),
                    downloaded_at: file.modified_at.clone(),
                };
                let mut media = self.probe_local_file(&file.path, &context).await?;
                media.origin = MediaOrigin::Imported;
                media.source_root = Some(source_root.to_string_lossy().into_owned());
                media.fingerprint = Some(file.fingerprint.clone());
                media.file_modified_at = file.modified_at.clone();
                media.availability = MediaAvailability::Available;
                media.last_verified_at = Some(now_iso());
                media.availability_error = None;
                media_files.push(media);
                processed += 1;
                self.update_local_media_status(|status| {
                    status.total_files = total_files;
                    status.processed_files = processed;
                });
            }
            prepared.push((anime, resolved.candidate.files, media_files));
        }

        let mut storage = self
            .storage
            .lock()
            .map_err(|error| format!("写入本地媒体索引失败：{error}"))?;
        let work = storage
            .begin_unit_of_work()
            .map_err(|error| format!("创建本地媒体导入事务失败：{error}"))?;
        let (imported_anime_ids, imported_media_count) = {
            let repositories = work.repositories();
            let tracked = repositories
                .list_my_anime()
                .map_err(|error| error.to_string())?;
            let mut imported_anime_ids = HashSet::new();
            let mut imported_media_count = 0usize;
            for (anime, files, media_files) in prepared {
                let now = now_iso();
                let existing = tracked
                    .iter()
                    .find(|item| item.anime.id == anime.id)
                    .cloned();
                let (item, created) = merge_imported_my_anime(existing, anime.clone(), &now);
                if created {
                    imported_anime_ids.insert(anime.id.clone());
                }
                repositories
                    .upsert_my_anime(item)
                    .map_err(|error| error.to_string())?;
                let existing_episodes = repositories
                    .list_episodes(&anime.id)
                    .map_err(|error| error.to_string())?;
                for episode_no in group_episode_numbers(&files) {
                    let existing = existing_episodes
                        .iter()
                        .find(|episode| (episode.episode_no - episode_no).abs() < f64::EPSILON);
                    let episode = Episode {
                        id: existing
                            .map(|episode| episode.id.clone())
                            .unwrap_or_else(|| create_episode_id(&anime.id, episode_no)),
                        anime_id: anime.id.clone(),
                        episode_no,
                        title: existing.and_then(|episode| episode.title.clone()),
                        air_time: existing.and_then(|episode| episode.air_time.clone()),
                        status: existing
                            .filter(|episode| episode.status == EpisodeStatus::Watched)
                            .map(|episode| episode.status.clone())
                            .unwrap_or(EpisodeStatus::Downloaded),
                    };
                    repositories
                        .upsert_episode(&episode)
                        .map_err(|error| error.to_string())?;
                }
                imported_media_count += media_files.len();
                repositories
                    .upsert_media_files(&media_files)
                    .map_err(|error| error.to_string())?;
            }
            let cleaned_anime_ids = repositories
                .cleanup_orphaned_imported_anime(
                    &previous_anime_ids.iter().cloned().collect::<Vec<_>>(),
                )
                .map_err(|error| error.to_string())?;
            if !cleaned_anime_ids.is_empty() {
                log::info!(
                    "Tauri 本地媒体重绑已清理空番剧 anime_ids={}",
                    cleaned_anime_ids.join(",")
                );
            }
            (imported_anime_ids, imported_media_count)
        };
        work.commit()
            .map_err(|error| format!("提交本地媒体导入事务失败：{error}"))?;
        log::info!(
            "Tauri 本地媒体原地导入完成 anime_count={} media_count={} source_root={}",
            imported_anime_ids.len(),
            imported_media_count,
            source_root.display()
        );
        Ok((imported_anime_ids.len(), imported_media_count))
    }

    /// 校验媒体路径并批量持久化最新可用状态。
    async fn run_media_availability_check(&self, job_id: &str) -> Result<(), String> {
        let mut media_files = self.list_media_files()?;
        let unavailable_roots = media_files
            .iter()
            .filter_map(|media| media.source_root.as_deref())
            .filter(|root| !Path::new(root).exists())
            .map(str::to_owned)
            .collect::<HashSet<_>>();
        self.update_local_media_status(|status| {
            status.total_files = media_files.len();
            status.processed_files = 0;
        });
        for (index, media) in media_files.iter_mut().enumerate() {
            self.ensure_not_cancelled(job_id)?;
            let path = Path::new(&media.file_path);
            let root_unavailable = media
                .source_root
                .as_ref()
                .is_some_and(|root| unavailable_roots.contains(root));
            match tokio::fs::metadata(path).await {
                Ok(metadata) if metadata.is_file() => {
                    let size = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
                    let modified_at = metadata.modified().ok().map(system_time_iso);
                    media.availability = if size != media.size
                        || media
                            .file_modified_at
                            .as_ref()
                            .zip(modified_at.as_ref())
                            .is_some_and(|(old, current)| old != current)
                    {
                        MediaAvailability::Changed
                    } else {
                        MediaAvailability::Available
                    };
                    media.size = size;
                    media.file_modified_at = modified_at;
                    media.fingerprint = Some(create_file_fingerprint(path, &metadata));
                    media.availability_error = None;
                }
                Ok(_) => {
                    media.availability = MediaAvailability::Missing;
                    media.availability_error = Some("路径不再是普通文件".to_owned());
                }
                Err(error)
                    if root_unavailable || error.kind() == io::ErrorKind::PermissionDenied =>
                {
                    media.availability = MediaAvailability::Unavailable;
                    media.availability_error = Some(error.to_string());
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    media.availability = MediaAvailability::Missing;
                    media.availability_error = Some(error.to_string());
                }
                Err(error) => {
                    media.availability = MediaAvailability::Unavailable;
                    media.availability_error = Some(error.to_string());
                }
            }
            media.last_verified_at = Some(now_iso());
            self.update_local_media_status(|status| {
                status.processed_files = index + 1;
                match media.availability {
                    MediaAvailability::Available => status.available_files += 1,
                    MediaAvailability::Changed => status.changed_files += 1,
                    MediaAvailability::Missing => status.missing_files += 1,
                    MediaAvailability::Unavailable => status.unavailable_files += 1,
                }
            });
        }
        self.repository
            .upsert_media_files(&media_files)
            .map_err(|error| error.to_string())?;
        self.update_local_media_status(|status| {
            status.phase = LocalMediaImportPhase::Completed;
            status.completed_at = Some(now_iso());
            status.message = Some(format!("已校验 {} 个媒体文件", status.total_files));
        });
        let status = self.local_media_import_status();
        log::info!(
            "Tauri 媒体可用性校验完成 total={} available={} changed={} missing={} unavailable={}",
            status.total_files,
            status.available_files,
            status.changed_files,
            status.missing_files,
            status.unavailable_files
        );
        Ok(())
    }

    /// 抢占唯一后台任务执行权。
    fn reserve_local_media_job(&self) -> Result<(), String> {
        self.local_import
            .in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "本地媒体后台任务正在运行".to_owned())
    }

    /// 阻止其他任务覆盖仍待用户确认的扫描结果。
    fn ensure_no_pending_review(&self) -> Result<(), String> {
        let has_pending = self
            .local_import
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some();
        if has_pending {
            Err("请先确认或放弃当前本地媒体匹配结果".to_owned())
        } else {
            Ok(())
        }
    }

    /// 在每个可取消步骤前检查取消信号并发布终态。
    fn ensure_not_cancelled(&self, job_id: &str) -> Result<(), String> {
        if !self.local_import.cancel.load(Ordering::Acquire) {
            return Ok(());
        }
        self.update_local_media_status(|status| {
            if status.job_id.as_deref() == Some(job_id) {
                status.phase = LocalMediaImportPhase::Cancelled;
                status.completed_at = Some(now_iso());
                status.message = Some("后台任务已取消".to_owned());
            }
        });
        Err("后台任务已取消".to_owned())
    }

    /// 发布任务完成状态并保留累计导入数量。
    fn complete_local_media_job(&self, job_id: &str, anime_count: usize, media_count: usize) {
        self.update_local_media_status(|status| {
            if status.job_id.as_deref() != Some(job_id) {
                return;
            }
            status.phase = LocalMediaImportPhase::Completed;
            status.imported_anime_count += anime_count;
            status.imported_media_count += media_count;
            status.candidates.clear();
            status.completed_at = Some(now_iso());
            status.message = Some(format!(
                "导入完成：新增 {} 部番剧，登记 {} 个媒体文件",
                status.imported_anime_count, status.imported_media_count
            ));
        });
    }

    /// 发布后台任务失败状态；主动取消保持取消终态。
    fn fail_local_media_job(&self, job_id: &str, error: String) {
        if self.local_import.cancel.load(Ordering::Acquire) {
            self.update_local_media_status(|status| {
                if status.job_id.as_deref() == Some(job_id) {
                    status.phase = LocalMediaImportPhase::Cancelled;
                    status.completed_at = Some(now_iso());
                    status.message = Some("后台任务已取消".to_owned());
                    status.error = None;
                }
            });
            return;
        }
        log::error!("Tauri 本地媒体后台任务失败 job_id={job_id} error={error}");
        self.update_local_media_status(|status| {
            if status.job_id.as_deref() == Some(job_id) {
                status.phase = LocalMediaImportPhase::Failed;
                status.completed_at = Some(now_iso());
                status.message = Some("后台任务失败".to_owned());
                status.error = Some(error);
            }
        });
    }

    /// 替换完整状态并向 Renderer 发布快照。
    fn replace_local_media_status(&self, status: LocalMediaImportJobStatus) {
        *self
            .local_import
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = status.clone();
        self.emit_local_media_status(status);
    }

    /// 原子修改任务状态并向 Renderer 发布快照。
    fn update_local_media_status(
        &self,
        update: impl FnOnce(&mut LocalMediaImportJobStatus),
    ) -> LocalMediaImportJobStatus {
        let status = {
            let mut status = self
                .local_import
                .status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            update(&mut status);
            status.clone()
        };
        self.emit_local_media_status(status.clone());
        status
    }

    /// 尽力发布后台任务状态，事件失败不影响导入。
    fn emit_local_media_status(&self, status: LocalMediaImportJobStatus) {
        if let Err(error) = self.app.emit(LOCAL_MEDIA_STATUS_EVENT, status) {
            log::warn!("发布本地媒体任务状态失败 error={error}");
        }
    }

    /// 生成进程内唯一的后台任务标识。
    fn next_local_media_job_id(&self, prefix: &str) -> String {
        let sequence = self.local_import.sequence.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{}-{sequence}", Utc::now().timestamp_millis())
    }

    /// 读取目录匹配所需的番剧目录和追番快照。
    fn load_anime_match_context(&self) -> Result<(Vec<Anime>, Vec<MyAnime>), String> {
        let storage = self
            .storage
            .lock()
            .map_err(|error| format!("读取本地媒体匹配上下文失败：{error}"))?;
        Ok((
            storage
                .repository()
                .list_anime_catalog(None, None)
                .map_err(|error| error.to_string())?,
            storage
                .repository()
                .list_my_anime()
                .map_err(|error| error.to_string())?,
        ))
    }

    /// 删除当前扫描根目录下历史误导入的 macOS 元数据媒体记录。
    fn remove_ignored_imported_media(&self, source_root: &Path) -> Result<usize, String> {
        let media_file_ids = self
            .list_media_files()?
            .into_iter()
            .filter(|media| {
                media.origin == MediaOrigin::Imported
                    && media
                        .source_root
                        .as_deref()
                        .is_some_and(|root| Path::new(root) == source_root)
                    && is_macos_metadata_path(Path::new(&media.file_path))
            })
            .map(|media| media.id)
            .collect::<Vec<_>>();
        if media_file_ids.is_empty() {
            return Ok(0);
        }
        self.repository
            .remove_media_files(&media_file_ids)
            .map_err(|error| format!("清理 macOS 元数据媒体索引失败：{error}"))?;
        log::info!(
            "Tauri 本地媒体扫描已清理 macOS 元数据索引 source_root={} count={}",
            source_root.display(),
            media_file_ids.len()
        );
        Ok(media_file_ids.len())
    }
}

struct CandidateGroup {
    id: String,
    title_hint: String,
    relative_directory: String,
    files: Vec<ScannedFile>,
    consensus_scope: Option<String>,
    file_title_consensus: u8,
}

#[derive(Clone)]
struct InferredTitleContext {
    title_hint: String,
    identity_directory: PathBuf,
    requires_file_consensus: bool,
}

type ExactAnimeTitleIndex = HashMap<String, Option<String>>;

/// 递归枚举普通视频文件，跳过符号链接并限制扫描规模。
fn discover_video_files(
    root: &Path,
    extensions: &HashSet<String>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(usize),
) -> Result<Vec<ScannedFile>, String> {
    let mut directories = vec![(root.to_path_buf(), 0usize)];
    let mut files = Vec::new();
    let mut ignored_metadata_entries = 0usize;
    while let Some((directory, depth)) = directories.pop() {
        if cancel.load(Ordering::Acquire) {
            return Err("后台任务已取消".to_owned());
        }
        if depth > MAX_SCAN_DEPTH {
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                log::warn!(
                    "跳过不可读取的媒体目录 path={} error={error}",
                    directory.display()
                );
                continue;
            }
        };
        for entry in entries {
            if cancel.load(Ordering::Acquire) {
                return Err("后台任务已取消".to_owned());
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    log::warn!(
                        "读取媒体目录项失败 directory={} error={error}",
                        directory.display()
                    );
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    log::warn!("读取媒体文件属性失败 path={} error={error}", path.display());
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if is_macos_metadata_directory(&path) {
                    ignored_metadata_entries += 1;
                    continue;
                }
                directories.push((path, depth + 1));
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            if is_macos_metadata_path(&path) {
                ignored_metadata_entries += 1;
                continue;
            }
            if !is_video_path(&path, extensions) {
                continue;
            }
            if files.len() >= MAX_VIDEO_FILES {
                return Err(format!(
                    "扫描目录视频文件超过 {MAX_VIDEO_FILES} 个，请缩小目录范围"
                ));
            }
            let file_name = path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default();
            let parsed = parse_release_title(&file_name, &[]);
            let modified_at = metadata.modified().ok().map(system_time_iso);
            files.push(ScannedFile {
                episode_no: parsed.episode_no,
                parsed,
                size: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
                fingerprint: create_file_fingerprint(&path, &metadata),
                modified_at,
                path,
            });
            progress(files.len());
        }
    }
    if ignored_metadata_entries > 0 {
        log::info!(
            "Tauri 本地媒体扫描已忽略 macOS 元数据 source_root={} count={ignored_metadata_entries}",
            root.display()
        );
    }
    Ok(files)
}

/// 按推断番剧标题聚合扫描文件。
fn group_scanned_files(
    root: &Path,
    files: Vec<ScannedFile>,
    catalog: &[Anime],
) -> BTreeMap<String, CandidateGroup> {
    let mut groups = BTreeMap::new();
    let mut consensus_totals = HashMap::<String, usize>::new();
    let exact_title_index = build_exact_anime_title_index(catalog);
    for file in files {
        let inferred = infer_title_context(root, &file, &exact_title_index);
        let relative_directory = inferred
            .identity_directory
            .strip_prefix(root)
            .unwrap_or(&inferred.identity_directory)
            .to_string_lossy()
            .into_owned();
        let consensus_scope = inferred
            .requires_file_consensus
            .then(|| relative_directory.clone());
        if let Some(scope) = consensus_scope.as_ref() {
            *consensus_totals.entry(scope.clone()).or_default() += 1;
        }
        let normalized_title = normalize_release_search_text(&inferred.title_hint);
        let key = format!("{relative_directory}\0{normalized_title}");
        let group = groups.entry(key.clone()).or_insert_with(|| CandidateGroup {
            id: stable_id("local-candidate", &key),
            title_hint: inferred.title_hint,
            relative_directory,
            files: Vec::new(),
            consensus_scope,
            file_title_consensus: 100,
        });
        group.files.push(file);
    }
    for group in groups.values_mut() {
        let Some(scope) = group.consensus_scope.as_ref() else {
            continue;
        };
        let total = consensus_totals.get(scope).copied().unwrap_or_default();
        group.file_title_consensus = group
            .files
            .len()
            .saturating_mul(100)
            .checked_div(total)
            .and_then(|value| u8::try_from(value).ok())
            .unwrap_or(100);
    }
    groups
}

/// 从目录树中选择最近的有效番剧节点，并保留资源包目录作为回退。
fn infer_title_context(
    root: &Path,
    file: &ScannedFile,
    exact_title_index: &ExactAnimeTitleIndex,
) -> InferredTitleContext {
    let parent = file.path.parent().unwrap_or(root);
    let mut directory = parent;
    let mut season_scope = None::<(String, PathBuf)>;
    let mut release_fallback = None::<InferredTitleContext>;
    let mut directory_candidates = Vec::new();
    while directory != root {
        let directory_name = directory
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        if is_generic_season_directory(&directory_name) {
            season_scope = Some((directory_name, directory.to_path_buf()));
            directory = directory.parent().unwrap_or(directory);
            continue;
        }
        if is_generic_media_directory(&directory_name) {
            directory = directory.parent().unwrap_or(directory);
            continue;
        }
        if let Some(title) = clean_title_hint(&directory_name) {
            let context = InferredTitleContext {
                title_hint: append_season_scope(title, season_scope.as_ref()),
                identity_directory: season_scope
                    .as_ref()
                    .map(|(_, path)| path.clone())
                    .unwrap_or_else(|| directory.to_path_buf()),
                requires_file_consensus: is_release_package_directory(&directory_name),
            };
            if is_release_package_directory(&directory_name) {
                release_fallback.get_or_insert(context);
            } else {
                directory_candidates.push(context);
            }
        }
        directory = directory.parent().unwrap_or(directory);
    }
    let root_name = root
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !is_generic_media_directory(&root_name) {
        if let Some(title) = clean_title_hint(&root_name) {
            directory_candidates.push(InferredTitleContext {
                title_hint: append_season_scope(title, season_scope.as_ref()),
                identity_directory: season_scope
                    .as_ref()
                    .map(|(_, path)| path.clone())
                    .unwrap_or_else(|| root.to_path_buf()),
                requires_file_consensus: false,
            });
        }
    }
    if let Some(exact) = directory_candidates.iter().find(|candidate| {
        exact_title_index
            .get(&normalize_release_search_text(&candidate.title_hint))
            .is_some_and(Option::is_some)
    }) {
        return exact.clone();
    }
    directory_candidates
        .into_iter()
        .next()
        .or(release_fallback)
        .unwrap_or_else(|| InferredTitleContext {
            title_hint: infer_title_from_file(&file.path),
            identity_directory: parent.to_path_buf(),
            requires_file_consensus: true,
        })
}

/// 建立标题和别名到唯一番剧的索引，重名项标记为歧义。
fn build_exact_anime_title_index(catalog: &[Anime]) -> ExactAnimeTitleIndex {
    let mut index = ExactAnimeTitleIndex::new();
    for anime in catalog {
        for name in std::iter::once(anime.title.as_str())
            .chain(anime.original_title.as_deref())
            .chain(anime.aliases.iter().map(|alias| alias.alias.as_str()))
        {
            let normalized = normalize_release_search_text(name);
            if normalized.is_empty() {
                continue;
            }
            index
                .entry(normalized)
                .and_modify(|owner| {
                    if owner.as_deref() != Some(anime.id.as_str()) {
                        *owner = None;
                    }
                })
                .or_insert_with(|| Some(anime.id.clone()));
        }
    }
    index
}

/// 判断目录名是否只表示季度或季号。
fn is_generic_season_directory(value: &str) -> bool {
    let normalized = normalize_release_search_text(value);
    Regex::new(r"(?i)^(?:season\s*\d+|s\d+|第\s*\d+\s*季)$")
        .expect("season directory regex")
        .is_match(&normalized)
}

/// 判断目录名是否是缺少番剧语义的通用媒体根目录。
fn is_generic_media_directory(value: &str) -> bool {
    let normalized = normalize_release_search_text(value);
    matches!(
        normalized.as_str(),
        "anime"
            | "animes"
            | "media"
            | "video"
            | "videos"
            | "downloads"
            | "tv"
            | "series"
            | "complete"
            | "completed"
            | "动画"
            | "番剧"
            | "合集"
            | "新番"
    ) || Regex::new(r"(?i)^(?:(?:19|20)?\d{2}[._-]?(?:0[1-9]|1[0-2])|(?:19|20)\d{2})$")
        .expect("media category regex")
        .is_match(value.trim())
}

/// 从发布文件名移除字幕组、集数和技术标签得到标题提示。
fn infer_title_from_file(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "未命名番剧".to_owned());
    clean_title_hint(&stem).unwrap_or_else(|| "未命名番剧".to_owned())
}

/// 清理目录或文件标题中的分区日期、字幕组、集数和技术标签。
fn clean_title_hint(value: &str) -> Option<String> {
    let value =
        Regex::new(r"(?i)^\s*(?:(?:19|20)\d{2}[._-](?:0?[1-9]|1[0-2])|\d{2}(?:0[1-9]|1[0-2]))\s+")
            .expect("dated title prefix regex")
            .replace(value, "");
    let without_group = Regex::new(r"^(?:\s*[\[【][^\]】]+[\]】])+\s*")
        .expect("fansub prefix regex")
        .replace(&value, "");
    let episode = Regex::new(
        r"(?i)(?:[\s._-]+-?[\s._-]*\d{1,3}(?:\.\d)?|[\s._-]+s\d{1,2}e\d{1,3}|[\s._-]+ep(?:isode)?[\s._-]*\d{1,3}|[\s._-]+第\s*\d{1,3}\s*[话話集])",
    )
    .expect("episode title regex");
    let title = episode
        .find(&without_group)
        .map(|match_| &without_group[..match_.start()])
        .unwrap_or(&without_group);
    let title = Regex::new(r"[\[【].*$")
        .expect("technical suffix regex")
        .replace(title, "");
    let title = title.replace(['_', '.'], " ");
    let title = title
        .trim_matches(|character: char| {
            character.is_whitespace()
                || matches!(character, '-' | '–' | '—' | '(' | ')' | '（' | '）')
        })
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty() && !is_technical_only_title(&title)).then_some(title)
}

/// 判断目录是否主要由资源范围、分辨率、编码或字幕标签组成。
fn is_release_package_directory(value: &str) -> bool {
    let bracket_count = value.matches(['[', '【']).count();
    let has_release_marker = Regex::new(
        r"(?i)(?:\b(?:web-?dl|webrip|bdrip|bluray|hevc|x26[45]|av1|aac|flac|1080p|2160p|720p)\b|[\[【(（]\s*\d{1,3}\s*[-~]\s*\d{1,3}|简繁|字幕|合集)",
    )
    .expect("release package marker regex")
    .is_match(value);
    bracket_count >= 2 || has_release_marker
}

/// 判断清理后的标题是否仍然只有技术词和数字。
fn is_technical_only_title(value: &str) -> bool {
    let without_technical = Regex::new(
        r"(?i)\b(?:web-?dl|webrip|bdrip|bluray|hevc|h26[45]|x26[45]|av1|aac|flac|srt|ass|1080p|2160p|720p|chs|cht|jpn|fin|10bit)\b",
    )
    .expect("technical-only title regex")
    .replace_all(value, " ");
    let without_ranges = Regex::new(r"\d{1,3}\s*[-~]\s*\d{1,3}|\d+")
        .expect("technical range regex")
        .replace_all(&without_technical, " ");
    let meaningful = without_ranges
        .chars()
        .filter(|character| {
            character.is_alphanumeric() || ('\u{3400}'..='\u{9fff}').contains(character)
        })
        .collect::<String>();
    meaningful.is_empty()
}

/// 将季度目录信息附加到父番剧标题，已有相同季号时不重复添加。
fn append_season_scope(title: String, season_scope: Option<&(String, PathBuf)>) -> String {
    let Some((season, _)) = season_scope else {
        return title;
    };
    let season_number = Regex::new(r"\d+")
        .expect("season number regex")
        .find(season)
        .map(|value| value.as_str());
    let title_season_number = Regex::new(r"(?i)(?:season\s*|s|第\s*)(\d+)\s*季?")
        .expect("title season number regex")
        .captures(&title)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str());
    if season_number.is_some() && season_number == title_season_number {
        title
    } else {
        format!("{title} {season}")
    }
}

/// 对番剧目录候选按标题精确度排序。
fn rank_anime_matches(
    title_hint: &str,
    files: &[ScannedFile],
    catalog: &[Anime],
) -> Vec<(u8, Anime)> {
    let mut matches = catalog
        .iter()
        .filter_map(|anime| {
            let score = anime_match_score(title_hint, files, anime);
            (score > 0).then(|| (score, anime.clone()))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.title.cmp(&right.1.title))
    });
    matches
}

/// 对本地与在线候选重新计算分数并稳定排序。
fn rank_alternatives(
    title_hint: &str,
    files: &[ScannedFile],
    alternatives: Vec<Anime>,
) -> Vec<(u8, Anime)> {
    let mut ranked = alternatives
        .into_iter()
        .map(|anime| (anime_match_score(title_hint, files, &anime), anime))
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.title.cmp(&right.1.title))
    });
    ranked.truncate(5);
    ranked
}

/// 判断第一候选是否精确命中且至少领先第二候选二十分。
fn is_unique_exact_match(ranked: &[(u8, Anime)]) -> bool {
    let Some((first_score, _)) = ranked.first() else {
        return false;
    };
    *first_score >= 95
        && ranked
            .get(1)
            .is_none_or(|(second_score, _)| first_score.saturating_sub(*second_score) >= 20)
}

/// 检查单个文件名是否唯一精确指向与目录候选不同的番剧。
fn has_conflicting_file_match(files: &[ScannedFile], suggested: &Anime, catalog: &[Anime]) -> bool {
    files.iter().any(|file| {
        let file_hint = infer_title_from_file(&file.path);
        let ranked = rank_anime_matches(&file_hint, std::slice::from_ref(file), catalog);
        is_unique_exact_match(&ranked)
            && ranked
                .first()
                .is_some_and(|(_, anime)| anime.id != suggested.id)
    })
}

/// 汇总候选文件在扫描前已经存在的番剧关联。
fn collect_current_associations(
    files: &[ScannedFile],
    existing_media_by_path: &HashMap<String, MediaFile>,
    catalog: &[Anime],
) -> Vec<LocalMediaImportAssociation> {
    let mut counts = HashMap::<String, usize>::new();
    for file in files {
        let path = file.path.to_string_lossy();
        if let Some(media) = existing_media_by_path.get(path.as_ref()) {
            *counts.entry(media.anime_id.clone()).or_default() += 1;
        }
    }
    let mut associations = counts
        .into_iter()
        .map(|(anime_id, file_count)| LocalMediaImportAssociation {
            anime_title: catalog
                .iter()
                .find(|anime| anime.id == anime_id)
                .map(|anime| anime.title.clone())
                .unwrap_or_else(|| anime_id.clone()),
            anime_id,
            file_count,
        })
        .collect::<Vec<_>>();
    associations.sort_by(|left, right| {
        right
            .file_count
            .cmp(&left.file_count)
            .then_with(|| left.anime_title.cmp(&right.anime_title))
    });
    associations
}

/// 计算目录提示和文件名对单部番剧的匹配置信度。
fn anime_match_score(title_hint: &str, files: &[ScannedFile], anime: &Anime) -> u8 {
    let normalized_hint = normalize_release_search_text(title_hint);
    let names = std::iter::once(anime.title.as_str())
        .chain(anime.original_title.as_deref())
        .chain(anime.aliases.iter().map(|alias| alias.alias.as_str()))
        .collect::<Vec<_>>();
    if names
        .iter()
        .any(|name| normalize_release_search_text(name) == normalized_hint)
    {
        return 100;
    }
    let terms = build_anime_release_search_terms(anime, &[], 12);
    if matches_anime_release_title(title_hint, &terms) {
        return 88;
    }
    if files.iter().any(|file| {
        file.path
            .file_name()
            .is_some_and(|name| matches_anime_release_title(&name.to_string_lossy(), &terms))
    }) {
        return 82;
    }
    0
}

/// 合并本地和在线元数据候选并按稳定 ID 去重。
fn merge_alternatives(local: Vec<Anime>, online: Vec<Anime>) -> Vec<Anime> {
    let mut seen = HashSet::new();
    local
        .into_iter()
        .chain(online)
        .filter(|anime| seen.insert(anime.id.clone()))
        .collect()
}

/// 解析用户对低置信度候选的确认结果。
fn resolve_review_selections(
    candidates: &[PendingCandidate],
    selections: &[LocalMediaImportSelection],
) -> Result<Vec<ResolvedCandidate>, String> {
    let selections = selections
        .iter()
        .map(|selection| (selection.candidate_id.as_str(), selection))
        .collect::<HashMap<_, _>>();
    let mut resolved = Vec::new();
    for candidate in candidates {
        let Some(selection) = selections.get(candidate.summary.id.as_str()) else {
            continue;
        };
        let anime = if selection.create_local {
            create_local_anime(&candidate.summary.title_hint)
        } else {
            let anime_id = selection
                .anime_id
                .as_deref()
                .or(candidate.summary.suggested_anime_id.as_deref())
                .ok_or_else(|| format!("{} 尚未选择匹配番剧", candidate.summary.title_hint))?;
            candidate
                .summary
                .alternatives
                .iter()
                .find(|anime| anime.id == anime_id)
                .cloned()
                .ok_or_else(|| format!("{} 的匹配结果已经失效", candidate.summary.title_hint))?
        };
        resolved.push(ResolvedCandidate {
            candidate: candidate.clone(),
            anime,
        });
    }
    if resolved.is_empty() {
        return Err("至少选择一组本地媒体".to_owned());
    }
    Ok(resolved)
}

/// 为没有在线匹配的目录创建可后续补全的本地番剧记录。
fn create_local_anime(title: &str) -> Anime {
    let now = Utc::now();
    Anime {
        id: stable_id("local-anime", &normalize_release_search_text(title)),
        title: title.trim().to_owned(),
        original_title: None,
        aliases: Vec::new(),
        premiere_date: None,
        premiere_year: i64::from(now.year()),
        premiere_month: i64::from(now.month()),
        season: None,
        summary: None,
        cover_url: None,
        rating: None,
        external_ids: serde_json::json!({ "localImport": true }),
        detail: None,
    }
}

/// 创建扫描导入的新追番，默认想看且关闭自动下载。
fn create_imported_my_anime(anime: Anime, now: &str) -> MyAnime {
    MyAnime {
        id: stable_id("my-anime", &anime.id),
        anime,
        status: AnimeStatus::Planned,
        default_fansub_group_id: None,
        auto_download: false,
        download_dir: None,
        rss_subscriptions: Vec::new(),
        preferred_resolution: Some("1080p".to_owned()),
        preferred_codec: Some("H.265/HEVC".to_owned()),
        preferred_bit_depth: Some(10),
        preferred_subtitle_languages: vec!["chs".to_owned()],
        preferred_subtitle: None,
        added_at: now.to_owned(),
        updated_at: now.to_owned(),
    }
}

/// 合并已存在追番的元数据，同时保留全部用户追番设置。
fn merge_imported_my_anime(existing: Option<MyAnime>, anime: Anime, now: &str) -> (MyAnime, bool) {
    let Some(mut existing) = existing else {
        return (create_imported_my_anime(anime, now), true);
    };
    existing.anime = merge_anime_metadata_batches(&[
        AnimeMetadataBatch {
            source: "existing".to_owned(),
            items: vec![existing.anime.clone()],
        },
        AnimeMetadataBatch {
            source: "local-import".to_owned(),
            items: vec![anime],
        },
    ])
    .into_iter()
    .next()
    .unwrap_or_else(|| existing.anime.clone());
    (existing, false)
}

/// 将有辨识度的扫描目录名补充为本地番剧别名。
fn append_local_title_alias(anime: &mut Anime, title_hint: &str) {
    let alias = title_hint.trim();
    let normalized = normalize_release_search_text(alias);
    let already_known = std::iter::once(anime.title.as_str())
        .chain(anime.original_title.as_deref())
        .chain(anime.aliases.iter().map(|item| item.alias.as_str()))
        .any(|name| normalize_release_search_text(name) == normalized);
    if alias.is_empty() || normalized.is_empty() || already_known {
        return;
    }
    anime.aliases.push(AnimeAlias {
        id: stable_id("local-alias", &format!("{}:{normalized}", anime.id)),
        anime_id: anime.id.clone(),
        alias: alias.to_owned(),
        language: AnimeAliasLanguage::Custom,
        priority: 70,
    });
}

/// 返回候选中已识别集数的有序去重列表。
fn group_episode_numbers(files: &[ScannedFile]) -> Vec<f64> {
    let mut numbers = files
        .iter()
        .filter_map(|file| file.episode_no)
        .collect::<Vec<_>>();
    numbers.sort_by(f64::total_cmp);
    numbers.dedup_by(|left, right| (*left - *right).abs() < f64::EPSILON);
    numbers
}

/// 从设置读取规范化视频扩展名。
fn media_extensions(settings: &serde_json::Value) -> HashSet<String> {
    settings
        .pointer("/media/videoExtensions")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(normalize_extension)
                .collect()
        })
        .filter(|extensions: &HashSet<_>| !extensions.is_empty())
        .unwrap_or_else(|| {
            [".mkv", ".mp4", ".avi"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        })
}

/// 规范化媒体扩展名为带点小写形式。
fn normalize_extension(value: &str) -> String {
    let value = value.trim().to_lowercase();
    if value.starts_with('.') {
        value
    } else {
        format!(".{value}")
    }
}

/// 判断路径扩展名是否属于允许扫描的视频格式。
fn is_video_path(path: &Path, extensions: &HashSet<String>) -> bool {
    path.extension()
        .map(|value| format!(".{}", value.to_string_lossy().to_lowercase()))
        .is_some_and(|extension| extensions.contains(&extension))
}

/// 判断目录是否为 macOS 归档生成的元数据目录。
fn is_macos_metadata_directory(path: &Path) -> bool {
    path.file_name()
        .map(|value| value.to_string_lossy().eq_ignore_ascii_case("__MACOSX"))
        .unwrap_or(false)
}

/// 判断路径是否为 AppleDouble、Finder 或归档元数据，而非真实媒体。
fn is_macos_metadata_path(path: &Path) -> bool {
    let in_metadata_directory = path.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("__MACOSX")
    });
    let metadata_file = path
        .file_name()
        .map(|value| {
            let value = value.to_string_lossy();
            value.starts_with("._") || value.eq_ignore_ascii_case(".DS_Store")
        })
        .unwrap_or(false);
    in_metadata_directory || metadata_file
}

/// 使用文件大小和修改时间生成快速幂等指纹。
fn create_file_fingerprint(path: &Path, metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    stable_id(
        "media-fingerprint",
        &format!("{}:{modified}:{}", metadata.len(), path.to_string_lossy()),
    )
}

/// 生成无需随机依赖的稳定本地标识。
fn stable_id(prefix: &str, value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{prefix}-{:016x}", hasher.finish())
}

/// 为导入文件的匹配集数生成稳定单集标识。
fn create_episode_id(anime_id: &str, episode_no: f64) -> String {
    stable_id("local-episode", &format!("{anime_id}:{episode_no:.3}"))
}

/// 将系统时间转换为统一 UTC 字符串。
fn system_time_iso(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// 返回当前统一 UTC 字符串。
fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 创建只用于目录推断测试的扫描文件。
    fn scanned_file(path: &str) -> ScannedFile {
        let path = PathBuf::from(path);
        let file_name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let parsed = parse_release_title(&file_name, &[]);
        ScannedFile {
            episode_no: parsed.episode_no,
            parsed,
            size: 1024,
            modified_at: None,
            fingerprint: stable_id("test-media", path.to_string_lossy().as_ref()),
            path,
        }
    }

    /// 验证发布文件名可以清理为番剧标题提示。
    #[test]
    fn infers_title_from_release_file_name() {
        assert_eq!(
            infer_title_from_file(Path::new("[LoliHouse] Test Anime - 03 [WebRip 1080p].mkv")),
            "Test Anime"
        );
    }

    /// 验证资源包子目录继承最近的有效番剧父节点。
    #[test]
    fn inherits_anime_title_above_release_package_directory() {
        let root = Path::new("/library/2510");
        let file = scanned_file(
            "/library/2510/无限扭蛋/[LoliHouse][01-12][1080P][简繁内封字幕]/[LoliHouse] Mugen Gacha - 01 [1080p].mkv",
        );

        let inferred = infer_title_context(root, &file, &ExactAnimeTitleIndex::new());

        assert_eq!(inferred.title_hint, "无限扭蛋");
        assert_eq!(inferred.identity_directory, root.join("无限扭蛋"));
    }

    /// 验证季度节点附加季号并作为独立分组范围。
    #[test]
    fn combines_season_node_with_parent_anime_title() {
        let root = Path::new("/library");
        let file = scanned_file("/library/Wistoria/Season 2/[Group][1080P]/Wistoria.S02E01.mkv");

        let inferred = infer_title_context(root, &file, &ExactAnimeTitleIndex::new());

        assert_eq!(inferred.title_hint, "Wistoria Season 2");
        assert_eq!(
            inferred.identity_directory,
            root.join("Wistoria").join("Season 2")
        );
    }

    /// 验证子目录无匹配时继承唯一识别成功的番剧父节点。
    #[test]
    fn inherits_exact_parent_when_child_directory_is_unmatched() {
        let root = Path::new("/library");
        let file = scanned_file("/library/Known Show/Extras/Known.Show - 01.mkv");
        let catalog = vec![create_local_anime("Known Show")];
        let exact_title_index = build_exact_anime_title_index(&catalog);

        let inferred = infer_title_context(root, &file, &exact_title_index);

        assert_eq!(inferred.title_hint, "Known Show");
        assert_eq!(inferred.identity_directory, root.join("Known Show"));
    }

    /// 验证子目录唯一命中另一番剧时覆盖父节点并形成独立候选。
    #[test]
    fn selects_exact_child_when_it_identifies_another_anime() {
        let root = Path::new("/library");
        let file = scanned_file("/library/Known Show/Spin Off/Spin.Off - 01.mkv");
        let catalog = vec![
            create_local_anime("Known Show"),
            create_local_anime("Spin Off"),
        ];
        let exact_title_index = build_exact_anime_title_index(&catalog);

        let inferred = infer_title_context(root, &file, &exact_title_index);

        assert_eq!(inferred.title_hint, "Spin Off");
        assert_eq!(
            inferred.identity_directory,
            root.join("Known Show").join("Spin Off")
        );
    }

    /// 验证同名目录位于不同树分支时不会合并为同一候选。
    #[test]
    fn keeps_same_named_directories_in_separate_tree_branches() {
        let root = Path::new("/library");
        let groups = group_scanned_files(
            root,
            vec![
                scanned_file("/library/A/Same/[Group][1080P]/AnimeA - 01.mkv"),
                scanned_file("/library/B/Same/[Group][1080P]/AnimeB - 01.mkv"),
            ],
            &[],
        );

        assert_eq!(groups.len(), 2);
        assert!(groups.values().all(|group| group.title_hint == "Same"));
    }

    /// 验证无番剧父节点时按同目录文件标题计算一致率。
    #[test]
    fn calculates_file_title_consensus_for_generic_root() {
        let root = Path::new("/library/downloads");
        let groups = group_scanned_files(
            root,
            vec![
                scanned_file("/library/downloads/Anime A - 01.mkv"),
                scanned_file("/library/downloads/Anime A - 02.mkv"),
                scanned_file("/library/downloads/Anime A - 03.mkv"),
                scanned_file("/library/downloads/Anime A - 04.mkv"),
                scanned_file("/library/downloads/Anime B - 01.mkv"),
            ],
            &[],
        );

        let consensus = groups
            .values()
            .map(|group| (group.title_hint.as_str(), group.file_title_consensus))
            .collect::<HashMap<_, _>>();
        assert_eq!(consensus.get("Anime A"), Some(&80));
        assert_eq!(consensus.get("Anime B"), Some(&20));
    }

    /// 验证带字幕组和技术后缀的根级资源包仍能提取番剧标题。
    #[test]
    fn cleans_release_package_title_when_no_parent_anime_exists() {
        assert_eq!(
            clean_title_hint(
                "[LoliHouse] 气绝勇者与暗杀公主 [01-12 合集][WebRip 1080p][简繁内封字幕]"
            )
            .as_deref(),
            Some("气绝勇者与暗杀公主")
        );
    }

    /// 验证新导入追番默认关闭自动下载。
    #[test]
    fn imported_anime_defaults_to_planned_without_auto_download() {
        let item = create_imported_my_anime(create_local_anime("测试番"), "2026-08-02T00:00:00Z");
        assert_eq!(item.status, AnimeStatus::Planned);
        assert!(!item.auto_download);
    }

    /// 验证导入匹配已有追番时只补元数据，不覆盖用户追番设置。
    #[test]
    fn existing_tracking_preferences_survive_metadata_merge() {
        let mut existing =
            create_imported_my_anime(create_local_anime("测试番"), "2026-08-02T00:00:00Z");
        existing.status = AnimeStatus::Watching;
        existing.auto_download = true;
        existing.download_dir = Some("/media/custom".to_owned());
        let mut incoming = existing.anime.clone();
        incoming.original_title = Some("Test Anime".to_owned());
        incoming.summary = Some("补全简介".to_owned());

        let (merged, created) =
            merge_imported_my_anime(Some(existing), incoming, "2026-08-02T01:00:00Z");

        assert!(!created);
        assert_eq!(merged.status, AnimeStatus::Watching);
        assert!(merged.auto_download);
        assert_eq!(merged.download_dir.as_deref(), Some("/media/custom"));
        assert!(
            merged.anime.original_title.as_deref() == Some("Test Anime")
                || merged
                    .anime
                    .aliases
                    .iter()
                    .any(|alias| alias.alias == "Test Anime")
        );
        assert_eq!(merged.anime.summary.as_deref(), Some("补全简介"));
    }

    /// 验证目录标题会补充为别名，重复名称不会反复写入。
    #[test]
    fn local_directory_title_enriches_anime_aliases_once() {
        let mut anime = create_local_anime("测试番");

        append_local_title_alias(&mut anime, "Test Anime");
        append_local_title_alias(&mut anime, "test anime");

        assert_eq!(anime.aliases.len(), 1);
        assert_eq!(anime.aliases[0].alias, "Test Anime");
        assert_eq!(anime.aliases[0].language, AnimeAliasLanguage::Custom);
    }

    /// 验证扫描只排除 macOS 元数据，不误伤普通隐藏视频。
    #[test]
    fn identifies_macos_metadata_without_ignoring_hidden_videos() {
        let extensions = [".mkv".to_owned()].into_iter().collect();

        assert!(is_macos_metadata_path(Path::new("._episode.mkv")));
        assert!(is_macos_metadata_path(Path::new(
            "__MACOSX/show/episode.mkv"
        )));
        assert!(is_macos_metadata_directory(Path::new("__MACOSX")));
        assert!(!is_macos_metadata_path(Path::new(".episode.mkv")));
        assert!(is_video_path(Path::new(".episode.mkv"), &extensions));
    }
}
