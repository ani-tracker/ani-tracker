import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { PlayerCommand, PlayerSnapshot } from "@shared/player-contract";
import {
  DesktopLibVlcPlayerService,
  resolveDesktopHardwareAcceleration,
  resolveDesktopLibVlcDirectory,
  type DesktopNativeVlcPlayer
} from "../desktop-libvlc-player-service";

class FakeNativePlayer extends EventEmitter implements DesktopNativeVlcPlayer {
  embedded = false;
  destroyed = false;
  layoutRefreshCount = 0;
  source?: string;
  sourceOptions?: { autoplay?: boolean; mediaOptions?: string[] };
  played = false;
  paused = false;
  time = 0;
  length = 120_000;
  volume = 70;
  muted = false;
  rate = 1;
  aspectRatio = "";
  scale = 0;
  audioTrack = 1;
  subtitleTrack = -1;
  audioTracks = [{ id: 1, name: "日语" }, { id: 2, name: "中文" }];
  subtitleTracks = [{ id: -1, name: "Disable" }, { id: 3, name: "内嵌字幕" }];
  subtitleInstallCallCount = 0;
  private pendingSubtitleTracks: Array<{ id: number; name: string }> = [];

  async embed(): Promise<void> { this.embedded = true; }
  notifyLayoutChange(): void { this.layoutRefreshCount += 1; }
  on(eventName: string, listener: Parameters<DesktopNativeVlcPlayer["on"]>[1]): this {
    assert.equal(this.embedded, true, "播放器事件只能在 embed 完成后绑定");
    return super.on(eventName, listener as (...args: unknown[]) => void);
  }
  destroy(): void { this.destroyed = true; }
  setSource(source: string, options?: { autoplay?: boolean; mediaOptions?: string[] }): void {
    this.source = source;
    this.sourceOptions = options;
  }
  play(): void { this.played = true; }
  pause(): void { this.paused = true; }
  setTime(milliseconds: number): void { this.time = milliseconds; }
  getTime(): number { return this.time; }
  getLength(): number { return this.length; }
  setVolume(volume: number): void { this.volume = volume; }
  getVolume(): number { return this.volume; }
  setMute(muted: boolean): void { this.muted = muted; }
  getMute(): boolean { return this.muted; }
  setRate(rate: number): void { this.rate = rate; }
  getRate(): number { return this.rate; }
  getAudioTracks() { return this.audioTracks; }
  getAudioTrack(): number { return this.audioTrack; }
  setAudioTrack(trackId: number): void { this.audioTrack = trackId; }
  getSubtitleTracks() { return this.subtitleTracks; }
  getSubtitleTrack(): number { return this.subtitleTrack; }
  setSubtitleTrack(trackId: number): void { this.subtitleTrack = trackId; }
  addSubtitleFile(): boolean {
    this.subtitleInstallCallCount += 1;
    this.pendingSubtitleTracks.push({ id: 3 + this.subtitleInstallCallCount, name: "外挂字幕" });
    return true;
  }
  /** 模拟 libVLC 延迟暴露刚安装的外挂字幕轨道。 */
  publishPendingSubtitleTracks(): void {
    this.subtitleTracks.push(...this.pendingSubtitleTracks);
    this.pendingSubtitleTracks = [];
    this.emit("subtitleTrackChanged");
  }
  setAspectRatio(ratio: string): void { this.aspectRatio = ratio; }
  setScale(scale: number): void { this.scale = scale; }
}

function createLoadCommand(): Extract<PlayerCommand, { type: "load" }> {
  return {
    type: "load",
    commandId: "command-load",
    sessionId: "session-1",
    startPositionSeconds: 12,
    source: {
      taskId: "task-1",
      fileIndex: 2,
      title: "Episode 02.mkv",
      uri: "ani-media://session/token/session/file",
      mode: "direct",
      durationSeconds: 120,
      subtitles: [{
        id: "subtitle-1",
        label: "简体中文",
        type: "ass",
        uri: "ani-media://session/token/session/subtitles/subtitle-001.ass",
        default: true
      }]
    }
  };
}

test("DesktopLibVlcPlayerService 解析受控路径并发布递增快照", async () => {
  const player = new FakeNativePlayer();
  const snapshots: PlayerSnapshot[] = [];
  const fullscreenValues: boolean[] = [];
  const service = new DesktopLibVlcPlayerService({
    resolveAsset: async (uri) => ({
      filePath: uri.endsWith("/file") ? "C:\\media\\Episode 02.mkv" : "C:\\media\\Episode 02.ass",
      contentType: "application/octet-stream",
      direct: true
    }),
    publishSnapshot: (_ownerId, snapshot) => snapshots.push(snapshot),
    setFullscreen: (_ownerId, fullscreen) => {
      fullscreenValues.push(fullscreen);
      return fullscreen;
    },
    closeWindow: () => true,
    resolveVlcDirectory: () => "C:\\vlc",
    loadModule: async () => ({ VlcPlayer: class { constructor() { return player; } } as never })
  });

  await service.attach(42, {});
  assert.equal(player.embedded, true);
  assert.equal(service.getCapabilities(42).availability, "available");
  assert.equal(service.refreshLayout(42), true);
  assert.equal(player.layoutRefreshCount, 1);

  const loadResult = await service.dispatch(createLoadCommand(), 42);
  assert.deepEqual(loadResult, { commandId: "command-load", accepted: true });
  assert.equal(player.source, "C:\\media\\Episode 02.mkv");
  assert.equal(player.sourceOptions?.autoplay, true);
  assert.equal(snapshots.at(-1)?.status, "loading");
  assert.equal(snapshots.at(-1)?.source?.uri, "ani-media://session/token/session/file");

  player.emit("playing");
  assert.equal(player.time, 12_000);
  assert.equal(player.subtitleInstallCallCount, 1);
  assert.equal(player.subtitleTrack, -1);
  assert.equal(snapshots.at(-1)?.subtitleTracks.length, 1);
  assert.equal(snapshots.at(-1)?.subtitleTracks.some((track) => track.label === "Disable"), false);

  for (let index = 0; index < 10; index += 1) {
    player.emit("paused");
    player.emit("playing");
  }
  assert.equal(player.subtitleInstallCallCount, 1);
  assert.equal(snapshots.at(-1)?.subtitleTracks.length, 1);

  player.publishPendingSubtitleTracks();
  assert.equal(player.subtitleTrack, 4);
  assert.equal(snapshots.at(-1)?.status, "playing");
  assert.equal(snapshots.at(-1)?.audioTracks.length, 2);
  assert.equal(snapshots.at(-1)?.subtitleTracks.length, 2);
  assert.equal(snapshots.at(-1)?.subtitleTracks.some((track) => track.id === "-1"), false);

  for (let index = 0; index < 10; index += 1) {
    player.emit("paused");
    player.emit("playing");
  }
  assert.equal(player.subtitleInstallCallCount, 1);
  assert.equal(snapshots.at(-1)?.subtitleTracks.length, 2);

  player.emit("buffering");
  assert.equal(snapshots.at(-1)?.status, "buffering");
  player.emit("timeChanged", { time: 45_000 });
  assert.equal(snapshots.at(-1)?.status, "playing");
  player.emit("lengthChanged", { length: 150_000 });
  assert.equal(snapshots.at(-1)?.positionSeconds, 45);
  assert.equal(snapshots.at(-1)?.durationSeconds, 150);
  assert.ok(snapshots.every((snapshot, index) => index === 0 || snapshot.sequence > snapshots[index - 1].sequence));

  player.emit("paused");
  player.emit("buffering");
  player.emit("timeChanged", { time: 46_000 });
  assert.equal(snapshots.at(-1)?.status, "paused");

  await service.dispatch({
    type: "set-volume",
    commandId: "command-volume",
    sessionId: "session-1",
    volume: 0.35
  }, 42);
  assert.equal(player.volume, 35);
  await service.dispatch({
    type: "set-fullscreen",
    commandId: "command-fullscreen",
    sessionId: "session-1",
    fullscreen: true
  }, 42);
  assert.deepEqual(fullscreenValues, [true]);
  assert.equal(snapshots.at(-1)?.fullscreen, true);

  await service.dispose(42);
  await service.dispose(42);
  assert.equal(player.destroyed, true);
  assert.equal(service.refreshLayout(42), false);
  const snapshotCount = snapshots.length;
  player.emit("timeChanged", { time: 90_000 });
  assert.equal(snapshots.length, snapshotCount);
});

test("DesktopLibVlcPlayerService 对缺失运行时和过期会话返回结构化错误", async () => {
  const service = new DesktopLibVlcPlayerService({
    resolveAsset: async () => { throw new Error("不应解析资源"); },
    publishSnapshot: () => undefined,
    setFullscreen: () => false,
    closeWindow: () => false,
    resolveVlcDirectory: () => undefined
  });
  await service.attach(7, {});
  assert.equal(service.getCapabilities(7).availability, "unavailable");
  assert.match(service.getCapabilities(7).unavailableReason ?? "", /libVLC/);

  const result = await service.dispatch({
    type: "play",
    commandId: "command-play",
    sessionId: "session-old"
  }, 7);
  assert.equal(result.accepted, false);
  if (!result.accepted) assert.equal(result.error.code, "runtime-missing");
});

test("resolveDesktopLibVlcDirectory 优先使用显式配置、随包资源和开发输出", () => {
  const explicit = resolveDesktopLibVlcDirectory({
    platform: "win32",
    arch: "x64",
    resourcesPath: "C:\\app\\resources",
    appPath: "C:\\source",
    environmentPath: "D:\\VLC",
    pathExists: (path) => path === "D:\\VLC"
  });
  assert.equal(explicit, "D:\\VLC");

  const bundled = resolveDesktopLibVlcDirectory({
    platform: "linux",
    arch: "x64",
    resourcesPath: "/opt/ani/resources",
    appPath: "/source",
    environmentPath: "",
    pathExists: (path) => path.replaceAll("\\", "/") === "/opt/ani/resources/libvlc/linux-x64"
  });
  assert.equal(bundled?.replaceAll("\\", "/"), "/opt/ani/resources/libvlc/linux-x64");

  const development = resolveDesktopLibVlcDirectory({
    platform: "darwin",
    arch: "arm64",
    resourcesPath: "/Applications/Electron.app/Contents/Resources",
    appPath: "/source",
    environmentPath: "",
    pathExists: (path) => path.replaceAll("\\", "/") === "/source/out/libvlc/darwin-arm64"
  });
  assert.equal(development?.replaceAll("\\", "/"), "/source/out/libvlc/darwin-arm64");
});

test("桌面 libVLC 按平台选择硬件解码后端", () => {
  assert.equal(resolveDesktopHardwareAcceleration("win32"), "d3d11va");
  assert.equal(resolveDesktopHardwareAcceleration("darwin"), "videotoolbox");
  assert.equal(resolveDesktopHardwareAcceleration("linux"), "any");
});
