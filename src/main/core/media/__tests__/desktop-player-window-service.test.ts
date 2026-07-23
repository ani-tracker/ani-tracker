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
  on(event: string, listener: () => void): void { this.addListener(event, listener); }
  isDestroyed(): boolean { return this.destroyed; }
  show(): void { this.shown = true; }
  focus(): void { this.focused = true; this.emit("focus"); }
  close(): void {
    if (this.destroyed) return;
    this.closed = true;
    this.destroyed = true;
    this.emit("closed");
  }
  destroy(): void { this.close(); }
  minimize(): void { this.minimized = true; this.emit("minimize"); }
  restore(): void { this.minimized = false; this.emit("restore"); }
  isMinimized(): boolean { return this.minimized; }
  maximize(): void { this.maximized = true; this.emit("maximize"); }
  unmaximize(): void { this.maximized = false; this.emit("unmaximize"); }
  isMaximized(): boolean { return this.maximized; }
  setFullScreen(fullscreen: boolean): void {
    if (this.fullscreen === fullscreen) return;
    this.fullscreen = fullscreen;
    this.emit(fullscreen ? "enter-full-screen" : "leave-full-screen");
  }
  isFullScreen(): boolean { return this.fullscreen; }
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
  const closedIds: number[] = [];
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
    onWindowClosed: (id) => { closedIds.push(id); },
    platform: "darwin"
  });

  await service.open({ taskId: "task-1", fileIndex: 2 });

  assert.equal(windows.length, 2);
  const [videoWindow, controlWindow] = windows;
  assert.equal(videoWindow.options.frame, false);
  assert.equal(videoWindow.options.backgroundColor, "#000000");
  assert.equal(controlWindow.options.frame, false);
  assert.equal(controlWindow.options.transparent, true);
  assert.equal(controlWindow.options.skipTaskbar, true);
  assert.equal(controlWindow.options.webPreferences?.preload, "/app/preload.mjs");
  assert.match(videoWindow.loadedUrl ?? "", /aniView=desktop-vlc-host/);
  assert.match(controlWindow.loadedUrl ?? "", /aniView=desktop-player/);
  assert.match(controlWindow.loadedUrl ?? "", /taskId=task-1/);
  assert.match(controlWindow.loadedUrl ?? "", /fileIndex=2/);
  assert.deepEqual(preparedIds, [11]);
  assert.equal(videoWindow.shown, true);
  assert.equal(controlWindow.shown, true);
  assert.equal(controlWindow.focused, true);

  controlWindow.bounds = { x: 240, y: 160, width: 960, height: 540 };
  controlWindow.emit("move");
  assert.deepEqual(videoWindow.bounds, controlWindow.bounds);

  assert.equal(service.setFullscreen(11, true), true);
  assert.equal(videoWindow.fullscreen, true);
  assert.equal(controlWindow.fullscreen, true);

  assert.equal(service.close(11), true);
  assert.equal(videoWindow.closed, true);
  assert.equal(controlWindow.closed, true);
  assert.deepEqual(closedIds, [11]);
  assert.equal(service.close(11), false);
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
