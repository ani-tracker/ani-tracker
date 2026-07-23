import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { BrowserWindowConstructorOptions } from "electron";
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
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(readonly options: BrowserWindowConstructorOptions, id: number) {
    this.webContents = {
      id,
      on: (event: string, listener: (...args: unknown[]) => void) => this.addListener(`web:${event}`, listener)
    };
  }

  async loadURL(url: string): Promise<void> { this.loadedUrl = url; }
  async loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void> {
    this.loadedFile = { filePath, query: options?.query };
  }
  on(event: "closed", listener: () => void): void { this.addListener(event, listener); }
  isDestroyed(): boolean { return this.destroyed; }
  show(): void { this.shown = true; }
  focus(): void { this.focused = true; }
  close(): void { this.closed = true; this.emit("closed"); }
  destroy(): void { this.destroyed = true; this.emit("closed"); }
  setMenuBarVisibility(): void {}
  removeMenu(): void {}

  private addListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

test("DesktopPlayerWindowService 每次请求创建独立窗口并携带播放目标", async () => {
  const windows: FakePlayerWindow[] = [];
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
    getBackgroundColor: () => "#101010",
    onWindowClosed: (id) => { closedIds.push(id); },
    platform: "darwin"
  });

  await service.open({ taskId: "task-1", fileIndex: 2 });
  await service.open({ taskId: "task-2" });

  assert.equal(windows.length, 2);
  assert.equal(windows[0].options.frame, true);
  assert.equal(windows[0].options.show, false);
  assert.equal(windows[0].shown, true);
  assert.equal(windows[0].focused, true);
  assert.match(windows[0].loadedUrl ?? "", /aniView=desktop-player/);
  assert.match(windows[0].loadedUrl ?? "", /taskId=task-1/);
  assert.match(windows[0].loadedUrl ?? "", /fileIndex=2/);

  assert.equal(service.close(10), true);
  assert.equal(windows[0].closed, true);
  assert.deepEqual(closedIds, [10]);
  assert.equal(service.close(10), false);
  assert.equal(windows[1].closed, false);
});

test("DesktopPlayerWindowService 生产环境通过 loadFile 传递查询参数", async () => {
  const playerWindow = new FakePlayerWindow({}, 20);
  const service = new DesktopPlayerWindowService({
    createWindow: () => playerWindow,
    preloadPath: "/app/preload.mjs",
    rendererFilePath: "/app/index.html",
    getBackgroundColor: () => "#ffffff",
    platform: "linux"
  });

  await service.open({ taskId: "task-3" });

  assert.deepEqual(playerWindow.loadedFile, {
    filePath: "/app/index.html",
    query: { aniView: "desktop-player", taskId: "task-3" }
  });
});
