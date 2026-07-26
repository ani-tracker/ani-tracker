use std::collections::HashMap;
use std::sync::Arc;

use ani_domain::TorrentEngineKind;

use crate::{DownloadEngine, DownloadEngineError, DownloadServiceError};

/// 按稳定引擎类型路由新旧下载任务的运行时注册表。
#[derive(Default)]
pub struct DownloadEngineRegistry {
    engines: HashMap<TorrentEngineKind, Arc<dyn DownloadEngine>>,
}

impl DownloadEngineRegistry {
    /// 创建空注册表，由平台启动流程显式安装可用引擎。
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个引擎，同一类型重复注册视为启动配置错误。
    pub fn register(
        &mut self,
        engine: Arc<dyn DownloadEngine>,
    ) -> Result<(), DownloadServiceError> {
        let kind = engine.kind();
        if self.engines.contains_key(&kind) {
            return Err(DownloadServiceError::DuplicateEngine(kind));
        }
        self.engines.insert(kind, engine);
        Ok(())
    }

    /// 读取指定引擎；任务控制必须按创建时记录的类型路由。
    pub fn require(
        &self,
        kind: &TorrentEngineKind,
    ) -> Result<Arc<dyn DownloadEngine>, DownloadServiceError> {
        self.engines
            .get(kind)
            .cloned()
            .ok_or_else(|| DownloadServiceError::EngineNotRegistered(kind.clone()))
    }

    /// 返回已注册引擎类型的稳定快照。
    pub fn kinds(&self) -> Vec<TorrentEngineKind> {
        let mut kinds = self.engines.keys().cloned().collect::<Vec<_>>();
        kinds.sort_by_key(|kind| match kind {
            TorrentEngineKind::Embedded => 0,
            TorrentEngineKind::Qbittorrent => 1,
        });
        kinds
    }

    /// 依次优雅关闭全部引擎，单个失败不会跳过后续引擎。
    pub async fn shutdown_all(&self) -> Vec<(TorrentEngineKind, DownloadEngineError)> {
        let mut failures = Vec::new();
        for kind in self.kinds() {
            let Some(engine) = self.engines.get(&kind) else {
                continue;
            };
            if let Err(error) = engine.shutdown().await {
                log::warn!("下载引擎关闭失败：engine={kind:?}, error={error}");
                failures.push((kind, error));
            }
        }
        failures
    }
}
