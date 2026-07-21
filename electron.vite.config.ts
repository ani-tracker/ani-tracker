import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin, loadEnv } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const trustedOrigins = process.env.ANI_TRUSTED_ORIGINS ?? fileEnv.ANI_TRUSTED_ORIGINS ?? "";

  return {
    main: {
      define: {
        __ANI_TRUSTED_ORIGINS__: JSON.stringify(trustedOrigins)
      },
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          "@shared": resolve("src/shared")
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          "@shared": resolve("src/shared")
        }
      }
    },
    renderer: {
      resolve: {
        alias: {
          "@": resolve("src/renderer/src"),
          "@shared": resolve("src/shared")
        }
      },
      plugins: [react()]
    }
  };
});
