import { EventEmitter } from "node:events";
import type { TorrentEngine } from "@shared/contracts";
import type { DownloadTask } from "@shared/domain";

export interface DownloadMonitorSnapshot {
  tasks: DownloadTask[];
  totalDownloadSpeed: number;
  totalUploadSpeed: number;
  updatedAt: string;
}

export class DownloadMonitorService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private latestSnapshot: DownloadMonitorSnapshot = {
    tasks: [],
    totalDownloadSpeed: 0,
    totalUploadSpeed: 0,
    updatedAt: new Date().toISOString()
  };

  constructor(
    private readonly engine: TorrentEngine,
    private readonly intervalMs = 1000
  ) {
    super();
  }

  start(): void {
    if (this.timer) {
      return;
    }

    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  getLatestSnapshot(): DownloadMonitorSnapshot {
    return this.latestSnapshot;
  }

  async refresh(): Promise<DownloadMonitorSnapshot> {
    const tasks = await this.engine.listTasks();
    const snapshot = createSnapshot(tasks);
    this.latestSnapshot = snapshot;
    this.emit("snapshot", snapshot);
    return snapshot;
  }
}

function createSnapshot(tasks: DownloadTask[]): DownloadMonitorSnapshot {
  return {
    tasks,
    totalDownloadSpeed: tasks.reduce((sum, task) => sum + task.downloadSpeed, 0),
    totalUploadSpeed: tasks.reduce((sum, task) => sum + task.uploadSpeed, 0),
    updatedAt: new Date().toISOString()
  };
}
