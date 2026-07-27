import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rendererBoundaryPlugin } from "./vite.renderer-boundaries";

const tauriDevHost = process.env.TAURI_DEV_HOST;

/** 构建供 Tauri WebView 使用的主 Renderer。 */
export default defineConfig({
  root: resolve("src/renderer"),
  publicDir: resolve("src/renderer/public"),
  base: "./",
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  resolve: {
    alias: [
      { find: /^@\/renderer-app$/, replacement: resolve("src/renderer/src/App.tsx") },
      { find: /^@\/lib\/api$/, replacement: resolve("src/renderer/src/lib/local-api.ts") },
      { find: "@", replacement: resolve("src/renderer/src") },
      { find: "@shared", replacement: resolve("src/shared") }
    ]
  },
  plugins: [react(), rendererBoundaryPlugin("local")],
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
