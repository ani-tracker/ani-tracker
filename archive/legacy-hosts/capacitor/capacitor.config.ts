import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.ani.tracker",
  appName: "Ani Tracker",
  webDir: "out/mobile",
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false
  },
  server: {
    androidScheme: "https"
  }
};

export default config;
