import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** 构建仅供 Android WebView 使用的 Renderer，不包含 Electron Main 或远程 PWA 入口。 */
export default defineConfig({
  root: resolve("src/renderer/mobile"),
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
    outDir: resolve("out/mobile"),
    emptyOutDir: true
  }
});
