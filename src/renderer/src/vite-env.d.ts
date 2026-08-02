/// <reference types="vite/client" />

declare const __ANI_TRACKER_VERSION__: string;

interface ImportMetaEnv {
  readonly TAURI_ENV_PLATFORM?: string;
  readonly VITE_ANI_REMOTE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
