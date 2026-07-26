import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rendererBoundaryPlugin } from "./vite.renderer-boundaries";

/** 独立构建桌面 Rust 网关托管的远程 PWA。 */
export default defineConfig({
  root: resolve("src/renderer"),
  publicDir: resolve("src/renderer/public"),
  base: "./",
  resolve: {
    alias: [
      { find: /^@\/renderer-app$/, replacement: resolve("src/renderer/src/RemoteApp.tsx") },
      { find: /^@\/lib\/api$/, replacement: resolve("src/renderer/src/lib/remote-api.ts") },
      { find: "@", replacement: resolve("src/renderer/src") },
      { find: "@shared", replacement: resolve("src/shared") }
    ]
  },
  plugins: [react(), rendererBoundaryPlugin("remote")],
  build: {
    outDir: resolve(".tauri-remote-pwa"),
    emptyOutDir: true
  }
});
