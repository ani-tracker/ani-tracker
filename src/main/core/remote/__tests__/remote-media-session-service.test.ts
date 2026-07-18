import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { AppSettings, DownloadTask, MediaFile } from "@shared/domain";
import {
  RemoteMediaSessionError,
  RemoteMediaSessionService,
  type RemoteMediaRepository
} from "../remote-media-session-service";
import type { RemoteSubtitlePreparationResult } from "../remote-subtitle-service";

test("RemoteMediaSessionService 为浏览器兼容文件创建直传会话", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-media-test-"));
  const filePath = join(directory, "episode.mp4");
  await writeFile(filePath, Buffer.from("0123456789"));
  const service = createService(
    createRepository(createTask(directory, "episode.mp4"), []),
    async (_sourcePath, outputDirectory) => {
      await writeFile(join(outputDirectory, "subtitle-000.ass"), "[Events]\n", "utf8");
      return {
        subtitles: [{
          assetName: "subtitle-000.ass",
          id: "subtitle-2",
          label: "简体中文",
          language: "简体中文",
          type: "ass",
          default: true
        }],
        detectedCount: 1,
        unsupportedCount: 0,
        failedCount: 0
      };
    }
  );
  context.after(async () => {
    await service.stopAll();
    await rm(directory, { recursive: true, force: true });
  });

  const session = await service.createSession("task-1", "device-1", "direct");
  const asset = await service.getAsset(session.id, "device-1", "file");
  const subtitleAsset = await service.getAsset(session.id, "device-1", "subtitle-000.ass");

  assert.equal(session.mode, "direct");
  assert.equal(session.durationSeconds, 1_445);
  assert.deepEqual(session.subtitles, [{
    id: "subtitle-2",
    label: "简体中文",
    language: "简体中文",
    type: "ass",
    url: `/api/media/sessions/${session.id}/subtitles/subtitle-000.ass`,
    default: true
  }]);
  assert.equal(session.streamUrl, `/api/media/sessions/${session.id}/file`);
  assert.equal(asset.filePath, filePath);
  assert.equal(asset.contentType, "video/mp4");
  assert.equal(subtitleAsset.contentType, "text/x-ssa; charset=utf-8");
  await assert.rejects(
    service.getAsset(session.id, "device-2", "file"),
    (error) => isMediaError(error, "MEDIA_SESSION_NOT_FOUND", 404)
  );
});

test("RemoteMediaSessionService 按实时转码模式为 MP4 启动 FFmpeg HLS", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-media-test-"));
  const filePath = join(directory, "episode.mp4");
  await writeFile(filePath, Buffer.from("mp4-test"));
  let command = "";
  let argumentsList: readonly string[] = [];
  const spawnProcess = ((inputCommand: string, args: readonly string[]) => {
    command = inputCommand;
    argumentsList = args;
    const child = createFakeChildProcess();
    const playlistPath = args.at(-1);
    if (playlistPath) {
      void writeFile(playlistPath, "#EXTM3U\n", "utf8");
    }
    return child;
  }) as typeof spawn;
  const service = new RemoteMediaSessionService(
    createRepository(createTask(directory, "episode.mp4"), []),
    {
      spawnProcess,
      temporaryDirectory: directory,
      platform: "win32",
      bundledFfmpegPath: null,
      durationProbe: async () => 1_445,
      subtitlePreparer: emptySubtitlePreparer,
      logger: silentLogger
    }
  );
  context.after(async () => {
    await service.stopAll();
    await rm(directory, { recursive: true, force: true });
  });

  const session = await service.createSession("task-1", "device-1", "transcode");
  const playlist = await service.getAsset(session.id, "device-1", "index.m3u8");

  assert.equal(session.mode, "hls");
  assert.equal(command, "ffmpeg.exe");
  assert.ok(argumentsList.includes("libx264"));
  assert.equal(playlist.contentType, "application/vnd.apple.mpegurl");
});

test("RemoteMediaSessionService 按不转码模式直传 MKV 原文件", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-media-test-"));
  const filePath = join(directory, "episode.mkv");
  await writeFile(filePath, Buffer.from("mkv-test"));
  const service = createService(createRepository(createTask(directory, "episode.mkv"), []));
  context.after(async () => {
    await service.stopAll();
    await rm(directory, { recursive: true, force: true });
  });

  const session = await service.createSession("task-1", "device-1", "direct");
  const asset = await service.getAsset(session.id, "device-1", "file");

  assert.equal(session.mode, "direct");
  assert.equal(asset.contentType, "video/x-matroska");
});

test("RemoteMediaSessionService 拒绝下载目录之外的登记媒体", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-media-test-"));
  const outsideDirectory = await mkdtemp(join(tmpdir(), "ani-remote-media-outside-"));
  const outsidePath = join(outsideDirectory, "episode.mp4");
  await writeFile(outsidePath, Buffer.from("outside"));
  const task = { ...createTask(directory, "missing.mp4"), files: [] };
  const media: MediaFile = {
    id: "media-1",
    animeId: "anime-1",
    downloadTaskId: task.id,
    filePath: outsidePath,
    fileName: "episode.mp4",
    size: 7,
    normalizedVideoCodec: "H.264/AVC",
    audioCodecs: [],
    subtitleTracks: []
  };
  const service = createService(createRepository(task, [media]));
  context.after(async () => {
    await service.stopAll();
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outsideDirectory, { recursive: true, force: true })
    ]);
  });

  await assert.rejects(
    service.createSession(task.id, "device-1", "direct"),
    (error) => isMediaError(error, "MEDIA_FILE_UNAVAILABLE", 409)
  );
});

const silentLogger = {
  info: () => undefined,
  warn: () => undefined
};

/** 创建只覆盖媒体播放所需方法的仓库。 */
function createRepository(task: DownloadTask, mediaFiles: MediaFile[]): RemoteMediaRepository {
  return {
    getDownloadTask: async (taskId) => taskId === task.id ? task : undefined,
    listMediaFiles: async () => mediaFiles,
    getSettings: async () => ({
      media: {
        ffprobePath: "ffprobe",
        ffprobeTimeoutSeconds: 20,
        videoExtensions: [".mkv", ".mp4", ".webm"]
      }
    } as AppSettings)
  };
}

/** 创建已完整写入单个视频文件的下载任务。 */
function createTask(directory: string, fileName: string): DownloadTask {
  return {
    id: "task-1",
    animeId: "anime-1",
    episodeId: "episode-1",
    engine: "qbittorrent",
    name: fileName,
    status: "downloading",
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath: directory,
    files: [{
      id: "file-1",
      index: 0,
      name: fileName,
      size: 10,
      progress: 1,
      priority: 1,
      selected: true
    }],
    createdAt: "2026-07-18T00:00:00.000Z"
  };
}

/** 创建满足媒体服务监听和终止需求的轻量子进程替身。 */
function createFakeChildProcess(): ChildProcessWithoutNullStreams {
  const events = new EventEmitter();
  const child = events as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    killed: false,
    kill() {
      this.killed = true;
      events.emit("close", 0);
      return true;
    }
  });
  return child;
}

/** 判断媒体协议错误类型、编码和状态码。 */
function isMediaError(error: unknown, code: string, statusCode: number): boolean {
  return error instanceof RemoteMediaSessionError && error.code === code && error.statusCode === statusCode;
}

/** 创建关闭日志的媒体服务。 */
function createService(
  repository: RemoteMediaRepository,
  subtitlePreparer: NonNullable<ConstructorParameters<typeof RemoteMediaSessionService>[1]>["subtitlePreparer"]
    = emptySubtitlePreparer
): RemoteMediaSessionService {
  return new RemoteMediaSessionService(repository, {
    durationProbe: async () => 1_445,
    subtitlePreparer,
    logger: silentLogger
  });
}

/** 返回无字幕轨道的稳定测试结果。 */
async function emptySubtitlePreparer(): Promise<RemoteSubtitlePreparationResult> {
  return { subtitles: [], detectedCount: 0, unsupportedCount: 0, failedCount: 0 };
}
