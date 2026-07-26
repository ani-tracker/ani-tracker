import { useCallback, useEffect, useRef, useState } from "react";
import { appApi } from "@/lib/api";
import type { PlayerSnapshot } from "@shared/player-contract";
import type { RemotePlaylistItem } from "@/features/player/playback-list-model";

const CHECKPOINT_INTERVAL_MS = 10_000;
const AUTO_NEXT_COUNTDOWN_SECONDS = 5;

interface UsePlaybackBusinessOptions {
  activeItem: RemotePlaylistItem | null;
  nextItem?: RemotePlaylistItem;
  onSelectItem: (item: RemotePlaylistItem) => void;
  snapshot?: PlayerSnapshot;
}

interface PlaybackBusinessControls {
  autoNextSeconds?: number;
  cancelAutoNext: () => void;
  closeAfterFlush: (close: () => void) => void;
  flushCheckpoint: (reason: string) => void;
  selectItemAfterFlush: (item: RemotePlaylistItem) => void;
}

/** 统一网页与桌面播放器的续播保存、90% 上报和自动下一集时序。 */
export function usePlaybackBusiness({
  activeItem,
  nextItem,
  onSelectItem,
  snapshot
}: UsePlaybackBusinessOptions): PlaybackBusinessControls {
  const latestRef = useRef({ activeItem, snapshot });
  const onSelectItemRef = useRef(onSelectItem);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastSavedSignatureRef = useRef<string>();
  const watchedThresholdKeyRef = useRef<string>();
  const autoNextTimerRef = useRef<number>();
  const cancelledAutoNextKeyRef = useRef<string>();
  const [autoNextSeconds, setAutoNextSeconds] = useState<number>();
  latestRef.current = { activeItem, snapshot };
  onSelectItemRef.current = onSelectItem;

  /** 将最新有效快照串行写入，避免慢网络下旧位置覆盖新位置。 */
  const flushCheckpoint = useCallback((reason: string): void => {
    const current = latestRef.current;
    const item = current.activeItem;
    const currentSnapshot = current.snapshot;
    if (
      !item
      || !currentSnapshot
      || currentSnapshot.durationSeconds <= 0
      || !isSnapshotForItem(currentSnapshot, item)
    ) return;
    const signature = [
      item.task.id,
      item.fileIndex ?? "default",
      Math.floor(currentSnapshot.positionSeconds),
      currentSnapshot.status
    ].join(":");
    if (lastSavedSignatureRef.current === signature && reason === "interval") return;
    lastSavedSignatureRef.current = signature;

    saveChainRef.current = saveChainRef.current
      .catch(() => undefined)
      .then(() => appApi.savePlaybackCheckpoint({
        taskId: item.task.id,
        fileIndex: item.fileIndex,
        positionSeconds: currentSnapshot.positionSeconds,
        durationSeconds: currentSnapshot.durationSeconds,
        completed: currentSnapshot.status === "ended"
      }))
      .then((checkpoint) => {
        if (reason !== "interval") {
          console.info("[player] 播放续播位置已刷新", {
            taskId: checkpoint.taskId,
            fileIndex: checkpoint.fileIndex,
            reason,
            completed: checkpoint.completed
          });
        }
      })
      .catch((caught) => {
        console.warn("[player] 播放续播位置刷新失败", {
          taskId: item.task.id,
          fileIndex: item.fileIndex,
          reason,
          error: caught
        });
      });
  }, []);

  /** 清理当前自动切集计时并保留结束画面。 */
  const cancelAutoNext = useCallback((): void => {
    window.clearInterval(autoNextTimerRef.current);
    cancelledAutoNextKeyRef.current = playbackItemKey(latestRef.current.activeItem);
    setAutoNextSeconds(undefined);
    console.info("[player] 用户已取消自动下一集", {
      taskId: latestRef.current.activeItem?.task.id,
      fileIndex: latestRef.current.activeItem?.fileIndex
    });
  }, []);

  /** 切集前立即提交当前快照，再交给原有播放列表逻辑换源。 */
  const selectItemAfterFlush = useCallback((item: RemotePlaylistItem): void => {
    window.clearInterval(autoNextTimerRef.current);
    setAutoNextSeconds(undefined);
    flushCheckpoint("switch-item");
    onSelectItemRef.current(item);
  }, [flushCheckpoint]);

  /** 关闭页面前发起最后一次保存，不阻塞窗口回收。 */
  const closeAfterFlush = useCallback((close: () => void): void => {
    window.clearInterval(autoNextTimerRef.current);
    flushCheckpoint("close");
    close();
  }, [flushCheckpoint]);

  useEffect(() => {
    const timer = window.setInterval(() => flushCheckpoint("interval"), CHECKPOINT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [flushCheckpoint]);

  useEffect(() => {
    if (snapshot?.status === "paused") flushCheckpoint("pause");
    if (snapshot?.status === "ended") flushCheckpoint("ended");
  }, [flushCheckpoint, snapshot?.status]);

  useEffect(() => {
    const activeKey = playbackItemKey(activeItem);
    if (
      !activeKey
      || !activeItem
      || !snapshot
      || snapshot.durationSeconds <= 0
      || !isSnapshotForItem(snapshot, activeItem)
    ) return;
    const percent = snapshot.positionSeconds / snapshot.durationSeconds * 100;
    if (percent < 90 || watchedThresholdKeyRef.current === activeKey) return;
    watchedThresholdKeyRef.current = activeKey;
    flushCheckpoint("watched-threshold");
  }, [activeItem, flushCheckpoint, snapshot]);

  useEffect(() => {
    const handleVisibility = (): void => {
      if (document.visibilityState === "hidden") flushCheckpoint("hidden");
    };
    const handlePageHide = (): void => flushCheckpoint("page-hide");
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      flushCheckpoint("unmount");
    };
  }, [flushCheckpoint]);

  useEffect(() => {
    window.clearInterval(autoNextTimerRef.current);
    setAutoNextSeconds(undefined);
    const activeKey = playbackItemKey(activeItem);
    if (
      snapshot?.status !== "ended"
      || !activeItem
      || !nextItem
      || !isSnapshotForItem(snapshot, activeItem)
    ) return;
    if (cancelledAutoNextKeyRef.current === activeKey) return;

    let remaining = AUTO_NEXT_COUNTDOWN_SECONDS;
    setAutoNextSeconds(remaining);
    autoNextTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setAutoNextSeconds(remaining);
        return;
      }
      window.clearInterval(autoNextTimerRef.current);
      setAutoNextSeconds(undefined);
      flushCheckpoint("auto-next");
      console.info("[player] 自动切换下一集", {
        taskId: nextItem.task.id,
        fileIndex: nextItem.fileIndex
      });
      onSelectItemRef.current(nextItem);
    }, 1_000);
    return () => window.clearInterval(autoNextTimerRef.current);
  }, [activeItem, flushCheckpoint, nextItem, snapshot?.status]);

  useEffect(() => {
    cancelledAutoNextKeyRef.current = undefined;
  }, [activeItem?.id]);

  return {
    autoNextSeconds,
    cancelAutoNext,
    closeAfterFlush,
    flushCheckpoint,
    selectItemAfterFlush
  };
}

/** 生成仅用于当前播放器生命周期的稳定任务文件键。 */
function playbackItemKey(item: RemotePlaylistItem | null): string | undefined {
  return item ? `${item.task.id}:${item.fileIndex ?? "default"}` : undefined;
}

/** 确认快照仍属于当前播放项，避免切集渲染期间把旧进度写到新任务。 */
function isSnapshotForItem(snapshot: PlayerSnapshot, item: RemotePlaylistItem): boolean {
  return snapshot.source?.taskId === item.task.id
    && (item.fileIndex === undefined || snapshot.source.fileIndex === item.fileIndex);
}
