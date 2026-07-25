import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** 独立构建桌面 Rust 网关托管的远程 PWA，不产生 Electron 主进程产物。 */
export default defineConfig({
  root: resolve("src/renderer"),
  publicDir: resolve("src/renderer/public"),
  base: "./",
  resolve: {
    alias: {
      "@": resolve("src/renderer/src"),
      "@shared": resolve("src/shared")
    }
  },
  plugins: [react()],
  build: {
    outDir: resolve(".tauri-remote-pwa"),
    emptyOutDir: true
  }
});
