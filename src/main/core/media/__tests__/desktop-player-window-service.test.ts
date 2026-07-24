import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { BrowserWindowConstructorOptions, Rectangle } from "electron";
import {
  DesktopPlayerWindowService,
  type DesktopPlayerBrowserWindow
} from "../desktop-player-window-service";

class FakePlayerWindow implements DesktopPlayerBrowserWindow {
  readonly webContents;
  loadedUrl?: string;
  loadedFile?: { filePath: string; query?: Record<string, string> };
  shown = false;
  focused = false;
  destroyed = false;
  closed = false;
  minimized = false;
  maximized = false;
  fullscreen = false;
  simpleFullscreen = false;
  readonly fullscreenCalls: boolean[] = [];
  readonly simpleFullscreenCalls: boolean[] = [];
  bounds: Rectangle;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(readonly options: BrowserWindowConstructorOptions, id: number) {
    this.bounds = {
      x: options.x ?? 100,
      y: options.y ?? 80,
      width: options.width ?? 800,
      height: options.height ?? 600
    };
    this.webContents = {
      id,
      on: (event: string, listener: (...args: unknown[]) => void) => this.addListener(`web:${event}`, listener)
    };
  }

  async loadURL(url: string): Promise<void> { this.loadedUrl = url; }
  async loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void> {
    this.loadedFile = { filePath, query: options?.query };
  }
  on(event: "close", listener: (event: { preventDefault(): void }) => void): void;
  on(event: string, listener: () => void): void;
  on(
    event: string,
    listener: ((event: { preventDefault(): void }) => void) | (() => void)
  ): void {
    this.addListener(event, listener as (...args: unknown[]) => void);
  }
  isDestroyed(): boolean { return this.destroyed; }
  show(): void { this.shown = true; }
  focus(): void { this.focused = true; this.emit("focus"); }
  close(): void {
    if (this.destroyed) return;
    let prevented = false;
    this.emit("close", { preventDefault: () => { prevented = true; } });
    if (prevented) return;
    this.closed = true;
    this.destroyed = true;
    this.emit("closed");
  }
  destroy(): void {
    if (this.destroyed) return;
    this.closed = true;
    this.destroyed = true;
    this.emit("closed");
  }
  minimize(): void { this.minimized = true; this.emit("minimize"); }
  restore(): void { this.minimized = false; this.emit("restore"); }
  isMinimized(): boolean { return this.minimized; }
  maximize(): void { this.maximized = true; this.emit("maximize"); }
  unmaximize(): void { this.maximized = false; this.emit("unmaximize"); }
  isMaximized(): boolean { return this.maximized; }
  setFullScreen(fullscreen: boolean): void {
    this.fullscreenCalls.push(fullscreen);
    if (this.fullscreen === fullscreen) return;
    this.fullscreen = fullscreen;
    this.emit(fullscreen ? "enter-full-screen" : "leave-full-screen");
  }
  isFullScreen(): boolean { return this.fullscreen; }
  setSimpleFullScreen(fullscreen: boolean): void {
    this.simpleFullscreenCalls.push(fullscreen);
    this.simpleFullscreen = fullscreen;
  }
  isSimpleFullScreen(): boolean { return this.simpleFullscreen; }
  getBounds(): Rectangle { return { ...this.bounds }; }
  setBounds(bounds: Rectangle): void { this.bounds = { ...bounds }; this.emit("move"); this.emit("resize"); }
  setMenuBarVisibility(): void {}
  removeMenu(): void {}

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  private addListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
}

test("DesktopPlayerWindowService 创建无边框视频宿主和透明控制层", async () => {
  const windows: FakePlayerWindow[] = [];
  const preparedIds: number[] = [];
  const closingIds: number[] = [];
  const fullscreenChanges: boolean[] = [];
  const service = new DesktopPlayerWindowService({
    createWindow: (options) => {
      const playerWindow = new FakePlayerWindow(options, windows.length + 10);
      windows.push(playerWindow);
      return playerWindow;
    },
    preloadPath: "/app/preload.mjs",
    rendererFilePath: "/app/index.html",
    rendererUrl: "http://localhost:5173/",
    prepareVideoHost: (ownerId) => { preparedIds.push(ownerId); },
    onFullscreenChanged: (_id, fullscreen) => { fullscreenChanges.push(fullscreen); },
    onWindowClosing: (id) => {
      assert.equal(windows.some((window) => window.destroyed), false);
      assert.equal(windows[0].simpleFullscreen, false);
      closingIds.push(id);
    },
    platform: "darwin",
    fullscreenSettleDelayMs: 0
  });

  await service.open({ taskId: "task-1", fileIndex: 2 });

  assert.equal(windows.length, 2);
  const [videoWindow, controlWindow] = windows;
  assert.equal(videoWindow.options.frame, false);
  assert.equal(videoWindow.options.backgroundColor, "#000000");
  assert.equal(controlWindow.options.frame, false);
  assert.equal(controlWindow.options.transparent, true);
  assert.equal(controlWindow.options.skipTaskbar, true);
  assert.equal(controlWindow.options.parent, videoWindow);
  assert.equal(controlWindow.options.movable, false);
  assert.equal(controlWindow.options.webPreferences?.preload, "/app/preload.mjs");
  assert.match(videoWindow.loadedUrl ?? "", /aniView=desktop-vlc-host/);
  assert.match(controlWindow.loadedUrl ?? "", /aniView=desktop-player/);
  assert.match(controlWindow.loadedUrl ?? "", /taskId=task-1/);
  assert.match(controlWindow.loadedUrl ?? "", /fileIndex=2/);
  assert.deepEqual(preparedIds, [11]);
  assert.equal(videoWindow.shown, true);
  assert.equal(controlWindow.shown, true);
  assert.equal(controlWindow.focused, true);

  const initialVideoBounds = videoWindow.getBounds();
  controlWindow.bounds = { ...controlWindow.bounds, x: 240, y: 160 };
  controlWindow.emit("move");
  assert.deepEqual(videoWindow.bounds, initialVideoBounds);
  controlWindow.bounds = { ...initialVideoBounds };

  assert.equal(service.drag(11, { phase: "start", screenX: 320, screenY: 180 }), true);
  assert.equal(service.drag(11, { phase: "move", screenX: 410, screenY: 235 }), true);
  assert.deepEqual(videoWindow.bounds, {
    ...initialVideoBounds,
    x: initialVideoBounds.x + 90,
    y: initialVideoBounds.y + 55
  });
  assert.equal(service.drag(11, { phase: "end" }), true);
  assert.equal(service.drag(11, { phase: "move", screenX: 500, screenY: 300 }), false);
  assert.equal(service.drag(11, { phase: "start", screenX: Number.NaN, screenY: 300 }), false);

  controlWindow.bounds = { ...videoWindow.bounds, x: 160, y: 110, width: 960, height: 540 };
  controlWindow.emit("resize");
  assert.deepEqual(videoWindow.bounds, controlWindow.bounds);
  const windowedBounds = videoWindow.getBounds();

  assert.equal(await service.setFullscreen(11, true), true);
  assert.deepEqual(videoWindow.simpleFullscreenCalls, [true]);
  assert.deepEqual(videoWindow.fullscreenCalls, []);
  assert.deepEqual(controlWindow.simpleFullscreenCalls, []);
  assert.deepEqual(controlWindow.fullscreenCalls, []);
  videoWindow.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  videoWindow.emit("resize");
  assert.deepEqual(controlWindow.bounds, videoWindow.bounds);

  assert.equal(await service.setFullscreen(11, false), false);
  assert.deepEqual(videoWindow.simpleFullscreenCalls, [true, false]);
  assert.deepEqual(videoWindow.bounds, windowedBounds);
  assert.deepEqual(controlWindow.bounds, windowedBounds);
  assert.deepEqual(fullscreenChanges, [true, false]);

  assert.equal(await service.setFullscreen(11, true), true);
  assert.equal(await service.close(11), true);
  assert.deepEqual(videoWindow.simpleFullscreenCalls, [true, false, true, false]);
  assert.equal(videoWindow.closed, true);
  assert.equal(controlWindow.closed, true);
  assert.deepEqual(closingIds, [11]);
  assert.equal(await service.close(11), false);
});

test("DesktopPlayerWindowService Windows 仅让视频宿主进入系统全屏", async () => {
  const windows: FakePlayerWindow[] = [];
  const fullscreenChanges: boolean[] = [];
  const service = new DesktopPlayerWindowService({
    createWindow: (options) => {
      const playerWindow = new FakePlayerWindow(options, windows.length + 20);
      windows.push(playerWindow);
      return playerWindow;
    },
    preloadPath: "/app/preload.mjs",
    rendererFilePath: "/app/index.html",
    rendererUrl: "http://localhost:5173/",
    onFullscreenChanged: (_id, fullscreen) => { fullscreenChanges.push(fullscreen); },
    onWindowClosing: () => {
      assert.equal(windows[0].fullscreen, false);
      assert.equal(windows.some((window) => window.destroyed), false);
    },
    platform: "win32",
    fullscreenSettleDelayMs: 0
  });

  await service.open({ taskId: "task-2" });

  assert.equal(windows[1].options.parent, windows[0]);
  windows[1].bounds = { x: 260, y: 180, width: 900, height: 600 };
  windows[1].emit("move");
  assert.deepEqual(windows[0].bounds, windows[1].bounds);
  const windowedBounds = windows[0].getBounds();

  assert.equal(await service.setFullscreen(21, true), true);
  assert.deepEqual(windows[0].fullscreenCalls, [true]);
  assert.deepEqual(windows[1].fullscreenCalls, []);
  windows[0].bounds = { x: 0, y: 0, width: 2560, height: 1440 };
  windows[0].emit("resize");
  assert.deepEqual(windows[1].bounds, windows[0].bounds);

  assert.equal(await service.setFullscreen(21, false), false);
  assert.deepEqual(windows[0].fullscreenCalls, [true, false]);
  assert.deepEqual(windows[0].bounds, windowedBounds);
  assert.deepEqual(windows[1].bounds, windowedBounds);
  assert.deepEqual(fullscreenChanges, [true, false]);

  const rapidEnter = service.setFullscreen(21, true);
  const rapidExit = service.setFullscreen(21, false);
  assert.deepEqual(await Promise.all([rapidEnter, rapidExit]), [false, false]);
  assert.deepEqual(windows[0].fullscreenCalls, [true, false, true, false]);
  assert.deepEqual(windows[1].fullscreenCalls, []);

  assert.equal(service.drag(21, { phase: "start", screenX: 300, screenY: 200 }), false);
  assert.equal(await service.setFullscreen(21, true), true);
  assert.equal(await service.close(21), true);
  assert.deepEqual(windows[0].fullscreenCalls, [true, false, true, false, true, false]);
});

test("DesktopPlayerWindowService 生产环境分别加载宿主与控制层查询参数", async () => {
  const created: FakePlayerWindow[] = [];
  const serviceWithCapture = new DesktopPlayerWindowService({
    createWindow: (options) => {
      const playerWindow = new FakePlayerWindow(options, 30 + created.length);
      created.push(playerWindow);
      return playerWindow;
    },
    preloadPath: "/app/preload.mjs",
    rendererFilePath: "/app/index.html",
    platform: "linux"
  });
  await serviceWithCapture.open({ taskId: "task-3" });

  assert.deepEqual(created[0].loadedFile, {
    filePath: "/app/index.html",
    query: { aniView: "desktop-vlc-host" }
  });
  assert.deepEqual(created[1].loadedFile, {
    filePath: "/app/index.html",
    query: { aniView: "desktop-player", taskId: "task-3" }
  });
});
