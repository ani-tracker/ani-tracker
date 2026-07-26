import type { Plugin } from "vite";

type RendererKind = "local" | "remote";

const LOCAL_FORBIDDEN_MODULES = [
  { label: "远程页面", pattern: /\/src\/renderer\/src\/features\/remote\// },
  { label: "远程 HTTP 客户端", pattern: /\/src\/renderer\/src\/lib\/(?:clients\/remote-client|remote-api)\.ts$/ },
  { label: "ArtPlayer", pattern: /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?artplayer\// },
  { label: "HLS.js", pattern: /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?hls\.js\// }
] as const;

const REMOTE_REQUIRED_MODULES = [
  { label: "远程应用入口", pattern: /\/src\/renderer\/src\/RemoteApp\.tsx$/ },
  { label: "远程配对页", pattern: /\/src\/renderer\/src\/features\/remote\/RemotePairingPage\.tsx$/ },
  { label: "远程播放器", pattern: /\/src\/renderer\/src\/features\/remote\/RemoteVideoPlayer\.tsx$/ },
  { label: "远程 HTTP 客户端", pattern: /\/src\/renderer\/src\/lib\/clients\/remote-client\.ts$/ },
  { label: "ArtPlayer", pattern: /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?artplayer\// },
  { label: "HLS.js", pattern: /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?hls\.js\// }
] as const;

/** 在 Rollup 模块图阶段校验本地应用与远程 PWA 的物理边界。 */
export function rendererBoundaryPlugin(renderer: RendererKind): Plugin {
  return {
    name: `ani-renderer-boundary-${renderer}`,
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle)
        .flatMap((entry) => entry.type === "chunk" ? Object.keys(entry.modules) : [])
        .map((id) => id.replaceAll("\\", "/"));
      if (renderer === "local") {
        const violation = LOCAL_FORBIDDEN_MODULES.find(({ pattern }) => modules.some((id) => pattern.test(id)));
        if (violation) {
          const moduleId = modules.find((id) => violation.pattern.test(id));
          this.error(`[renderer-boundary] 本地 Tauri Renderer 引入了${violation.label}：${moduleId}`);
        }
      } else {
        const missing = REMOTE_REQUIRED_MODULES.filter(({ pattern }) => !modules.some((id) => pattern.test(id)));
        if (missing.length > 0) {
          this.error(`[renderer-boundary] 远程 PWA 缺少必要模块：${missing.map((item) => item.label).join("、")}`);
        }
      }

      this.emitFile({
        type: "asset",
        fileName: "ani-renderer-boundary.json",
        source: `${JSON.stringify({
          schemaVersion: 1,
          renderer,
          verifiedModuleCount: modules.length
        }, null, 2)}\n`
      });
    }
  };
}
