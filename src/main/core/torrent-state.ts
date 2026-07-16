import type { DownloadStatus } from "@shared/domain";

const qbStateMap: Record<string, DownloadStatus> = {
  metaDL: "fetching_metadata",
  forcedMetaDL: "fetching_metadata",
  downloading: "downloading",
  forcedDL: "downloading",
  stalledDL: "stalled",
  queuedDL: "queued",
  pausedDL: "paused",
  stoppedDL: "paused",
  checkingDL: "checking",
  checkingUP: "checking",
  checkingResumeData: "checking",
  moving: "moving",
  uploading: "seeding",
  forcedUP: "seeding",
  stalledUP: "seeding",
  queuedUP: "completed",
  pausedUP: "completed",
  stoppedUP: "completed",
  missingFiles: "missing_files",
  error: "error",
  unknown: "error"
};

export function mapQbittorrentState(state?: string): DownloadStatus {
  if (!state) {
    return "queued";
  }

  return qbStateMap[state] ?? "queued";
}

export interface TorrentProgressSnapshot {
  status: DownloadStatus;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  etaSeconds?: number;
}

export function normalizeProgressSnapshot(snapshot: TorrentProgressSnapshot): TorrentProgressSnapshot {
  return {
    ...snapshot,
    progress: Math.min(1, Math.max(0, snapshot.progress)),
    downloadSpeed: Math.max(0, snapshot.downloadSpeed),
    uploadSpeed: Math.max(0, snapshot.uploadSpeed),
    etaSeconds: snapshot.etaSeconds && snapshot.etaSeconds > 0 ? snapshot.etaSeconds : undefined
  };
}
