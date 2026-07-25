import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const tauriDevHost = process.env.TAURI_DEV_HOST;

/** 构建供 Tauri WebView 使用的 Renderer，并与 Electron 产物隔离。 */
export default defineConfig({
  root: resolve("src/renderer"),
  publicDir: resolve("src/renderer/public"),
  base: "./",
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  resolve: {
    alias: {
      "@": resolve("src/renderer/src"),
      "@shared": resolve("src/shared")
    }
  },
  plugins: [react()],
  server: {
    host: tauriDevHost || "127.0.0.1",
    port: 1420,
    strictPort: true,
    hmr: tauriDevHost
      ? {
          protocol: "ws",
          host: tauriDevHost,
          port: 1421
        }
      : undefined
  },
  build: {
    outDir: resolve("out/tauri"),
    emptyOutDir: true
  }
});
