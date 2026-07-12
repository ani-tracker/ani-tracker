import type { AddTorrentOptions, TorrentEngine } from "@shared/contracts";
import type { DownloadTask, TorrentFile } from "@shared/domain";

export class EmbeddedTorrentEngine implements TorrentEngine {
  private readonly tasks = new Map<string, DownloadTask>();

  async addMagnet(magnetUrl: string, options: AddTorrentOptions): Promise<DownloadTask> {
    return this.createPlaceholderTask(magnetUrl, options);
  }

  async addTorrentFile(filePath: string, options: AddTorrentOptions): Promise<DownloadTask> {
    return this.createPlaceholderTask(filePath, options);
  }

  async listTasks(): Promise<DownloadTask[]> {
    return [...this.tasks.values()];
  }

  async getTask(taskId: string): Promise<DownloadTask> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Embedded torrent task not found: ${taskId}`);
    }

    return task;
  }

  async getFiles(taskId: string): Promise<TorrentFile[]> {
    return (await this.getTask(taskId)).files;
  }

  async setFilePriority(taskId: string, fileIndexes: number[], priority: number): Promise<void> {
    const task = await this.getTask(taskId);
    task.files = task.files.map((file) =>
      fileIndexes.includes(file.index)
        ? {
            ...file,
            priority,
            selected: priority > 0
          }
        : file
    );
  }

  async pause(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    task.status = "paused";
  }

  async resume(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    task.status = "downloading";
  }

  async remove(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
  }

  private createPlaceholderTask(input: string, options: AddTorrentOptions): DownloadTask {
    const task: DownloadTask = {
      id: `embedded-${Date.now()}`,
      engine: "embedded",
      name: input,
      status: options.paused ? "paused" : "queued",
      progress: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      savePath: options.savePath,
      files: [],
      createdAt: new Date().toISOString()
    };

    this.tasks.set(task.id, task);
    return task;
  }
}
